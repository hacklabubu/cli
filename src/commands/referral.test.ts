import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { captureEvent } from '../posthog.js'
import { loadSession } from '../session.js'

vi.mock('../posthog.js', () => ({ captureEvent: vi.fn() }))
vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
}))

import { referral } from './referral.js'

describe('referral output', () => {
  beforeEach(() => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
      handle: 'bratos',
    } as never)
    vi.mocked(captureEvent).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns the handle, url, and message in JSON mode', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value))
    })

    await referral(['--json'])

    const parsed = JSON.parse(output.join('\n'))
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.referral.handle).toBe('bratos')
    expect(parsed.referral.url).toBe('https://hacklab.so/?ref=bratos')
    expect(parsed.referral.message).toContain('https://hacklab.so/?ref=bratos')
  })

  it('tags the capture with the surface it was shown on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      // swallow output; this test only asserts on captureEvent
    })

    await referral(['--json'])
    expect(captureEvent).toHaveBeenCalledWith('bratos', 'cli_referral_shown', {
      via: 'json',
    })

    await referral([])
    expect(captureEvent).toHaveBeenCalledWith('bratos', 'cli_referral_shown', {
      via: 'cli',
    })
  })

  it('prints the referral link for humans', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value))
    })

    await referral([])

    expect(output.join('\n')).toContain('https://hacklab.so/?ref=bratos')
  })
})

describe('referral failures', () => {
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
    // Clear call history from the prior describe block — the vi.mock() fn is
    // shared across the file, so `not.toHaveBeenCalled` below needs a fresh slate.
    vi.mocked(captureEvent).mockClear()
    vi.mocked(captureEvent).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const output = () => out.join('\n')

  it('--json with no session → unauthorized envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(referral(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unauthorized', message: 'not logged in' },
    })
  })

  it('--json with an unclaimed session (no handle) → no_handle envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
    } as never)
    await expect(referral(['--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: {
        code: 'no_handle',
        message: 'claim a username first with `hacklab join`',
      },
    })
    expect(captureEvent).not.toHaveBeenCalled()
  })
})
