import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  bucketMaxFor,
  buildHistogram,
  CONVERSATION_SAMPLE_MAX_CHARS,
  type PromptStats,
} from './prompt-stats.js'

/**
 * The backend's `promptStats` schema, transcribed from the hacklab repo
 * (`apps/web/app/(app)/api/claim/sync/route.ts`). The CLI and the server live
 * in separate repos, so nothing but a test like this catches a drift between
 * what we upload and what the endpoint accepts — and the failure mode is
 * silent: an invalid block 400s the whole sync, taking the token upload with
 * it.
 *
 * If this file has to change, the server changed. Check the contract in
 * hacklab's `docs/prompt-stats.md` before loosening anything here.
 */
const serverPromptStatsSchema = z.object({
  totalPrompts: z.number().int().nonnegative(),
  bucketMax: z.number().int().min(10).max(100),
  histogram: z
    .array(
      z.object({
        length: z.number().int().positive(),
        count: z.number().int().positive(),
      })
    )
    .max(200),
  projects: z
    .array(
      z.object({
        repoUrl: z.string().min(1).max(500),
        promptCount: z.number().int().positive(),
        lastActiveAt: z.iso.datetime(),
      })
    )
    .max(200),
  conversationSample: z.string().max(CONVERSATION_SAMPLE_MAX_CHARS).optional(),
})

function statsFrom(
  wordCounts: number[],
  overrides: Partial<PromptStats> = {}
): PromptStats {
  const bucketMax = bucketMaxFor(wordCounts)
  return {
    totalPrompts: wordCounts.length,
    bucketMax,
    histogram: buildHistogram(wordCounts, bucketMax),
    projects: [],
    ...overrides,
  }
}

describe('promptStats payload matches the server schema', () => {
  it('accepts a typical scan', () => {
    const stats = statsFrom([1, 2, 2, 8, 40, 120], {
      projects: [
        {
          repoUrl: 'git@github.com:hacklabubu/cli.git',
          promptCount: 26,
          lastActiveAt: new Date().toISOString(),
        },
      ],
      conversationSample: 'fix the auth bug',
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('accepts a terse user (bucketMax floors at the schema minimum)', () => {
    const stats = statsFrom([1, 1, 2])
    expect(stats.bucketMax).toBe(10)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('accepts a verbose user (bucketMax caps at the schema maximum)', () => {
    const stats = statsFrom(Array.from({ length: 50 }, () => 4_000))
    expect(stats.bucketMax).toBe(100)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('never emits a zero-count bucket, which the server rejects', () => {
    const stats = statsFrom([0, 0, 5])
    expect(stats.histogram.every((b) => b.count > 0)).toBe(true)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('stays under the histogram entry cap even at the widest axis', () => {
    // bucketMax maxes out at 100, so there can never be more than 100 buckets.
    const stats = statsFrom(Array.from({ length: 400 }, (_, i) => (i % 200) + 1))
    expect(stats.histogram.length).toBeLessThanOrEqual(200)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('emits an ISO timestamp the server will parse', () => {
    const stats = statsFrom([3], {
      projects: [
        {
          repoUrl: 'https://github.com/hacklabubu/hacklab',
          promptCount: 1,
          lastActiveAt: new Date(0).toISOString(),
        },
      ],
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('truncates the sample to the server cap', () => {
    const stats = statsFrom([3], {
      conversationSample: 'x'.repeat(CONVERSATION_SAMPLE_MAX_CHARS + 500).slice(
        0,
        CONVERSATION_SAMPLE_MAX_CHARS
      ),
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('rejects an over-long sample, proving the cap is load-bearing', () => {
    const stats = statsFrom([3], {
      conversationSample: 'x'.repeat(CONVERSATION_SAMPLE_MAX_CHARS + 1),
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(false)
  })
})
