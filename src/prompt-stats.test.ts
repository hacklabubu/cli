import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  addPromptToActivity,
  bucketMaxFor,
  buildHistogram,
  countWords,
  emptyPromptActivity,
  gitOriginUrl,
  PROMPT_LENGTH_BUCKET_MAX,
  PROMPT_LENGTH_BUCKET_MIN,
  PROMPT_SESSION_ID_MAX_CHARS,
  parsePromptLine,
  promptTextFrom,
} from './prompt-stats.js'

const userLine = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { content },
  ...extra,
})

describe('promptTextFrom', () => {
  it('reads a plain string prompt', () => {
    expect(promptTextFrom(userLine('fix the auth bug'))).toBe(
      'fix the auth bug'
    )
  })

  it('joins an all-text content array', () => {
    expect(
      promptTextFrom(
        userLine([
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ])
      )
    ).toBe('first\nsecond')
  })

  it('rejects tool results, which arrive as synthetic user turns', () => {
    expect(
      promptTextFrom(
        userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])
      )
    ).toBeNull()
  })

  it('rejects a mixed array — one non-text block means it is not a typed prompt', () => {
    expect(
      promptTextFrom(
        userLine([
          { type: 'text', text: 'look at this' },
          { type: 'image', source: {} },
        ])
      )
    ).toBeNull()
  })

  it('rejects sidechain entries (subagent chatter, not the person typing)', () => {
    expect(promptTextFrom(userLine('hello', { isSidechain: true }))).toBeNull()
  })

  it('rejects assistant turns and malformed lines', () => {
    expect(
      promptTextFrom({ type: 'assistant', message: { content: 'hi' } })
    ).toBeNull()
    expect(promptTextFrom({ type: 'user' })).toBeNull()
    expect(promptTextFrom(null)).toBeNull()
    expect(promptTextFrom('nonsense')).toBeNull()
  })
})

describe('parsePromptLine', () => {
  const line = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'user',
      sessionId: 'abc-123',
      timestamp: '2026-03-02T12:00:00.000Z',
      message: { content: 'fix the auth bug' },
      ...extra,
    })

  it('reduces a prompt to session, instant and word count', () => {
    expect(parsePromptLine(line())).toEqual({
      sessionId: 'abc-123',
      timestamp: '2026-03-02T12:00:00.000Z',
      words: 4,
    })
  })

  it('canonicalizes the timestamp so string order is time order', () => {
    // The state compares timestamps as strings to widen a session's window;
    // a non-UTC offset would sort wrong if it went in verbatim.
    expect(
      parsePromptLine(line({ timestamp: '2026-03-02T14:00:00+02:00' }))
    ).toEqual({
      sessionId: 'abc-123',
      timestamp: '2026-03-02T12:00:00.000Z',
      words: 4,
    })
  })

  it('drops a prompt that cannot be placed on a session or a day', () => {
    // The server's schema requires both, so an unplaceable prompt would 400
    // the whole sync rather than contributing anything.
    expect(parsePromptLine(line({ sessionId: undefined }))).toBeNull()
    expect(parsePromptLine(line({ timestamp: 'not a date' }))).toBeNull()
    expect(
      parsePromptLine(
        line({ sessionId: 'x'.repeat(PROMPT_SESSION_ID_MAX_CHARS + 1) })
      )
    ).toBeNull()
  })

  it('applies the same exclusions as promptTextFrom', () => {
    expect(parsePromptLine(line({ isSidechain: true }))).toBeNull()
    expect(
      parsePromptLine(line({ message: { content: [{ type: 'tool_result' }] } }))
    ).toBeNull()
    expect(parsePromptLine(line({ message: { content: '   ' } }))).toBeNull()
    expect(parsePromptLine('not json')).toBeNull()
  })
})

