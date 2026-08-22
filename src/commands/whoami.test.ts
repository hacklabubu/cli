import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  loadSession: vi.fn(),
  resolveAppUrl: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return {
    ...actual,
    loadSession: m.loadSession,
    resolveAppUrl: m.resolveAppUrl,
  }
})
vi.mock('../ui.js', () => ({
  dim: (s: string) => s,
  success: m.success,
  info: m.info,
  error: m.error,
}))

import { whoami } from './whoami.js'

const PROD = {
  token: 't',
  email: 'me@example.com',
  handle: 'mattbratos',
  appUrl: 'https://hacklab.so',
  savedAt: '2026-06-20T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  m.resolveAppUrl.mockImplementation(
    (session?: { appUrl?: string } | null) =>
      session?.appUrl?.replace(/\/$/, '') ?? 'https://hacklab.so'
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whoami', () => {
  it('prints @handle and email, not a duplicate handle line', async () => {
    m.loadSession.mockResolvedValue(PROD)
    m.resolveAppUrl.mockReturnValue('https://hacklab.so')

    await whoami()

    expect(m.success).toHaveBeenCalledWith('@mattbratos')
    expect(m.info).toHaveBeenCalledWith('me@example.com')
    expect(m.info.mock.calls.some((c) => String(c[0]).includes('handle'))).toBe(
      false
    )
  })

  it('omits the server on production', async () => {
    m.loadSession.mockResolvedValue(PROD)
    m.resolveAppUrl.mockReturnValue('https://hacklab.so')

    await whoami()

    expect(
      m.info.mock.calls.some((c) => String(c[0]).includes('hacklab.so'))
    ).toBe(false)
  })

  it('shows the server when talking to local development', async () => {
    m.loadSession.mockResolvedValue({
      ...PROD,
      appUrl: 'http://localhost:3000',
    })
    m.resolveAppUrl.mockReturnValue('http://localhost:3000')

    await whoami()

    expect(m.info).toHaveBeenCalledWith('http://localhost:3000')
  })

  it('exits when there is no session', async () => {
    m.loadSession.mockResolvedValue(null)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)

    await expect(whoami()).rejects.toThrow('exit')
    expect(m.error).toHaveBeenCalledWith('not logged in')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
