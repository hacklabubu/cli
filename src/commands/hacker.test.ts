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

import { hacker } from './hacker.js'

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
  } as never)
  // Default: the card endpoint 200s; search (near-match) returns nothing.
  vi.mocked(fetchApi).mockImplementation((async (_s, path: string) =>
    path.startsWith('/api/hackers/search')
      ? jsonResponse({ hackers: [] })
      : jsonResponse({
          schemaVersion: 2,
          generatedAt: 'x',
          hacker: AGENT,
        })) as never)
})

const output = () => out.join('\n')

describe('hacker', () => {
  it('exits 1 with usage when no username is given', async () => {
    await expect(hacker([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab hacker <username>')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('--json with no username emits an error envelope without fetching', async () => {
    await expect(hacker(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'invalid_fields', message: 'pass a username' },
    })
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('exits 1 "not logged in" when there is no session', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(hacker(['isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain('not logged in')
  })

  it('renders the dossier on 200', async () => {
    await hacker(['isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/isomiki?src=cli&format=agent'),
      expect.anything()
    )
    expect(output()).toContain('Marin Belec')
    expect(output()).toContain('@isomiki')
    expect(output()).toContain('L32 shinobi')
  })

  it('sends ?src=cli', async () => {
    await hacker(['isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('src=cli'),
      expect.anything()
    )
  })

  it('--json prints the envelope and does not render a card', async () => {
    await hacker(['isomiki', '--json'])
    const printed = JSON.parse(output())
    expect(printed.hacker.handle).toBe('isomiki')
    expect(output()).not.toContain('L32 shinobi')
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('format=agent'),
      expect.anything()
    )
  })

  it('--json on a non-JSON response body → bad_response envelope', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as never)
    await expect(hacker(['isomiki', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'bad_response', message: 'malformed response' },
    })
  })

  it('a non-JSON response body prints the human bad-response error', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as never)
    await expect(hacker(['isomiki'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('got a malformed response from hacklab')
  })

  it('401 → per-backend unauthorized hint, exit 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, error: { code: 'unauthorized' } }, 401)
    )
    await expect(hacker(['isomiki'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unauthorized')
    expect(output()).toContain('hacklab login')
  })

  it('404 → "no hacker named" + a near-match suggestion, exit 1', async () => {
    vi.mocked(fetchApi).mockImplementation((async (_s, path: string) =>
      path.startsWith('/api/hackers/search')
        ? jsonResponse({ hackers: [{ handle: 'isomiki' }] })
        : jsonResponse(
            { schemaVersion: 1, error: { code: 'not_found' } },
            404
          )) as never)
    await expect(hacker(['isomik'])).rejects.toThrow('__exit__')
    expect(output()).toContain('no hacker named "isomik"')
    expect(output()).toContain('hacklab hacker isomiki')
  })

  it('429 → slow-down copy, exit 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, error: { code: 'rate_limited' } }, 429)
    )
    await expect(hacker(['isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain('slow down')
  })

  it('--json on an error relays the server envelope and exits 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        { schemaVersion: 1, error: { code: 'not_found', message: 'nope' } },
        404
      )
    )
    await expect(hacker(['ghost', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'not_found', message: 'nope' },
    })
  })

  it('viewing your own handle appends the profile set hint', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
      handle: 'isomiki',
    } as never)
    await hacker(['isomiki'])
    expect(output()).toContain('hacklab profile set <field> <value>')
  })

  it("viewing someone else's handle has no self note", async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
      handle: 'mattbratos',
    } as never)
    await hacker(['isomiki'])
    expect(output()).not.toContain('hacklab profile set')
  })

  it('network failure → friendly message, exit 1', async () => {
    vi.mocked(fetchApi).mockRejectedValue(new Error("couldn't reach hacklab"))
    await expect(hacker(['isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain("couldn't reach hacklab")
  })
})
