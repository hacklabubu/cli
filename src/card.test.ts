import chalk from 'chalk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type HackerCardData, renderCard, renderCompact } from './card.js'
import { displayWidth } from './ui.js'

const NOW = new Date('2026-07-15T12:00:00Z')

function fixture(over: Partial<HackerCardData> = {}): HackerCardData {
  return {
    handle: 'isomiki',
    displayName: 'Marin Belec',
    bio: 'building hacklab. ex-X. lisbon.',
    joinedAt: '2026-04-02T00:00:00.000Z',
    claimedAt: '2026-04-02T00:00:00.000Z',
    level: 32, // blue belt, shinobi
    tokensTotal: 2_500_000_000,
    tokens30d: 86_000_000,
    estimatedCost: 1240,
    rank: 3,
    topModels30d: [
      { model: 'opus-4.8', tokens: 53_000_000, pct: 62 },
      { model: 'sonnet-4.5', tokens: 27_000_000, pct: 31 },
      { model: 'haiku-4.5', tokens: 6_000_000, pct: 7 },
    ],
    currentStreak: 14,
    longestStreak: 31,
    activeDays30: 22,
    activity30: Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? 0 : i * 1e6
    ),
    counts: { projects: 4, essays: 3, drops: 12, followers: 9 },
    recent: {
      projects: [
        {
          title: 'hacklab',
          description: 'telemetry + community for AI-native builders',
        },
        { title: 'gstack', description: 'agent skill suite for shipping' },
        { title: 'third', description: 'another one' },
      ],
      essays: [
        { title: 'Why the CLI is the product', publishedAt: '2026-06-28' },
        { title: 'Belt levels considered harmful', publishedAt: '2026-05-11' },
        { title: 'A third essay', publishedAt: '2026-04-01' },
      ],
      drops: [
        {
          text: 'shipped scout v2 draft, 40 min end to end',
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      ],
    },
    links: {
      profile: 'https://hacklab.so/isomiki',
      website: 'https://marinbelec.com',
      github: 'https://github.com/isomiki',
      x: 'https://x.com/isomiki',
    },
    openToWork: false,
    ...over,
  }
}

const seeded = (): HackerCardData =>
  fixture({
    handle: 'someseeded',
    displayName: null,
    bio: null,
    claimedAt: null,
    level: 0, // white belt, gaijin
    tokensTotal: 0,
    tokens30d: 0,
    estimatedCost: 0,
    rank: null,
    topModels30d: [],
    currentStreak: 0,
    longestStreak: 0,
    activeDays30: 0,
    activity30: Array(30).fill(0),
    counts: { projects: 0, essays: 0, drops: 0, followers: 0 },
    recent: { projects: [], essays: [], drops: [] },
    openToWork: false,
  })

const cases: Record<string, HackerCardData> = {
  'claimed active': fixture(),
  'claimed, empty': fixture({
    counts: { projects: 0, essays: 0, drops: 0, followers: 0 },
    recent: { projects: [], essays: [], drops: [] },
  }),
  'seeded, never claimed': seeded(),
  'long name + bio + wide glyphs': fixture({
    displayName: 'A Very Long Display Name That Exceeds The Column Budget 道場',
    bio: 'a bio with 👩‍👩‍👧 emoji and 日本語 text that runs well past sixty-eight columns wide',
    openToWork: true,
  }),
}

describe('renderCard — every case fits 68x21', () => {
  // Match CI (no color) so width asserts read plain output; a colored case runs
  // separately below.
  const orig = chalk.level
  beforeAll(() => {
    chalk.level = 0
  })
  afterAll(() => {
    chalk.level = orig
  })

  for (const [label, card] of Object.entries(cases)) {
    it(`${label}: no row exceeds 68 columns and there are ≤21 rows`, () => {
      const lines = renderCard(card, { now: NOW })
      expect(lines.length).toBeLessThanOrEqual(21)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(68)
      }
    })

    it(`${label}: obeys the DESIGN.md hard rules`, () => {
      const body = renderCard(card, { now: NOW }).join('\n')
      expect(body).not.toContain('//') // Anti-Ornament: no comment chrome
      expect(body).not.toContain('—') // Voice: no em-dash
      expect(body).not.toContain('⬤') // no decorative belt glyph
      expect(body).not.toContain('✓') // no decorative check glyph
    })
  }

  it('renders the belt as a band + romaji rank, correct tier', () => {
    expect(renderCard(fixture(), { now: NOW }).join('\n')).toContain(
      '████ L32 SHINOBI'
    )
    expect(renderCard(seeded(), { now: NOW }).join('\n')).toContain(
      '████ L0 GAIJIN'
    )
  })

  it('shows est. cost and rank on the claimed active card', () => {
    const body = renderCard(fixture(), { now: NOW }).join('\n')
    expect(body).toContain('rank #3')
    expect(body).toContain('$1,240 est. cost')
  })

  it('collapses the activity block for a hacker with zero tokens', () => {
    const body = renderCard(seeded(), { now: NOW }).join('\n')
    expect(body).toContain(
      'no activity yet. run hacklab sync to bank the proof.'
    )
    expect(body).not.toContain('30d')
    expect(body).toContain('not claimed yet')
    expect(body).toContain('PROJECTS 0   nothing yet')
  })

  it('collapses only models + sparkline for a lapsed hacker (tokens but none in 30d)', () => {
    const body = renderCard(
      fixture({ tokens30d: 0, topModels30d: [], activeDays30: 0 }),
      { now: NOW }
    ).join('\n')
    expect(body).toContain('2.5B burned')
    expect(body).not.toContain('models')
  })

  it('shows 2 items + "+N more" when a section has more than 3', () => {
    const body = renderCard(
      fixture({ counts: { projects: 7, essays: 3, drops: 12, followers: 0 } }),
      { now: NOW }
    ).join('\n')
    expect(body).toContain('+5 more')
  })
})

describe('renderCard — with color', () => {
  const orig = chalk.level
  beforeAll(() => {
    chalk.level = 3 // truecolor
  })
  afterAll(() => {
    chalk.level = orig
  })

  it('keeps visible width ≤68 even with ANSI, and resets color', () => {
    const lines = renderCard(fixture({ openToWork: true }), { now: NOW })
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(68)
    }
    // Something was actually colored (belt band / mint dot / dim chrome).
    const body = lines.join('\n')
    expect(body).toContain('\x1b[') // ANSI present
    expect(body).toContain('\x1b[39m') // foreground reset present
  })
})

describe('renderCompact', () => {
  it('is exactly 4 lines', () => {
    expect(renderCompact(fixture())).toHaveLength(4)
  })

  it('carries handle, belt, and the profile url', () => {
    chalk.level = 0
    const [head, , , url] = renderCompact(fixture())
    expect(head).toContain('isomiki')
    expect(head).toContain('L32 SHINOBI')
    expect(url).toContain('hacklab.so/isomiki')
  })
})
