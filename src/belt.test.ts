import { describe, expect, it } from 'vitest'

import {
  beltForTokens,
  getBeltColor,
  getTitle,
  levelToMinXp,
  tokensToXp,
  xpToLevel,
} from './belt.js'

describe('tokensToXp', () => {
  it('is 1000 tokens per XP', () => {
    expect(tokensToXp(1000)).toBe(1)
    expect(tokensToXp(1_500_000)).toBe(1500)
    expect(tokensToXp(999)).toBe(0)
  })
})

describe('curve anchors', () => {
  it('level 100 sits at 100M XP', () => {
    expect(Math.round(xpToLevel(100_000_000))).toBe(100)
  })
  it('level 50 sits at ~10M XP', () => {
    expect(Math.round(xpToLevel(10_000_000))).toBe(50)
  })
  it('zero and negative XP are level 0', () => {
    expect(xpToLevel(0)).toBe(0)
    expect(xpToLevel(-5)).toBe(0)
  })
})

describe('beltForTokens', () => {
  // tokens at exactly the floor of each belt tier should report that level + belt.
  const tiers: Array<{ level: number; color: string; title: string }> = [
    { level: 0, color: 'white', title: 'gaijin' },
    { level: 10, color: 'orange', title: 'deshi' },
    { level: 20, color: 'red', title: 'ronin' },
    { level: 30, color: 'blue', title: 'shinobi' },
    { level: 40, color: 'cyan', title: 'samurai' },
    { level: 50, color: 'yellow', title: 'senpai' },
    { level: 60, color: 'lime', title: 'tatsujin' },
    { level: 70, color: 'green', title: 'kensei' },
    { level: 80, color: 'pink', title: 'oni' },
    { level: 90, color: 'purple', title: 'ryujin' },
    { level: 100, color: 'black', title: 'shodan' },
  ]

  for (const t of tiers) {
    it(`level ${t.level} → ${t.color} belt / ${t.title}`, () => {
      // tokens = XP * 1000, nudged 1 XP into the band so float rounding at the
      // exact min-XP boundary can't drop us to level-1 (the server curve rounds
      // identically — this is a test-robustness buffer, not a belt fix).
      const tokens = (levelToMinXp(t.level) + 1) * 1000
      const belt = beltForTokens(tokens)
      expect(belt.level).toBe(t.level)
      expect(belt.beltColor).toBe(t.color)
      expect(belt.title).toBe(t.title)
    })
  }

  it('a brand-new account with zero tokens is a white-belt gaijin at 0%', () => {
    const belt = beltForTokens(0)
    expect(belt).toMatchObject({
      level: 0,
      beltColor: 'white',
      title: 'gaijin',
      progressPercent: 0,
    })
  })

  it('progress is between 0 and 100 mid-level', () => {
    // halfway (in XP) between level 30 and 31
    const mid = (levelToMinXp(30) + levelToMinXp(31)) / 2
    const belt = beltForTokens(mid * 1000)
    expect(belt.level).toBe(30)
    expect(belt.progressPercent).toBeGreaterThan(0)
    expect(belt.progressPercent).toBeLessThanOrEqual(100)
  })
})

describe('getBeltColor / getTitle boundaries', () => {
  it('one level below a tier stays in the lower tier', () => {
    expect(getBeltColor(9)).toBe('white')
    expect(getBeltColor(10)).toBe('orange')
    expect(getTitle(9)).toBe('gaijin')
    expect(getTitle(10)).toBe('deshi')
  })
  it('dan titles kick in at 100', () => {
    expect(getBeltColor(100)).toBe('black')
    expect(getTitle(100)).toBe('shodan')
    expect(getTitle(110)).toBe('nidan')
  })
})
