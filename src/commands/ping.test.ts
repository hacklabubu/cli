import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return { ...actual, loadSession: vi.fn() }
})

import { ping } from './ping.js'

const SESSION = {
  token: 'secret-token',
  email: 'grace@example.com',
  handle: 'grace',
  appUrl: 'https://hacklab.so',
  savedAt: new Date().toISOString(),
}

// Built from a char code so the pattern itself carries no control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** Drop the colour so a row can be measured in columns. */
const stripAnsi = (value: string) => value.replace(ANSI, '')

function stubFetch(response: { ok: boolean; status: number }) {
  const fn = vi.fn(async () => response as unknown as Response)
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('ping', () => {
  let out: string[]
  let exitCode: number | undefined

  beforeEach(() => {
    out = []
    exitCode = undefined
    // The un-mocked resolveAppUrl prefers this env var over the session — a
    // leaked value from the host environment would repoint every assertion.
    delete process.env.HACKLAB_APP_URL
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const output = () => out.join('\n')

  it('unauthenticated: reports the server was reached, with no auth mention', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    const fetchMock = stubFetch({ ok: true, status: 200 })

    await ping()

    expect(output()).toContain('server reached — https://hacklab.so')
    expect(output()).not.toMatch(/auth|logged|token/i)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://hacklab.so/api/cli/ping')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
  })

  it('unauthenticated: unreachable server → failure, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    await expect(ping()).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('could not reach https://hacklab.so')
  })

  it('authenticated: sends the session token and reports auth is good', async () => {
    vi.mocked(loadSession).mockResolvedValue(SESSION)
    const fetchMock = stubFetch({ ok: true, status: 200 })

    await ping()

    expect(output()).toContain('server reached — https://hacklab.so')
    expect(output()).toContain('authenticated as grace — ping recorded')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' })
  })

  // The recorded ping is step 1 of `hacklab rtfm profile-setup`, so it is the
  // first deterministic moment an agent can tell the user they are free to go.
  // Boxed on purpose (DESIGN.md's one sanctioned box): it is read inside an
  // agent transcript, where a plain line gets scrolled past.
  describe('the go-back-to-your-browser box', () => {
    it('prints on the recorded ping, bordered and unmissable', async () => {
      vi.mocked(loadSession).mockResolvedValue(SESSION)
      stubFetch({ ok: true, status: 200 })

      await ping()

      expect(output()).toContain('Go back to your browser')
      expect(output()).toContain('your agent fills in your profile')
      expect(output()).toContain('┌')
      expect(output()).toContain('└')
      expect(output()).toMatch(/│.*│/)
    })

    it('never prints on the anonymous reachability probe', async () => {
      vi.mocked(loadSession).mockResolvedValue(null)
      stubFetch({ ok: true, status: 200 })

      await ping()

      expect(output()).not.toContain('Go back to your browser')
      expect(output()).not.toContain('┌')
    })

    it('never prints when the ping was not recorded', async () => {
      vi.mocked(loadSession).mockResolvedValue(SESSION)
      stubFetch({ ok: false, status: 500 })

      await ping()

      expect(output()).not.toContain('Go back to your browser')
    })

    it('keeps its shape on a narrow terminal', async () => {
      const original = process.stdout.columns
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        value: 28,
      })
      try {
        vi.mocked(loadSession).mockResolvedValue(SESSION)
        stubFetch({ ok: true, status: 200 })

        await ping()

        // Every row of the box is the same width, and none of it overflows.
        const rows = out
          .flatMap((line) => line.split('\n'))
          .filter((line) => /[┌│└]/.test(line))
        expect(rows.length).toBeGreaterThan(4)
        const widths = new Set(rows.map((line) => stripAnsi(line).length))
        expect(widths.size).toBe(1)
        expect([...widths][0]).toBeLessThanOrEqual(28)
        expect(output()).toContain('Go back to your')
      } finally {
        Object.defineProperty(process.stdout, 'columns', {
          configurable: true,
          value: original,
        })
      }
    })
  })

  it('authenticated: 401 → still success, with the re-login hint', async () => {
    vi.mocked(loadSession).mockResolvedValue(SESSION)
    stubFetch({ ok: false, status: 401 })

    await ping()

    expect(exitCode).toBeUndefined()
    expect(output()).toContain('server reached — https://hacklab.so')
    expect(output()).toContain('unauthorized')
    expect(output()).toContain('hacklab login')
  })

  it('authenticated: non-auth server error → success, ping not recorded', async () => {
    vi.mocked(loadSession).mockResolvedValue(SESSION)
    stubFetch({ ok: false, status: 500 })

    await ping()

    expect(output()).toContain('server reached — https://hacklab.so')
    expect(output()).toContain('server error (500) — ping not recorded')
  })

  it('authenticated: unreachable server → the same failure as unauthenticated', async () => {
    vi.mocked(loadSession).mockResolvedValue(SESSION)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    await expect(ping()).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('could not reach https://hacklab.so')
    expect(output()).not.toMatch(/auth|token/i)
  })
})
