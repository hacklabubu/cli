import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `daemon` is the onboarding step that arms the daily background sync, so the
// contract under test is: never touch the real OS scheduler without a session,
// never claim success when nothing got scheduled, and always be able to tear
// the schedule down (session or not).

const m = vi.hoisted(() => ({
  installDailySync: vi.fn(),
  uninstallDailySync: vi.fn(),
  clearSyncPaused: vi.fn(),
  loadSession: vi.fn(),
  captureEvent: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

vi.mock('../daily-sync.js', () => ({
  installDailySync: m.installDailySync,
  uninstallDailySync: m.uninstallDailySync,
  clearSyncPaused: m.clearSyncPaused,
  syncLogPath: () => '/home/ada/.hacklab/sync.log',
}))
vi.mock('../session.js', () => ({ loadSession: m.loadSession }))
vi.mock('../posthog.js', () => ({ captureEvent: m.captureEvent }))
vi.mock('../ui.js', () => ({
  dim: (s: string) => s,
  success: m.success,
  error: m.error,
  info: m.info,
}))

import { daemon } from './daemon.js'

class ExitError extends Error {}

const SESSION = {
  token: 't',
  email: 'ada@example.com',
  handle: 'ada',
  appUrl: 'https://hacklab.so',
  savedAt: '2026-06-20T00:00:00.000Z',
}

const said = (calls: { mock: { calls: unknown[][] } }, needle: string) =>
  calls.mock.calls.some((c) => String(c[0]).includes(needle))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new ExitError('exit')
  })
  m.loadSession.mockResolvedValue(SESSION)
  m.installDailySync.mockResolvedValue({
    ok: true,
    mechanism: 'systemd',
    detail: 'systemd user timer (hacklab-sync.timer)',
  })
  m.uninstallDailySync.mockResolvedValue(undefined)
  m.clearSyncPaused.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hacklab daemon', () => {
  it('installs the daily sync and reports the mechanism', async () => {
    await daemon([])

    expect(m.installDailySync).toHaveBeenCalledOnce()
    expect(said(m.success, 'systemd')).toBe(true)
    expect(said(m.info, 'hacklab-sync.timer')).toBe(true)
    // The log path is where a user goes to see whether the job actually ran.
    expect(said(m.info, '/home/ada/.hacklab/sync.log')).toBe(true)
    expect(m.captureEvent).toHaveBeenCalledWith(
      'ada',
      'cli_daily_sync_installed',
      expect.objectContaining({ mechanism: 'systemd' })
    )
  })

  it('refuses to schedule anything when not logged in', async () => {
    m.loadSession.mockResolvedValue(null)

    await expect(daemon([])).rejects.toBeInstanceOf(ExitError)

    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(said(m.error, 'not logged in')).toBe(true)
    expect(said(m.info, 'hacklab join')).toBe(true)
  })

  it('reports a failure as a failure and prints the manual fallback', async () => {
    // BSD (or a blocked scheduler write): nothing is scheduled, so a success
    // line here would cost the user the streak they think they just secured.
    m.installDailySync.mockResolvedValue({
      ok: false,
      mechanism: 'unsupported',
      instructions: 'schedule this with cron: node cli sync --quiet',
    })

    await daemon([])

    expect(m.success).not.toHaveBeenCalled()
    expect(said(m.error, "couldn't schedule")).toBe(true)
    expect(said(m.info, 'cron')).toBe(true)
  })

  it('tears the schedule down with `off`, no session required', async () => {
    m.loadSession.mockResolvedValue(null)

    await daemon(['off'])

    expect(m.uninstallDailySync).toHaveBeenCalledOnce()
    expect(m.clearSyncPaused).toHaveBeenCalledOnce()
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(said(m.success, 'dismissed')).toBe(true)
  })

  it('accepts the --off spelling too', async () => {
    await daemon(['--off'])

    expect(m.uninstallDailySync).toHaveBeenCalledOnce()
    expect(m.installDailySync).not.toHaveBeenCalled()
  })
})
