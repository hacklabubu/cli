import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  unauthorizedHint: () =>
    'unauthorized — your session may have expired. run `hacklab login` to sign in again.',
}))
vi.mock('../sync.js', () => ({ fetchApi: vi.fn() }))

import { hacker } from './hacker.js'

const CARD = {
  handle: 'isomiki',
  displayName: 'Marin Belec',
  bio: null,
  joinedAt: '2026-04-02T00:00:00.000Z',
  claimedAt: '2026-04-02T00:00:00.000Z',
  level: 32,
  tokensTotal: 2_500_000_000,
  tokens30d: 0,
  estimatedCost: 1240,
  rank: 3,
  topModels30d: [],
  currentStreak: 14,
  longestStreak: 31,
  activeDays30: 0,
  activity30: Array(30).fill(0),
  counts: { projects: 0, essays: 0, drops: 0, followers: 0 },
  recent: { projects: [], essays: [], drops: [] },
  links: { profile: '', website: null, github: null, x: null },
  openToWork: false,
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
          schemaVersion: 1,
          generatedAt: 'x',
          hacker: CARD,
        })) as never)
})

const output = () => out.join('\n')

describe('hacker command — dispatch', () => {
  it('exits 1 with usage when no subcommand is given', async () => {
    await expect(hacker([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab hacker [view|list]')
  })

  it('exits 1 on an unknown subcommand', async () => {
    await expect(hacker(['frobnicate', 'isomiki'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
  })

  it('resolves the "v" prefix to "view"', async () => {
    await hacker(['v', 'isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/isomiki'),
      expect.anything()
    )
  })

  it('dispatches list --newest', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, hackers: [] })
    )
    await hacker(['list', '--newest'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/newest'),
      expect.anything()
    )
  })
})

describe('hacker list', () => {
  it('prints newest hackers as JSON', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackers: [
          {
            handle: 'newhacker',
            displayName: 'New Hacker',
            bio: 'building',
            claimedAt: '2026-07-23T10:00:00.000Z',
            openToWork: false,
            path: '/newhacker',
            url: 'https://hacklab.so/newhacker',
          },
        ],
      })
    )

    await hacker(['list', '--newest', '--limit', '10', '--json'])
    expect(JSON.parse(output()).hackers[0].handle).toBe('newhacker')
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('limit=10'),
      expect.anything()
    )
  })

  it.each([
    ['0', ['list', '--newest', '--limit', '0']],
    ['abc', ['list', '--newest', '--limit', 'abc']],
    ['(no value)', ['list', '--newest', '--limit']],
    ['51', ['list', '--newest', '--limit', '51']],
  ])('--limit %s → "--limit must be 1-50", no fetch', async (_label, argv) => {
    await expect(hacker(argv)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('--limit must be 1-50')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('--json --limit 0 emits an invalid_fields envelope without fetching', async () => {
    await expect(
      hacker(['list', '--newest', '--limit', '0', '--json'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'invalid_fields', message: '--limit must be 1-50' },
    })
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('--json on a non-JSON response body → bad_response envelope', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as never)
    await expect(hacker(['list', '--newest', '--json'])).rejects.toThrow(
      '__exit__'
    )
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
    await expect(hacker(['list', '--newest'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('got a malformed response from hacklab')
  })
})

describe('hacker view', () => {
  it('views your own profile when no handle is given', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
      handle: 'isomiki',
    } as never)
    await hacker(['view'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/hackers/isomiki'),
      expect.anything()
    )
    expect(output()).toContain('L32 SHINOBI')
  })

  it('exits 1 when no handle is given and the session has no username', async () => {
    // default mocked session has no handle (unclaimed profile)
    await expect(hacker(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain("haven't claimed a username")
  })

  it('--json with no handle and no username emits an error envelope', async () => {
    await expect(hacker(['view', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output()).error.code).toBe('no_handle')
  })

  it('exits 1 "not logged in" with no handle and no session', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(hacker(['view'])).rejects.toThrow('__exit__')
    expect(output()).toContain('not logged in')
  })

  it('exits 1 "not logged in" when there is no session', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(hacker(['view', 'isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain('not logged in')
  })

  it('renders the card on 200', async () => {
    await hacker(['view', 'isomiki'])
    expect(output()).toContain('isomiki')
    expect(output()).toContain('L32 SHINOBI')
  })

  it('sends ?src=cli', async () => {
    await hacker(['view', 'isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('src=cli'),
      expect.anything()
    )
  })

  it('--json prints the envelope and does not render a card', async () => {
    await hacker(['view', 'isomiki', '--json'])
    const printed = JSON.parse(output())
    expect(printed.hacker.handle).toBe('isomiki')
    expect(output()).not.toContain('L32 SHINOBI')
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('format=agent'),
      expect.anything()
    )
  })

  it('401 → per-backend unauthorized hint, exit 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, error: { code: 'unauthorized' } }, 401)
    )
    await expect(hacker(['view', 'isomiki'])).rejects.toThrow('__exit__')
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
    await expect(hacker(['view', 'isomik'])).rejects.toThrow('__exit__')
    expect(output()).toContain('no hacker named "isomik"')
    expect(output()).toContain('hacklab hacker view isomiki')
  })

  it('429 → slow-down copy, exit 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, error: { code: 'rate_limited' } }, 429)
    )
    await expect(hacker(['view', 'isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain('slow down')
  })

  it('--json on an error relays the server envelope and exits 1', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        { schemaVersion: 1, error: { code: 'not_found', message: 'nope' } },
        404
      )
    )
    await expect(hacker(['view', 'ghost', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'not_found', message: 'nope' },
    })
  })

  it('viewing your own handle appends the edit-with-profile note', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
      handle: 'isomiki',
    } as never)
    await hacker(['view', 'isomiki'])
    expect(output()).toContain('this is you')
    expect(output()).toContain('hacklab profile')
  })

  it("viewing someone else's handle has no self note", async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 't',
      appUrl: 'https://hacklab.so',
      handle: 'mattbratos',
    } as never)
    await hacker(['view', 'isomiki'])
    expect(output()).not.toContain('this is you')
  })

  it('network failure → friendly message, exit 1', async () => {
    vi.mocked(fetchApi).mockRejectedValue(new Error("couldn't reach hacklab"))
    await expect(hacker(['view', 'isomiki'])).rejects.toThrow('__exit__')
    expect(output()).toContain("couldn't reach hacklab")
  })
})
