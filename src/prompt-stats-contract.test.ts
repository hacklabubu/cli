import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  bucketMaxFor,
  buildHistogram,
  buildTail,
  CONVERSATION_SAMPLE_MAX_CHARS,
  emptyPromptActivity,
  PROMPT_TAIL_MAX_ENTRIES,
  type PromptStats,
  promptStatsPayload,
} from './prompt-stats.js'
import {
  emptyState,
  markUploaded,
  tickPayload,
} from './scanners/incremental.js'
import {
  PROMPT_ACTIVITY_DATE_CAP,
  PROMPT_ACTIVITY_SESSION_CAP,
} from './scanners/util.js'

/**
 * The backend's schemas for the two conversation-derived blocks of
 * `/api/claim/sync`, transcribed from the hacklab repo
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
  // The exact distribution behind the histogram's overflow bar. Optional: a
  // scan with nothing past `bucketMax` omits it rather than sending `[]`.
  tail: z
    .array(
      z.object({
        length: z.number().int().positive(),
        count: z.number().int().min(1),
      })
    )
    .max(PROMPT_TAIL_MAX_ENTRIES)
    .optional(),
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

/**
 * `promptActivity`: the continuously-synced metadata block. Upserted per
 * (machine, sessionId) and (machine, date) with GREATEST semantics, so a
 * resend after a failed POST is safe by construction.
 */
const serverPromptActivitySchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1).max(128),
        startedAt: z.iso.datetime(),
        lastActiveAt: z.iso.datetime(),
        promptCount: z.number().int().min(1),
      })
    )
    .max(PROMPT_ACTIVITY_SESSION_CAP),
  dailyPrompts: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        prompts: z.number().int().nonnegative(),
        words: z.number().int().nonnegative(),
      })
    )
    .max(PROMPT_ACTIVITY_DATE_CAP),
})

