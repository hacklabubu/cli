import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers the ordering contract of the device-code flow: the user must see the
// code BEFORE anything opens a browser window on them, and the browser only
// opens once they've said they're ready. The rest of login() (session persist,
// analytics) is mocked out — this file is about what the user sees, and when.

const m = vi.hoisted(() => ({
  note: vi.fn(),
  waitForEnter: vi.fn(),
  openBrowser: vi.fn(),
  saveSession: vi.fn(),
  // Every user-visible step appends to this, so assertions read as a script.
  order: [] as string[],
}))

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: m.note,
  cancel: vi.fn(),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { success: vi.fn(), info: vi.fn() },
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
  white: (s: string) => s,
  linkBlue: (s: string) => s,
  info: vi.fn(),
  success: vi.fn(),
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

  m.note.mockImplementation((body: string) => {
    m.order.push(`note:${body.trim()}`)
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
      // First poll approves, so the flow never sleeps on its 5s interval.
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

describe('login — device flow', () => {
  it('shows the code first, then waits for Enter before opening GitHub', async () => {
    await login({ allowSignup: true })

    expect(m.order).toEqual([
      'note:WDJB-MJHT',
      'enter:press Enter to open https://github.com/login/device in your browser',
      'open:https://github.com/login/device?user_code=WDJB-MJHT',
    ])
  })

  it('labels the note as the device code rather than as instructions', async () => {
    await login({ allowSignup: true })

    expect(m.note).toHaveBeenCalledWith(
      expect.stringContaining('WDJB-MJHT'),
      'your github device code',
      expect.anything()
    )
  })

  it('still opens the browser when stdin is non-interactive', async () => {
    // waitForEnter returns false on a non-TTY: the pause is a courtesy, not a
    // gate, so an unattended run must proceed to the browser regardless.
    m.waitForEnter.mockImplementation(async () => {
      m.order.push('enter:skipped')
      return false
    })

    await login({ allowSignup: true })

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

    await login({ allowSignup: true })

    expect(m.openBrowser).toHaveBeenCalledWith(
      'https://github.com/login/device'
    )
  })
})
