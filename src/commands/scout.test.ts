import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { ensureFreshSession, fetchApi } from '../sync.js'
import { mondayUtcStartOfWeek, parseSearchArgs, scout } from './scout.js'

// The feed and picks are subcommands of `scout` now; drive them through the
// dispatcher exactly as the registry does.
const search = (args: string[] = []) => scout(['search', ...args])
const picks = (args: string[] = []) => scout(['picks', ...args])

vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return { ...actual, loadSession: vi.fn() }
})

vi.mock('../sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync.js')>()
  return {
    ...actual,
    fetchApi: vi.fn(),
    ensureFreshSession: vi.fn(),
  }
})

const SESSION = { token: 'tok_123', appUrl: 'https://hacklab.so' } as never

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

const EMPTY_FEED = {
  schemaVersion: 1,
  generatedAt: '2026-07-16T00:00:00Z',
  count: 0,
  hackers: [],
}

let exitSpy: ReturnType<typeof vi.spyOn>
let stdoutSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadSession).mockResolvedValue(SESSION)
  vi.mocked(ensureFreshSession).mockImplementation(async (s) => s)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new ExitError(code)
  }) as never)
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function stderrText() {
  return errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
}

describe('parseSearchArgs flag→param mapping', () => {
  it('maps every flag 1:1 onto API params', () => {
    const parsed = parseSearchArgs([
      '--new-since',
      '2026-07-08T00:00:00Z',
      '--open-to-work',
      '--sort',
      'tokens30d',
      '--limit',
      '10',
      '--json',
    ])
    if ('usage' in parsed) throw new Error('unexpected usage error')
    expect(parsed.json).toBe(true)
    expect(parsed.query.get('newSince')).toBe('2026-07-08T00:00:00Z')
    expect(parsed.query.get('openToWork')).toBe('true')
    expect(parsed.query.get('sort')).toBe('tokens30d')
    expect(parsed.query.get('limit')).toBe('10')
  })

  it('passes unvalidated sort/limit through — the server owns validation', () => {
    const parsed = parseSearchArgs(['--sort', 'vibes', '--limit', 'abc'])
    if ('usage' in parsed) throw new Error('unexpected usage error')
    expect(parsed.query.get('sort')).toBe('vibes')
    expect(parsed.query.get('limit')).toBe('abc')
  })

  it('rejects combining --new-this-week with --new-since', () => {
    expect(
      parseSearchArgs(['--new-this-week', '--new-since', '2026-07-08'])
    ).toEqual({ usage: 'use --new-this-week or --new-since, not both' })
  })

  it('rejects a malformed --new-since before hitting the network', () => {
    expect(parseSearchArgs(['--new-since', 'friday'])).toEqual({
      usage: '--new-since must be an ISO 8601 timestamp',
    })
  })

  it('rejects unknown flags', () => {
    expect(parseSearchArgs(['--frobnicate'])).toEqual({
      usage: 'unknown flag --frobnicate',
    })
  })

  it('maps --new-this-week to the Monday-UTC week start', () => {
    const parsed = parseSearchArgs(['--new-this-week'])
    if ('usage' in parsed) throw new Error('unexpected usage error')
    const value = parsed.query.get('newSince')
    expect(value).toMatch(/T00:00:00\.000Z$/)
    expect(new Date(value as string).getUTCDay()).toBe(1)
  })
})

describe('mondayUtcStartOfWeek', () => {
  it('anchors a mid-week instant to its Monday', () => {
    expect(mondayUtcStartOfWeek(new Date('2026-07-15T17:30:00Z'))).toBe(
      '2026-07-13T00:00:00.000Z'
    )
  })

  it('keeps a Sunday in the week that began the previous Monday', () => {
    expect(mondayUtcStartOfWeek(new Date('2026-07-19T23:59:59Z'))).toBe(
      '2026-07-13T00:00:00.000Z'
    )
  })

  it('maps a Monday at 00:00 to itself (the off-by-one boundary)', () => {
    expect(mondayUtcStartOfWeek(new Date('2026-07-13T00:00:00Z'))).toBe(
      '2026-07-13T00:00:00.000Z'
    )
  })
})