function statsFrom(
  wordCounts: number[],
  overrides: Partial<PromptStats> = {}
): PromptStats {
  const bucketMax = bucketMaxFor(wordCounts)
  const tail = buildTail(wordCounts, bucketMax)
  return promptStatsPayload({
    totalPrompts: wordCounts.length,
    bucketMax,
    histogram: buildHistogram(wordCounts, bucketMax),
    // Assembled the way `scanPromptStats` does: the key is absent, not
    // undefined, when there is no tail.
    ...(tail ? { tail } : {}),
    projects: [],
    activity: emptyPromptActivity(),
    ...overrides,
  }) as PromptStats
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

  it('never puts the local activity aggregate on the wire', () => {
    // `activity` is bookkeeping for the tick's incremental state; it travels
    // under its own top-level field, not inside promptStats.
    const stats = statsFrom([3])
    expect('activity' in stats).toBe(false)
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
    const stats = statsFrom(
      Array.from({ length: 400 }, (_, i) => (i % 200) + 1)
    )
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
      conversationSample: 'x'
        .repeat(CONVERSATION_SAMPLE_MAX_CHARS + 500)
        .slice(0, CONVERSATION_SAMPLE_MAX_CHARS),
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('rejects an over-long sample, proving the cap is load-bearing', () => {
    const stats = statsFrom([3], {
      conversationSample: 'x'.repeat(CONVERSATION_SAMPLE_MAX_CHARS + 1),
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(false)
  })

  it('carries the tail when prompts run past bucketMax', () => {
    const stats = statsFrom([...Array.from({ length: 38 }, () => 5), 40, 120])
    expect(stats.bucketMax).toBe(10)
    expect(stats.tail).toEqual([
      { length: 40, count: 1 },
      { length: 120, count: 1 },
    ])
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('omits the tail entirely when nothing runs past bucketMax', () => {
    // Absent, not `[]`: the server field is optional, and an empty array would
    // assert an overflow bar that the histogram does not have.
    const stats = statsFrom([1, 2, 3])
    expect('tail' in stats).toBe(false)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('coarsens a very wide tail down to the server entry cap', () => {
    // A long-lived machine easily has thousands of distinct long prompt
    // lengths; unrounded that is an instant 400 on the whole sync.
    const counts = [
      ...Array.from({ length: 200 }, () => 5),
      ...Array.from({ length: 3_000 }, (_, i) => 101 + i),
    ]
    const stats = statsFrom(counts)

    expect(stats.bucketMax).toBe(100)
    expect(stats.tail?.length).toBeLessThanOrEqual(PROMPT_TAIL_MAX_ENTRIES)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('rejects an over-cap tail, proving the coarsening is load-bearing', () => {
    const stats = statsFrom([3], {
      tail: Array.from({ length: PROMPT_TAIL_MAX_ENTRIES + 1 }, (_, i) => ({
        length: 11 + i,
        count: 1,
      })),
    })
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(false)
  })

  it('sorts the tail ascending, coarsened or not', () => {
    const narrow = statsFrom([1, 2, 900, 12, 300])
    const wide = statsFrom(Array.from({ length: 3_000 }, (_, i) => 101 + i))

    for (const stats of [narrow, wide]) {
      const lengths = (stats.tail ?? []).map((e) => e.length)
      expect(lengths.length).toBeGreaterThan(0)
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
      expect(lengths.every((length) => length > stats.bucketMax)).toBe(true)
    }
  })

  it('never emits a zero-count tail entry, which the server rejects', () => {
    const stats = statsFrom([0, ...Array.from({ length: 38 }, () => 5), 44, 44])
    expect(stats.tail?.every((e) => e.count > 0)).toBe(true)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('adds up to the histogram overflow bucket the server can check against', () => {
    // The overflow bar holds everything `>= bucketMax`, the tail everything
    // `> bucketMax`, so the two agree exactly when no prompt is bucketMax words
    // long — as here, where bucketMax is 10 and nothing is 10 words.
    const counts = [...Array.from({ length: 38 }, () => 5), 11, 11, 40, 120]
    const stats = statsFrom(counts)
    const overflow = stats.histogram.find((b) => b.length === stats.bucketMax)
    const tailTotal = (stats.tail ?? []).reduce((sum, e) => sum + e.count, 0)

    expect(counts.filter((c) => c === stats.bucketMax)).toEqual([])
    expect(tailTotal).toBe(overflow?.count)
  })

  it('leaves prompts of exactly bucketMax words to the overflow bar alone', () => {
    // The one case where the sums differ, and deliberately: a `bucketMax`-word
    // prompt is already reported exactly by the bucket at `bucketMax`, and the
    // tail only ever describes lengths beyond it.
    const stats = statsFrom([
      ...Array.from({ length: 38 }, () => 5),
      10,
      10,
      40,
    ])
    const overflow = stats.histogram.find((b) => b.length === stats.bucketMax)
    const tailTotal = (stats.tail ?? []).reduce((sum, e) => sum + e.count, 0)

    expect(stats.bucketMax).toBe(10)
    expect(overflow?.count).toBe(3)
    expect(tailTotal).toBe(1)
    expect(serverPromptStatsSchema.safeParse(stats).success).toBe(true)
  })
})

/** A state with `count` outstanding sessions, all on one dirty date. */
function stateWithPrompts(count: number, date = '2026-03-02') {
  const state = emptyState()
  for (let i = 0; i < count; i++) {
    const id = `${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`
    const at = new Date(Date.parse(`${date}T00:00:00.000Z`) + i * 1000)
    state.prompts.sessions[id] = {
      startedAt: at.toISOString(),
      lastActiveAt: at.toISOString(),
      promptCount: i + 1,
    }
    state.prompts.dirtySessions.push(id)
  }
  state.prompts.daily[date] = { prompts: count, words: count * 9 }
  state.prompts.dirtyDates.push(date)
  return state
}

describe('promptActivity payload matches the server schema', () => {
  it('accepts what a tick actually builds', () => {
    const payload = tickPayload(stateWithPrompts(3), { promptActivity: true })
    expect(
      serverPromptActivitySchema.safeParse(payload.promptActivity).success
    ).toBe(true)
  })

  it('honours the session cap the server enforces', () => {
    const state = stateWithPrompts(PROMPT_ACTIVITY_SESSION_CAP + 40)
    const payload = tickPayload(state, { promptActivity: true })

    expect(payload.promptActivity?.sessions).toHaveLength(
      PROMPT_ACTIVITY_SESSION_CAP
    )
    expect(
      serverPromptActivitySchema.safeParse(payload.promptActivity).success
    ).toBe(true)

    // Over-cap sessions are held back, not dropped: they go out next tick.
    markUploaded(state)
    expect(state.prompts.dirtySessions).toHaveLength(40)
  })

  it('honours the date cap the server enforces', () => {
    const state = emptyState()
    for (let i = 0; i < PROMPT_ACTIVITY_DATE_CAP + 30; i++) {
      const date = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10)
      state.prompts.daily[date] = { prompts: 1, words: 4 }
      state.prompts.dirtyDates.push(date)
    }

    const payload = tickPayload(state, { promptActivity: true })
    expect(payload.promptActivity?.dailyPrompts).toHaveLength(
      PROMPT_ACTIVITY_DATE_CAP
    )
    expect(
      serverPromptActivitySchema.safeParse(payload.promptActivity).success
    ).toBe(true)
  })

  it('re-sends everything when the POST was never acked', () => {
    // The server's upserts are idempotent (GREATEST wins), so the CLI is free
    // to resend — and must, or a failed minute silently loses a session.
    const state = stateWithPrompts(3)
    const first = tickPayload(state, { promptActivity: true })
    const second = tickPayload(state, { promptActivity: true })

    expect(second.promptActivity).toEqual(first.promptActivity)
  })

  it('is absent entirely at the none tier', () => {
    const payload = tickPayload(stateWithPrompts(3))
    expect(payload.promptActivity).toBeUndefined()
    expect('promptActivity' in payload).toBe(false)
  })

  it('never claims a session with no prompts, which the server rejects', () => {
    const payload = tickPayload(stateWithPrompts(5), { promptActivity: true })
    expect(
      payload.promptActivity?.sessions.every((s) => s.promptCount >= 1)
    ).toBe(true)
  })
})