describe('addPromptToActivity', () => {
  const at = (iso: string, words = 3) => ({
    sessionId: 's1',
    timestamp: iso,
    words,
  })

  it('widens a session and tallies the day', () => {
    const activity = emptyPromptActivity()
    addPromptToActivity(activity, at('2026-03-02T12:00:00.000Z', 4))
    addPromptToActivity(activity, at('2026-03-02T13:00:00.000Z', 6))

    expect(activity.sessions.s1).toEqual({
      startedAt: '2026-03-02T12:00:00.000Z',
      lastActiveAt: '2026-03-02T13:00:00.000Z',
      promptCount: 2,
    })
    expect(activity.daily['2026-03-02']).toEqual({ prompts: 2, words: 10 })
  })

  it('moves startedAt back when a transcript is read out of order', () => {
    const activity = emptyPromptActivity()
    addPromptToActivity(activity, at('2026-03-02T13:00:00.000Z'))
    addPromptToActivity(activity, at('2026-03-02T09:00:00.000Z'))

    expect(activity.sessions.s1?.startedAt).toBe('2026-03-02T09:00:00.000Z')
    expect(activity.sessions.s1?.lastActiveAt).toBe('2026-03-02T13:00:00.000Z')
  })

  it('reports the session and date it touched', () => {
    expect(
      addPromptToActivity(emptyPromptActivity(), at('2026-03-02T23:30:00.000Z'))
    ).toEqual({ sessionId: 's1', date: '2026-03-02' })
  })
})

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('make the button blue')).toBe(4)
  })

  it('ignores surrounding and repeated whitespace', () => {
    expect(countWords('  a\n\n  b\t c  ')).toBe(3)
  })

  it('returns 0 for empty or whitespace-only text', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   \n ')).toBe(0)
  })
})

describe('bucketMaxFor', () => {
  it('floors at the minimum for a terse user', () => {
    expect(bucketMaxFor([1, 1, 2, 2, 3])).toBe(PROMPT_LENGTH_BUCKET_MIN)
  })

  it('caps at the maximum for a verbose one', () => {
    expect(bucketMaxFor(Array.from({ length: 100 }, () => 5_000))).toBe(
      PROMPT_LENGTH_BUCKET_MAX
    )
  })

  it('rounds the p90 up to a multiple of 10', () => {
    // 90th percentile of 1..100 is 91, which rounds up to 100.
    const counts = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(bucketMaxFor(counts)).toBe(100)
  })

  it('tracks the distribution rather than the outliers', () => {
    // 95 prompts of ~12 words, 5 enormous ones: the axis should follow the bulk.
    const counts = [
      ...Array.from({ length: 95 }, () => 12),
      ...Array.from({ length: 5 }, () => 900),
    ]
    expect(bucketMaxFor(counts)).toBe(20)
  })

  it('returns the minimum for an empty scan', () => {
    expect(bucketMaxFor([])).toBe(PROMPT_LENGTH_BUCKET_MIN)
  })
})

describe('buildHistogram', () => {
  it('buckets exact word counts below bucketMax', () => {
    expect(buildHistogram([1, 1, 3], 10)).toEqual([
      { length: 1, count: 2 },
      { length: 3, count: 1 },
    ])
  })

  it('collapses everything at or above bucketMax into the overflow bucket', () => {
    expect(buildHistogram([10, 11, 500], 10)).toEqual([
      { length: 10, count: 3 },
    ])
  })

  it('omits empty buckets and sorts ascending', () => {
    const histogram = buildHistogram([5, 2, 5], 10)
    expect(histogram).toEqual([
      { length: 2, count: 1 },
      { length: 5, count: 2 },
    ])
  })

  it('drops non-positive counts', () => {
    expect(buildHistogram([0, -3, 4], 10)).toEqual([{ length: 4, count: 1 }])
  })

  it('preserves the total across buckets', () => {
    const counts = [1, 4, 4, 9, 40, 41]
    const total = buildHistogram(counts, 20).reduce((s, b) => s + b.count, 0)
    expect(total).toBe(counts.length)
  })
})

describe('gitOriginUrl', () => {
  it('returns null for a directory that is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hacklab-prompt-stats-'))
    expect(await gitOriginUrl(dir)).toBeNull()
  })

  it('returns null for a path that does not exist', async () => {
    expect(
      await gitOriginUrl(join(tmpdir(), 'hacklab-does-not-exist'))
    ).toBeNull()
  })
})

describe('scan inputs', () => {
  it('treats a transcript with only tool results as having no prompts', async () => {
    // Guards the whole pipeline's premise: a session where the user typed
    // nothing (replayed tool traffic only) must not inflate the histogram.
    const dir = await mkdtemp(join(tmpdir(), 'hacklab-transcript-'))
    await mkdir(join(dir, 'project'), { recursive: true })
    const lines = [
      JSON.stringify(userLine([{ type: 'tool_result', content: 'ok' }])),
      JSON.stringify({ type: 'assistant', message: { content: 'done' } }),
    ]
    await writeFile(join(dir, 'project', 's.jsonl'), lines.join('\n'))

    const prompts = lines
      .map((line) => promptTextFrom(JSON.parse(line)))
      .filter((text): text is string => text !== null)
    expect(prompts).toEqual([])
  })
})
