import { describe, expect, it } from 'vitest'

import {
  computeStreaks,
  formatBytes,
  formatTokens,
  TokenCollector,
  toDateStr,
} from './util.js'

/** UTC YYYY-MM-DD `n` days before today. */
function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('TokenCollector', () => {
  it('aggregates daily tokens per date+model and tallies model totals', () => {
    const c = new TokenCollector('claude_code')
    c.addDaily('2026-01-01', 'opus', 100, 1)
    c.addDaily('2026-01-01', 'opus', 50, 1)
    c.addDaily('2026-01-02', 'sonnet', 30, 1)

    const r = c.result()
    expect(r.tool).toBe('claude_code')

    const jan1 = r.daily.find(
      (d) => d.date === '2026-01-01' && d.model === 'opus'
    )
    expect(jan1?.tokens).toBe(150)
    expect(jan1?.messages).toBe(2)

    expect(r.models).toEqual({ opus: 150, sonnet: 30 })
  })

  it('omits the model key for blank models', () => {
    const c = new TokenCollector('cursor')
    c.addDaily('2026-01-01', '', 90, 1)
    const r = c.result()
    expect(r.daily[0]?.model).toBeUndefined()
    expect(r.models).toEqual({})
  })

  it('drops hourly entries older than the 90-day window', () => {
    const c = new TokenCollector('codex')
    c.addHourly('2000-01-01', 12, 'm', 100, 1) // ancient → dropped
    expect(c.result().hourly).toHaveLength(0)
  })

  it('keeps and merges recent hourly entries', () => {
    const c = new TokenCollector('codex')
    const today = new Date().toISOString().slice(0, 10)
    c.addHourly(today, 9, 'm', 10, 1)
    c.addHourly(today, 9, 'm', 5, 1)
    const r = c.result()
    expect(r.hourly).toHaveLength(1)
    expect(r.hourly[0]?.tokens).toBe(15)
    expect(r.hourly[0]?.messages).toBe(2)
  })

  it('carries cursor extras through result()', () => {
    const c = new TokenCollector('cursor')
    const r = c.result({ cursorScanStatus: { source: 'api', events: 3 } })
    expect(r.cursorScanStatus).toEqual({ source: 'api', events: 3 })
  })
})

describe('computeStreaks', () => {
  it('counts a run ending today', () => {
    expect(computeStreaks([daysAgo(0), daysAgo(1), daysAgo(2)])).toEqual({
      current: 3,
      longest: 3,
    })
  })

  it('counts a current run that ended yesterday', () => {
    expect(computeStreaks([daysAgo(1), daysAgo(2)])).toEqual({
      current: 2,
      longest: 2,
    })
  })

  it('current is 0 when the last activity is older than yesterday', () => {
    // longest run is the two consecutive older days
    expect(computeStreaks([daysAgo(3), daysAgo(4)])).toEqual({
      current: 0,
      longest: 2,
    })
  })

  it('breaks the current streak on a gap but keeps the longest run', () => {
    expect(computeStreaks([daysAgo(0), daysAgo(3), daysAgo(4)])).toEqual({
      current: 1,
      longest: 2,
    })
  })

  it('dedupes repeated dates and ignores order', () => {
    expect(
      computeStreaks([daysAgo(1), daysAgo(0), daysAgo(1), daysAgo(0)])
    ).toEqual({ current: 2, longest: 2 })
  })

  it('is zero for no activity', () => {
    expect(computeStreaks([])).toEqual({ current: 0, longest: 0 })
  })
})

describe('formatters', () => {
  it('formatTokens scales K/M/B', () => {
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1500)).toBe('2K')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatTokens(3_000_000_000)).toBe('3.0B')
  })

  it('formatBytes scales KB/MB/GB', () => {
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2KB')
    expect(formatBytes(5_242_880)).toBe('5.0MB')
  })

  it('toDateStr handles ms numbers and numeric strings', () => {
    const ms = Date.UTC(2026, 0, 15, 10, 0, 0)
    expect(toDateStr(ms)).toBe('2026-01-15')
    expect(toDateStr(String(ms))).toBe('2026-01-15')
  })
})
