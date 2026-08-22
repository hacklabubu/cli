import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
  unauthorizedHint: () =>
    'unauthorized — your session may have expired. run `hacklab login` to sign in again.',
}))
vi.mock('../ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui.js')>()
  return {
    ...actual,
    bold: (s: string) => s,
    dim: (s: string) => s,
    link: (s: string) => s,
  }
})

import { drops } from './drops.js'

const NEWEST = {
  text: 'shipping the scan card',
  createdAt: '2026-08-21T00:00:00.000Z',
}
const FEED = [
  NEWEST,
  { text: 'claimed @bratos', createdAt: '2026-08-18T12:00:00.000Z' },
]

function captureLog(): string[] {
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value))
  })
  return output
}

function stubProfile(opts?: {
  drops?: { text: string; createdAt: string }[]
  /** null puts the count nowhere — the shape of a backend that never sends one. */
  total?: number | null
  countField?: 'stats' | 'counts'
  ok?: boolean
  status?: number
  error?: { code?: string; message?: string }
}) {
  const drops = opts?.drops ?? FEED
  const total = opts?.total === undefined ? drops.length : opts.total
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (opts?.ok === false) {
        return {
          ok: false,
          status: opts.status ?? 500,
          json: async () => ({
            schemaVersion: 1,
            error: opts.error ?? { code: 'server_error', message: 'nope' },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          hacker: {
            handle: 'bratos',
            ...(total === null
              ? {}
              : { [opts?.countField ?? 'stats']: { drops: total } }),
            recent: { drops },
          },
        }),
      }
    })
  )
}

describe('drops output', () => {
  beforeEach(() => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
      handle: 'bratos',
    } as never)
    stubProfile()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('prints the total, every returned drop, then the feed URL', async () => {
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      'drops 2',
      '2026-08-21  shipping the scan card',
      '2026-08-18  claimed @bratos',
      '',
      'https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('flags the preview as latest N of M when the feed is capped', async () => {
    stubProfile({ drops: [NEWEST], total: 12 })
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      'drops 12',
      '2026-08-21  shipping the scan card',
      '',
      'showing latest 1 of 12 — full list at https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('reads the count from counts.drops when stats is absent', async () => {
    stubProfile({ drops: [NEWEST], total: 12, countField: 'counts' })
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      'drops 12',
      '2026-08-21  shipping the scan card',
      '',
      'showing latest 1 of 12 — full list at https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('claims no total when the server sends no count', async () => {
    stubProfile({ total: null })
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      '2026-08-21  shipping the scan card',
      '2026-08-18  claimed @bratos',
      '',
      'full list at https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('prints nothing yet and the feed URL when the feed is empty', async () => {
    stubProfile({ drops: [] })
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      'nothing yet',
      '',
      'https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('returns the list, the total, and the URL in JSON mode', async () => {
    const output = captureLog()

    await drops(['--json'])

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      drops: FEED,
      total: 2,
      url: 'https://hacklab.so/bratos?tab=drops',
    })
  })

  it('reports the real total in JSON when the feed is capped', async () => {
    stubProfile({ drops: [NEWEST], total: 12 })
    const output = captureLog()

    await drops(['--json'])

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      drops: [NEWEST],
      total: 12,
      url: 'https://hacklab.so/bratos?tab=drops',
    })
  })

  it('omits total in JSON when the server sends no count', async () => {
    stubProfile({ total: null })
    const output = captureLog()

    await drops(['--json'])

    const parsed = JSON.parse(output.join('\n'))
    expect(parsed).toEqual({
      schemaVersion: 1,
      drops: FEED,
      url: 'https://hacklab.so/bratos?tab=drops',
    })
    expect('total' in parsed).toBe(false)
  })

  it('returns an empty list in JSON when there are no drops', async () => {
    stubProfile({ drops: [] })
    const output = captureLog()

    await drops(['--json'])

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      drops: [],
      total: 0,
      url: 'https://hacklab.so/bratos?tab=drops',
    })
  })
})

describe('drops failures', () => {
  let exitCode: number | undefined
  let out: string[]

  beforeEach(() => {
    exitCode = undefined
    out = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as never)
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
      handle: 'bratos',
    } as never)
    stubProfile()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const output = () => out.join('\n')

  it('--json with no session → unauthorized envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(drops(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unauthorized', message: 'not logged in' },
    })
  })

  it('--json with no handle → no_handle envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
    } as never)
    await expect(drops(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: {
        code: 'no_handle',
        message: 'claim a username first with `hacklab login`',
      },
    })
  })

  it('non-json with no session prints the human error', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(drops([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('not logged in')
    expect(output()).not.toContain('schemaVersion')
  })

  it('relays the server envelope message, not [object Object]', async () => {
    stubProfile({
      ok: false,
      status: 500,
      error: { code: 'server_error', message: 'the lab is on fire' },
    })
    await expect(drops([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('the lab is on fire')
    expect(output()).not.toContain('[object Object]')
  })

  it('--json on a failure emits the server code and a string message', async () => {
    stubProfile({
      ok: false,
      status: 500,
      error: { code: 'server_error', message: 'the lab is on fire' },
    })
    await expect(drops(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'server_error', message: 'the lab is on fire' },
    })
  })

  it('401 surfaces the re-login hint in both modes', async () => {
    stubProfile({
      ok: false,
      status: 401,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    })
    await expect(drops([])).rejects.toThrow('__exit__')
    expect(output()).toContain('hacklab login')

    out.length = 0
    await expect(drops(['--json'])).rejects.toThrow('__exit__')
    const envelope = JSON.parse(output()) as {
      error: { code: string; message: string }
    }
    expect(envelope.error.code).toBe('unauthorized')
    expect(envelope.error.message).toContain('hacklab login')
  })

  it('rejects an unknown flag instead of ignoring it', async () => {
    await expect(drops(['--frobnicate'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown flag: --frobnicate')

    out.length = 0
    await expect(drops(['--json', '--frobnicate'])).rejects.toThrow('__exit__')
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unknown_flag', message: 'unknown flag: --frobnicate' },
    })
  })
})
