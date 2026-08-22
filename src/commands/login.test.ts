import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  waitForEnter: vi.fn(),
  openBrowser: vi.fn(),
  saveSession: vi.fn(),
  order: [] as string[],
}))

vi.mock('../session.js', () => ({
  getAppUrl: () => 'https://hacklab.so',
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
  verificationUri: 'https://github.com/login/device',
  verificationUriComplete:
    'https://github.com/login/device?user_code=WDJB-MJHT',
  expiresIn: 900,
  interval: 5,
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('login — device flow', () => {
  it('shows the code first, then waits for Enter before opening GitHub', async () => {
    await login()

    expect(m.order).toEqual([
      'log:copy code',
      'log:',
      'log:WDJB-MJHT',
      'log:',
      'log:https://github.com/login/device',
      'enter:(press enter)',
      'open:https://github.com/login/device?user_code=WDJB-MJHT',
      'log:',
      'log:signed in as @ada',
    ])
  })

  it('still opens the browser when stdin is non-interactive', async () => {
    m.waitForEnter.mockImplementation(async () => {
      m.order.push('enter:skipped')
      return false
    })

    await login()

    expect(m.order).toContain(
      'open:https://github.com/login/device?user_code=WDJB-MJHT'
    )
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', handle: 'ada' })
    )
  })

  it('falls back to the plain verification URI when GitHub omits the complete one', async () => {
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

    expect(m.openBrowser).toHaveBeenCalledWith(
      'https://github.com/login/device'
    )
  })

  it('uses the GitHub login when the poll has no handle', async () => {
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
