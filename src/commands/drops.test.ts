import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
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

const FEED = [
  {
    text: 'shipping the scan card',
    createdAt: '2026-08-21T00:00:00.000Z',
  },
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
  ok?: boolean
  status?: number
  error?: unknown
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (opts?.ok === false) {
        return {
          ok: false,
          status: opts.status ?? 500,
          json: async () => ({ error: opts.error ?? 'nope' }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          hacker: {
            handle: 'bratos',
            recent: { drops: opts?.drops ?? FEED },
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

  it('prints every drop then the feed URL', async () => {
    const output = captureLog()

    await drops([])

    expect(output).toEqual([
      '2026-08-21  shipping the scan card',
      '2026-08-18  claimed @bratos',
      '',
      'https://hacklab.so/bratos?tab=drops',
    ])
  })

  it('prints nothing yet when the feed is empty', async () => {
    stubProfile({ drops: [] })
    const output = captureLog()

    await drops([])

    expect(output).toEqual(['nothing yet'])
  })

  it('returns the list and URL in JSON mode', async () => {
    const output = captureLog()

    await drops(['--json'])

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      drops: FEED,
      url: 'https://hacklab.so/bratos?tab=drops',
    })
  })

  it('returns an empty list in JSON when there are no drops', async () => {
    stubProfile({ drops: [] })
    const output = captureLog()

    await drops(['--json'])

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      drops: [],
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
})
