import chalk from 'chalk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AgentProfile, renderDossier } from './dossier.js'

const orig = chalk.level

beforeAll(() => {
  chalk.level = 0
})

afterAll(() => {
  chalk.level = orig
})

function fixture(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    handle: 'isomiki',
    displayName: 'Marin Belec',
    bio: 'building hacklab. ex-X. lisbon.',
    url: 'https://hacklab.so/isomiki',
    joinedAt: '2026-04-02T00:00:00.000Z',
    claimedAt: '2026-04-02T00:00:00.000Z',
    openToWork: true,
    belt: { level: 32, title: 'shinobi', color: 'blue' },
    xp: { pyro: 2_000_000, hacker: 500_000, mason: 0, total: 2_500_000 },
    tokens: {
      total: 2_500_000_000,
      last30Days: 86_000_000,
      estimatedCostUsd: 1240.05,
      byModel: {
        'opus-4.8': 53_000_000,
        'sonnet-4.5': 27_000_000,
        haiku: 0,
      },
    },
    rank: 3,
    streak: { current: 14, longest: 31 },
    stats: { projects: 4, essays: 3, drops: 12, followers: 9, following: 2 },
    skills: [
      { class: 'hacker', skill: 'TypeScript', level: 25 },
      { class: 'hacker', skill: 'Go', level: 8 },
      { class: 'pyro', skill: 'claude-code', level: 42 },
      { class: 'pyro', skill: 'cursor', level: 26 },
    ],
    links: {
      profile: 'https://hacklab.so/isomiki',
      website: 'https://marinbelec.com',
      github: 'https://github.com/isomiki',
      x: 'https://x.com/isomiki',
      linkedin: null,
      youtube: null,
      instagram: null,
      blog: null,
    },
    recent: {
      projects: [
        {
          title: 'hacklab',
          description: 'telemetry + community for AI-native builders',
        },
        { title: 'gstack', description: 'agent skill suite for shipping' },
      ],
      essays: [
        {
          title: 'Why the CLI is the product',
          publishedAt: '2026-06-28T00:00:00.000Z',
        },
      ],
      drops: [
        {
          text: 'shipped scout v2 draft',
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      ],
    },
    ...over,
  }
}

const empty = (): AgentProfile =>
  fixture({
    displayName: null,
    bio: null,
    openToWork: false,
    rank: null,
    xp: { pyro: 0, hacker: 0, mason: 0, total: 0 },
    tokens: { total: 0, last30Days: 0, estimatedCostUsd: 0, byModel: {} },
    streak: { current: 0, longest: 0 },
    stats: { projects: 0, essays: 0, drops: 0, followers: 0, following: 0 },
    skills: [],
    links: {
      profile: 'https://hacklab.so/isomiki',
      website: null,
      github: null,
      x: null,
      linkedin: null,
      youtube: null,
      instagram: null,
      blog: null,
    },
    recent: { projects: [], essays: [], drops: [] },
  })

const body = (over?: Partial<AgentProfile>, self = false) =>
  renderDossier(fixture(over), { self }).join('\n')

