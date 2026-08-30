import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  waitForEnter: vi.fn(),
  openBrowser: vi.fn(),
  saveSession: vi.fn(),
  order: [] as string[],
}))

vi.mock('../session.js', () => ({
  getAppUrl: () => 'https://hacklab.so',
  resolveAppUrl: (session?: { appUrl?: string } | null) =>
    session?.appUrl ?? 'https://hacklab.so',
  saveSession: m.saveSession,
}))
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn(),
  identifyUser: vi.fn(),
}))
vi.mock('../daily-sync.js', () => ({ clearSyncPaused: vi.fn() }))
vi.mock('../utils/openBrowser.js', () => ({ openBrowser: m.openBrowser }))
vi.mock('../utils/waitForEnter.js', () => ({ waitForEnter: m.waitForEnter }))
vi.mock('../ui.js', () => ({
  bold: (s: string) => s,
  dim: (s: string) => s,
  link: (s: string) => s,
}))

import { login } from './login.js'

const START = {
  deviceCode: 'dev-code',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://hacklab.so/cli/login',
  verificationUriComplete: 'https://hacklab.so/cli/login?code=WDJB-MJHT',
  expiresIn: 900,
  interval: 5,
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const originalIsTTY = process.stdin.isTTY

beforeEach(() => {
  vi.clearAllMocks()
  m.order.length = 0
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    m.order.push(`log:${String(msg)}`)
  })

  m.waitForEnter.mockImplementation(async (prompt: string) => {
    m.order.push(`enter:${prompt.trim()}`)
    return true
  })
  m.openBrowser.mockImplementation(async (url: string) => {
    m.order.push(`open:${url}`)
    return true
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/cli/device/start')) {
        return jsonResponse(START)
      }
      return jsonResponse({
        status: 'approved',
        token: 'tok',
        email: 'a@b.co',
        handle: 'ada',
        usernameClaimed: true,
      })
    })
  )
})

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: originalIsTTY,
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('login — device flow', () => {
  it('shows the code and URL before opening the browser', async () => {
    await login()

    expect(m.order.slice(0, 4)).toEqual([
      'log:copy code',
      'log:WDJB-MJHT',
      'log:',
      'log:https://hacklab.so/cli/login',
    ])
    expect(m.order).toContain('enter:(press enter)')
    expect(m.order).toContain(
      'open:https://hacklab.so/cli/login?code=WDJB-MJHT'
    )
    expect(m.order.at(-1)).toBe('log:signed in as @ada')
  })

  it('still opens the browser when stdin is non-interactive', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    })
    m.waitForEnter.mockResolvedValue(false)

    await login()

    expect(m.openBrowser).toHaveBeenCalledWith(
      'https://hacklab.so/cli/login?code=WDJB-MJHT'
    )
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', handle: 'ada' })
    )
  })

  it('finishes login when they click the link without pressing Enter', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    m.waitForEnter.mockImplementation(
      (_prompt: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false))
        })
    )

    await login()

    expect(m.openBrowser).not.toHaveBeenCalled()
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', handle: 'ada' })
    )
    expect(m.order.at(-1)).toBe('log:signed in as @ada')
  })

  it('falls back to the plain verification URI when the server omits the complete one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/cli/device/start')
          ? jsonResponse({ ...START, verificationUriComplete: null })
          : jsonResponse({
              status: 'approved',
              token: 'tok',
              email: 'a@b.co',
              handle: 'ada',
            })
      )
    )

    await login()

    expect(m.openBrowser).toHaveBeenCalledWith('https://hacklab.so/cli/login')
  })

  it('polls with the device code alone', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/api/cli/device/start')
        ? jsonResponse(START)
        : jsonResponse({
            status: 'approved',
            token: 'tok',
            email: 'a@b.co',
            handle: 'ada',
            usernameClaimed: true,
          })
    )
    vi.stubGlobal('fetch', fetchMock)

    await login()

    const poll = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/cli/device/poll')
    )
    expect(poll).toBeDefined()
    expect(
      JSON.parse(String((poll?.[1] as RequestInit | undefined)?.body))
    ).toEqual({ deviceCode: 'dev-code' })
  })

  it('uses the login field when the poll sends no handle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/cli/device/start')
          ? jsonResponse(START)
          : jsonResponse({
              status: 'approved',
              token: 'tok',
              email: 'a@b.co',
              login: 'mattbratos',
            })
      )
    )

    await login()

    expect(m.order).toContain('log:signed in as @mattbratos')
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'mattbratos' })
    )
  })

  it('tells the claim it came from bare login, not setup', async () => {
    // The web branches its onboarding copy on this: `login` means no terminal
    // flow is running, so it prints the manual agent prompt.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/api/cli/device/start')
        ? jsonResponse(START)
        : String(url).includes('/api/cli/claim')
          ? jsonResponse({ handle: 'ada' })
          : jsonResponse({
              status: 'approved',
              token: 'tok',
              email: 'a@b.co',
              handle: 'ada',
              usernameClaimed: false,
            })
    )
    vi.stubGlobal('fetch', fetchMock)

    await login()

    const claim = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/cli/claim')
    )
    expect(claim).toBeDefined()
    expect(
      JSON.parse(String((claim?.[1] as RequestInit | undefined)?.body))
    ).toEqual({ username: 'ada', flow: 'login' })
  })

  it('resolves the handle from the profile when poll omits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/api/cli/device/start')) return jsonResponse(START)
        if (u.includes('/api/hackers/me')) {
          return jsonResponse({ handle: 'mattbratos', claimed: true })
        }
        return jsonResponse({
          status: 'approved',
          token: 'tok',
          email: 'a@b.co',
        })
      })
    )

    await login()

    expect(m.order).toContain('log:signed in as @mattbratos')
  })
})