describe('scout search', () => {
  it('exits 2 when not logged in', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(search([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('exits 2 on 401 with the login-expired message on stderr', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(401, { error: 'unauthorized' })
    )
    await expect(search([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain('login expired')
  })

  it('exits 3 on 403 with the invite-only gate copy', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(403, { error: 'scout access is invite-only' })
    )
    await expect(search([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(3)
    expect(stderrText()).toContain('scout is invite-only. talk to marin.')
  })

  it("exits 1 on 400, relaying the server's validation message", async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(400, { error: 'sort must be one of: joined, tokens30d' })
    )
    await expect(search(['--sort', 'vibes'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain('sort must be one of')
  })

  it('exits 1 on a 500 with the broken copy', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(500, { error: 'internal error' })
    )
    await expect(search([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain("broken. we're on it.")
  })

  it('exits 1 on usage errors before any network call', async () => {
    await expect(search(['--frobnicate'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('exits 1 with the error on stderr when the network fails', async () => {
    vi.mocked(fetchApi).mockRejectedValue(new Error('connect ECONNREFUSED'))
    await expect(search([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain('ECONNREFUSED')
  })

  it('keeps stdout empty on the auth-error path even with --json (cron purity)', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(search(['--json'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(2)
    // The login hint must go to stderr, never onto the --json stdout stream.
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrText()).toContain('hacklab login')
  })

  it('renders a singular header for exactly one hacker', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(200, {
        ...EMPTY_FEED,
        count: 1,
        hackers: [
          {
            handle: 'solo',
            displayName: null,
            bio: null,
            claimedAt: null,
            belt: 'white',
            level: 1,
            tokensTotal: 0,
            tokens30d: 0,
            activeDays30: 0,
            counts: { projects: 0, essays: 0, drops: 0, followers: 0 },
            projects: [],
            links: {
              profile: 'https://hacklab.so/solo',
              website: null,
              github: null,
            },
            openToWork: false,
          },
        ],
      })
    )
    await search([])
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('1 hacker')
    expect(output).not.toContain('1 hackers')
  })

  it('strips ANSI/control sequences from member-controlled fields', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(200, {
        ...EMPTY_FEED,
        count: 1,
        hackers: [
          {
            handle: 'evil\x1b[2J',
            displayName: 'Bob\x07',
            bio: 'clear\x1b[3Jyour\x1b[2Kterminal',
            claimedAt: null,
            belt: 'white',
            level: 1,
            tokensTotal: 0,
            tokens30d: 0,
            activeDays30: 0,
            counts: { projects: 0, essays: 0, drops: 0, followers: 0 },
            projects: [],
            links: {
              profile: 'https://hacklab.so/evil',
              website: null,
              github: null,
            },
            openToWork: false,
          },
        ],
      })
    )
    await search([])
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    // The injected terminal-hijack sequences are gone (chalk never emits these,
    // so the assertion holds whether or not color is enabled in the test env).
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[3J')
    expect(output).not.toContain('\x1b[2K')
    expect(output).not.toContain('\x07')
  })

  it('--json writes the server envelope verbatim to stdout and nothing else', async () => {
    vi.mocked(fetchApi).mockResolvedValue(jsonResponse(200, EMPTY_FEED))

    await search(['--json'])

    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const written = stdoutSpy.mock.calls[0]?.[0] as string
    expect(JSON.parse(written)).toEqual(EMPTY_FEED)
    expect(logSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('sends the session bearer token and the query string', async () => {
    vi.mocked(fetchApi).mockResolvedValue(jsonResponse(200, EMPTY_FEED))

    await search(['--json', '--sort', 'streak', '--limit', '5'])

    expect(fetchApi).toHaveBeenCalledWith(
      SESSION,
      '/api/scout/hackers?sort=streak&limit=5',
      { headers: { Authorization: 'Bearer tok_123' } }
    )
  })

  it('renders a human list (FORCE_COLOR=0 safe) with belt and stats', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(200, {
        ...EMPTY_FEED,
        count: 1,
        hackers: [
          {
            handle: 'veratest',
            displayName: 'Vera Test',
            bio: 'builds odd things',
            claimedAt: '2026-07-14T00:00:00Z',
            belt: 'white',
            level: 4,
            tokensTotal: 1_000_000,
            tokens30d: 250_000,
            activeDays30: 12,
            counts: { projects: 3, essays: 2, drops: 5, followers: 7 },
            projects: [{ title: 'crdt-editor', description: 'editor' }],
            recent: { essayTitles: [] },
            links: {
              profile: 'https://hacklab.so/veratest',
              website: null,
              github: 'https://github.com/veratest',
            },
            openToWork: true,
          },
        ],
      })
    )

    await search([])

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('@veratest')
    expect(output).toContain('white lv4')
    expect(output).toContain('open to work')
    expect(output).toContain('building: crdt-editor')
    expect(output).toContain('hacklab.so/veratest')
    expect(stdoutSpy).not.toHaveBeenCalled()
  })
})

describe('scout picks', () => {
  it('prints the friday copy for an empty week', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(200, {
        schemaVersion: 1,
        weekOf: null,
        publishedAt: null,
        count: 0,
        picks: [],
      })
    )

    await picks([])

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('no picks yet this week. check back friday.')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('renders the picks with position, thesis, and links', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(200, {
        schemaVersion: 1,
        weekOf: '2026-07-13',
        publishedAt: '2026-07-16T00:00:00Z',
        count: 1,
        picks: [
          {
            position: 1,
            thesis: 'Relentless shipper.',
            handle: 'veratest',
            displayName: 'Vera Test',
            belt: 'white',
            level: 4,
            links: {
              profile: 'https://hacklab.so/veratest',
              website: 'https://vera.dev',
              github: null,
            },
          },
        ],
      })
    )

    await picks([])

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('scout picks: week of 2026-07-13')
    // DESIGN.md Voice hard rule: no em-dashes anywhere in rendered copy.
    expect(output).not.toContain('—')
    expect(output).toContain('1. @veratest')
    expect(output).toContain('Relentless shipper.')
    expect(output).toContain('vera.dev')
  })

  it('exits 3 on the gate like the feed command', async () => {
    vi.mocked(fetchApi).mockResolvedValue(jsonResponse(403, { error: 'nope' }))
    await expect(picks([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(3)
  })

  it('rejects unknown flags with exit 1', async () => {
    await expect(picks(['--limit', '5'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

describe('scout dispatcher', () => {
  it('prints usage and exits 1 with no subcommand, before any network call', async () => {
    await expect(scout([])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(fetchApi).not.toHaveBeenCalled()
    expect(stderrText()).toContain('scout <search|picks>')
  })

  it('treats a bare flag as no subcommand (usage), keeping --json stdout clean', async () => {
    await expect(scout(['--json'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('rejects an unknown subcommand with exit 1', async () => {
    await expect(scout(['picky'])).rejects.toThrow(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain('unknown subcommand: scout picky')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('resolves a shortest-unambiguous subcommand prefix (scout se → search)', async () => {
    vi.mocked(fetchApi).mockResolvedValue(jsonResponse(200, EMPTY_FEED))
    await scout(['se', '--json'])
    expect(fetchApi).toHaveBeenCalledWith(SESSION, '/api/scout/hackers', {
      headers: { Authorization: 'Bearer tok_123' },
    })
  })
})