describe('renderDossier', () => {
  it('leads with name, handle, belt, rank, and open-to-work', () => {
    const text = body()
    expect(text).toContain('Marin Belec')
    expect(text).toContain('@isomiki')
    expect(text).toContain('L32 shinobi')
    expect(text).toContain('rank #3')
    expect(text).toContain('open to work')
  })

  it('drops the display name when it is missing', () => {
    const text = body({ displayName: null })
    expect(text.startsWith('@isomiki')).toBe(true)
    expect(text).not.toContain('null')
  })

  it('prints bio as its own beat', () => {
    const lines = renderDossier(fixture()).filter((l) => l.trim() !== '')
    expect(lines).toContain('building hacklab. ex-X. lisbon.')
  })

  it('prints tokens, streak, xp, and follows', () => {
    const text = body()
    expect(text).toMatch(/tokens\s+2\.5B total/)
    expect(text).toContain('86.0M last 30d')
    expect(text).toContain('$1,240')
    expect(text).toMatch(/streak\s+14d current/)
    expect(text).toContain('31d longest')
    expect(text).toMatch(/xp\s+pyro 2\.0M/)
    expect(text).toContain('hacker 500K')
    expect(text).toContain('mason 0')
    expect(text).toMatch(/follows\s+9 followers/)
    expect(text).toContain('2 following')
  })

  it('prints set links and not the profile url in the link list', () => {
    const text = body()
    expect(text).toContain('https://github.com/isomiki')
    expect(text).toContain('https://x.com/isomiki')
    expect(text).toContain('https://marinbelec.com')
    const linkBlock = text
      .split('\n')
      .filter((l) => /^\s*(github|x|website|blog)\s/.test(l))
    expect(linkBlock.join('\n')).not.toContain('hacklab.so/isomiki')
  })

  it('splits language skills from pyro tools', () => {
    const text = body()
    expect(text).toMatch(/skills\s+TypeScript 25/)
    expect(text).toContain('Go 8')
    expect(text).toMatch(/tools\s+claude-code 42/)
    expect(text).toContain('cursor 26')
  })

  it('lists models by tokens, skipping zeros', () => {
    const text = body()
    expect(text).toMatch(/models\s+opus-4\.8 53\.0M/)
    expect(text).toContain('sonnet-4.5 27.0M')
    expect(text).not.toContain('haiku')
  })

  it('lists every returned project with a full title and indented description', () => {
    const text = body({
      recent: {
        ...fixture().recent,
        projects: [
          {
            title:
              'A Very Long Project Title That Must Not Be Truncated At Sixteen',
            description: 'the whole description stays',
          },
        ],
      },
    })
    expect(text).toMatch(/projects 4/)
    expect(text).toContain(
      'A Very Long Project Title That Must Not Be Truncated At Sixteen'
    )
    expect(text).not.toContain('…')
    expect(text).toContain('the whole description stays')
  })

  it('prints essays and drops with dates, no quoting', () => {
    const text = body()
    expect(text).toMatch(/essays 3/)
    expect(text).toContain('2026-06-28  Why the CLI is the product')
    expect(text).toMatch(/drops 12/)
    expect(text).toContain('2026-07-13  shipped scout v2 draft')
    expect(text).not.toContain('"shipped scout v2 draft"')
  })

  it('ends with the profile url', () => {
    const lines = renderDossier(fixture()).filter((l) => l.length > 0)
    expect(lines.at(-1)).toContain('https://hacklab.so/isomiki')
  })

  it('prints the CLI app url, not the payload url', () => {
    const lines = renderDossier(fixture(), {
      appUrl: 'http://localhost:3000',
    }).filter((l) => l.length > 0)
    expect(lines.at(-1)).toContain('http://localhost:3000/isomiki')
    expect(lines.at(-1)).not.toContain('hacklab.so')
  })

  it('adds the set hint only for self', () => {
    expect(body(undefined, true)).toContain(
      'hacklab profile set <field> <value>'
    )
    expect(body(undefined, false)).not.toContain('hacklab profile set')
  })

  it('omits empty fields and empty sections', () => {
    const text = renderDossier(empty()).join('\n')
    expect(text).toContain('@isomiki')
    expect(text).toContain('L32 shinobi')
    expect(text).not.toContain('open to work')
    expect(text).not.toContain('tokens')
    expect(text).not.toContain('streak')
    expect(text).not.toContain('xp')
    expect(text).not.toContain('follows')
    expect(text).not.toContain('skills')
    expect(text).not.toContain('tools')
    expect(text).not.toContain('models')
    expect(text).not.toContain('projects')
    expect(text).not.toContain('essays')
    expect(text).not.toContain('drops')
    expect(text).toContain('https://hacklab.so/isomiki')
  })

  it('is a document, not a card', () => {
    const text = body()
    expect(text).not.toContain('─')
    expect(text).not.toContain('█')
    expect(text).not.toContain('+2 more')
    expect(text).not.toContain('▁')
    expect(text).not.toContain('--json')
  })

  it('strips control characters from user text', () => {
    const lines = renderDossier(fixture({ bio: 'hi\x1b[0m there' }))
    expect(lines).toContain('hi[0m there')
  })
})
