import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (s?: { appUrl?: string } | null) =>
    (s?.appUrl ?? 'https://hacklab.so').replace(/\/$/, ''),
  unauthorizedHint: () =>
    'unauthorized — your session may have expired. run `hacklab login` to sign in again.',
}))
vi.mock('../sync.js', () => ({ fetchApi: vi.fn() }))

import { profile } from './profile.js'

const ME = {
  handle: 'isomiki',
  displayName: 'Marin Belec',
  bio: 'building hacklab',
  profileReadme: '# hi',
  websiteUrl: null,
  blogUrl: null,
  xUrl: null,
  youtubeUrl: null,
  instagramUrl: null,
  goodreadsUrl: null,
  rssFeedUrl: null,
  githubUsername: 'isomiki',
  openToWork: false,
  claimed: true,
}

const AGENT = {
  handle: 'isomiki',
  displayName: 'Marin Belec',
  bio: 'building hacklab',
  url: 'https://hacklab.so/isomiki',
  joinedAt: '2026-04-02T00:00:00.000Z',
  claimedAt: '2026-04-02T00:00:00.000Z',
  openToWork: false,
  belt: { level: 32, title: 'shinobi', color: 'blue' },
  xp: { pyro: 2_000_000, hacker: 500_000, mason: 0, total: 2_500_000 },
  tokens: {
    total: 2_500_000_000,
    last30Days: 86_000_000,
    estimatedCostUsd: 1240,
    byModel: { opus: 53_000_000 },
  },
  rank: 3,
  streak: { current: 14, longest: 31 },
  stats: { projects: 1, essays: 0, drops: 0, followers: 9, following: 2 },
  skills: [{ class: 'hacker', skill: 'TypeScript', level: 25 }],
  links: {
    profile: 'https://hacklab.so/isomiki',
    website: null,
    github: 'https://github.com/isomiki',
    x: null,
    linkedin: null,
    youtube: null,
    instagram: null,
    blog: null,
  },
  recent: {
    projects: [{ title: 'hacklab', description: 'the lab' }],
    essays: [],
    drops: [],
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response
}

let exitCode: number | undefined
let out: string[]

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  out = []
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  vi.mocked(loadSession).mockResolvedValue({
    token: 't',
    appUrl: 'https://hacklab.so',
    handle: 'isomiki',
  } as never)
  vi.mocked(fetchApi).mockImplementation((async (_s, path: string) =>
    path.startsWith('/api/hackers/me')
      ? jsonResponse({ profile: ME })
      : jsonResponse({
          schemaVersion: 2,
          generatedAt: 'x',
          hacker: AGENT,
        })) as never)
})

const output = () => out.join('\n')

describe('profile view', () => {
  it('prints the same dossier as hacker, plus the set hint', async () => {
    await profile([])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/isomiki?src=cli&format=agent'),
      expect.anything()
    )
    expect(output()).toContain('Marin Belec')
    expect(output()).toContain('@isomiki')
    expect(output()).toContain('L32 shinobi')
    expect(output()).toContain('hacklab')
    expect(output()).toContain('the lab')
    expect(output()).toContain('hacklab profile set <field> <value>')
    expect(output()).not.toContain('readme')
  })

  it('profile view is the same as bare profile', async () => {
    await profile(['view'])
    expect(output()).toContain('L32 shinobi')
    expect(output()).toContain('hacklab profile set <field> <value>')
  })

  it('--json still returns the /me form envelope', async () => {
    await profile(['--json'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackers/me?src=cli',
      expect.anything()
    )
    const printed = JSON.parse(output())
    expect(printed.schemaVersion).toBe(1)
    expect(printed.profile.profileReadme).toBe('# hi')
    expect(output()).not.toContain('L32 shinobi')
  })

  it('falls back to /me when the session has no handle', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
    } as never)
    await profile([])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackers/me?src=cli',
      expect.anything()
    )
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/isomiki?src=cli&format=agent'),
      expect.anything()
    )
    expect(output()).toContain('L32 shinobi')
  })

  it('prints the session app url, not the payload url', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'http://localhost:3000',
      handle: 'isomiki',
    } as never)
    await profile([])
    expect(output()).toContain('http://localhost:3000/isomiki')
    expect(output()).not.toContain('https://hacklab.so/isomiki')
  })

  it('exits 1 when not logged in', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(profile([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('not logged in')
  })
})
