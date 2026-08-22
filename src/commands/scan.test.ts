import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  loadSessionState: vi.fn(),
  checkSession: vi.fn(),
  ensureFreshSession: vi.fn(),
  uploadTokenScan: vi.fn(),
  rebuildScanState: vi.fn(),
  collectToolScans: vi.fn(),
  mergeToolScans: vi.fn(),
  detectCursorUsage: vi.fn(),
  resolveCursorAuth: vi.fn(),
  renderShareCard: vi.fn(),
  promptShareOnX: vi.fn(),
  installDailySync: vi.fn(),
  dailySyncInstalled: vi.fn(),
  password: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  logs: [] as string[],
}))

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), clear: vi.fn() }),
  password: m.password,
  text: vi.fn(),
}))
vi.mock('../session.js', () => ({
  loadSessionState: m.loadSessionState,
  resolveAppUrl: (session?: { appUrl?: string }) =>
    session?.appUrl ?? 'https://hacklab.so',
}))
vi.mock('../sync.js', () => ({
  checkSession: m.checkSession,
  ensureFreshSession: m.ensureFreshSession,
  uploadTokenScan: m.uploadTokenScan,
}))
vi.mock('../scanners/incremental.js', () => ({
  rebuildScanState: m.rebuildScanState,
}))
vi.mock('../scanners/index.js', () => ({
  collectToolScans: m.collectToolScans,
  mergeToolScans: m.mergeToolScans,
  detectCursorUsage: m.detectCursorUsage,
  rescanCursorWithApi: vi.fn(),
}))
vi.mock('../config.js', () => ({
  resolveCursorAuth: m.resolveCursorAuth,
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(),
}))
vi.mock('../share.js', () => ({
  renderShareCard: m.renderShareCard,
  promptShareOnX: m.promptShareOnX,
}))
vi.mock('../daily-sync.js', () => ({
  installDailySync: m.installDailySync,
  dailySyncInstalled: m.dailySyncInstalled,
}))
vi.mock('../ui.js', () => ({
  bold: (s: string) => s,
  dim: (s: string) => s,
  link: (s: string) => s,
  error: m.error,
  info: m.info,
}))
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn(),
}))

import { formatScanReceipt, scan } from './scan.js'

class ExitError extends Error {}

const SESSION = {
  token: 't',
  email: 'me@example.com',
  handle: 'mattbratos',
  appUrl: 'https://hacklab.so',
  savedAt: '2026-06-20T00:00:00.000Z',
}

const CLAUDE_SCAN = { tool: 'claude_code', daily: [], hourly: [], models: {} }

const LOCAL_SCAN = {
  grandTotal: 2_400_000_000,
  toolTotals: {
    claude_code: 853_500_000,
    codex: 1_300_000_000,
    cursor: 476_000,
    hermes: 19_700_000,
    grok: 158_200_000,
  },
  dailyTotals: [{ date: '2026-06-20', tool: 'claude_code', tokens: 100 }],
  hourlyTotals: [],
  modelTotals: {
    'gpt-5.3': 502_000_000,
    'gpt-5.0': 120_000_000,
    'claude-sonnet-4-5-20250929': 800_000_000,
    'claude-opus-4-1-20250805': 400_000_000,
  },
  modelsByTool: {
    claude_code: {
      'claude-sonnet-4-5-20250929': 800_000_000,
      'claude-opus-4-1-20250805': 400_000_000,
    },
    codex: {
      'gpt-5.3': 502_000_000,
      'gpt-5.0': 120_000_000,
    },
  },
  cursorStats: null,
  cursorScanStatus: { source: 'none' },
}

const SERVER = {
  level: 12,
  title: 'student',
  beltColor: 'orange',
  tokensTotal: 12_000_000,
  progressPercent: 40,
  rankAfter: 7,
  streak: 4,
  longestStreak: 9,
}

beforeEach(() => {
  vi.clearAllMocks()
  m.logs.length = 0
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new ExitError('exit')
  })
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    m.logs.push(String(msg ?? ''))
  })
  m.loadSessionState.mockResolvedValue({ status: 'ok', session: SESSION })
  m.checkSession.mockResolvedValue({ status: 'ok' })
  m.ensureFreshSession.mockResolvedValue(SESSION)
  m.collectToolScans.mockResolvedValue([CLAUDE_SCAN])
  m.mergeToolScans.mockReturnValue(LOCAL_SCAN)
  m.detectCursorUsage.mockResolvedValue(false)
  m.resolveCursorAuth.mockResolvedValue({
    apiKeySource: 'none',
    emailSource: 'none',
  })
  m.uploadTokenScan.mockResolvedValue(SERVER)
  m.rebuildScanState.mockResolvedValue(undefined)
  m.renderShareCard.mockResolvedValue('/tmp/hacklab-card.png')
  m.dailySyncInstalled.mockResolvedValue(false)
  m.installDailySync.mockResolvedValue({
    ok: true,
    mechanism: 'launchd',
    detail: 'tick every minute',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('formatScanReceipt', () => {
  it('groups models under each tool, biggest tool first', () => {
    expect(formatScanReceipt(LOCAL_SCAN)).toEqual([
      'you burned 2.4B tokens',
      '',
      'codex           1.3B',
      '  gpt-5.3     502.0M',
      '  gpt-5.0     120.0M',
      '',
      'claude        853.5M',
      '  sonnet 4.5  800.0M',
      '  opus 4.1    400.0M',
      '',
      'grok          158.2M',
      '',
      'hermes         19.7M',
      '',
      'cursor          476K',
    ])
  })
})

describe('hacklab scan', () => {
  it('refuses to run without a session', async () => {
    m.loadSessionState.mockResolvedValue({ status: 'missing', session: null })

    await expect(scan()).rejects.toBeInstanceOf(ExitError)

    expect(m.collectToolScans).not.toHaveBeenCalled()
    expect(m.uploadTokenScan).not.toHaveBeenCalled()
    expect(m.renderShareCard).not.toHaveBeenCalled()
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(m.error.mock.calls[0]?.[0]).toMatch(/not logged in/i)
    expect(m.info.mock.calls[0]?.[0]).toMatch(/hacklab login/)
  })

  it('refuses an expired session before scanning', async () => {
    m.loadSessionState.mockResolvedValue({ status: 'expired', session: null })

    await expect(scan()).rejects.toBeInstanceOf(ExitError)

    expect(m.collectToolScans).not.toHaveBeenCalled()
    expect(m.error.mock.calls[0]?.[0]).toMatch(/login expired/i)
  })

  it('prints the receipt, draws the png card, and offers share', async () => {
    await scan()

    expect(m.logs).toEqual([...formatScanReceipt(LOCAL_SCAN), ''])
    expect(m.logs.join('\n')).not.toMatch(/@mattbratos|rank #|https?:\/\//)
    expect(m.uploadTokenScan).toHaveBeenCalledOnce()
    expect(m.uploadTokenScan.mock.calls[0]?.[0]).toEqual(SESSION)
    expect(m.uploadTokenScan.mock.calls[0]?.[1]).toEqual(LOCAL_SCAN)
    expect(m.uploadTokenScan.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ interactive: true })
    )
    expect(m.rebuildScanState).toHaveBeenCalledOnce()
    expect(m.renderShareCard).toHaveBeenCalledOnce()
    expect(m.renderShareCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        handle: 'mattbratos',
        level: 12,
        title: 'student',
        beltColor: 'orange',
        tokensTotal: 12_000_000,
        rank: 7,
        streak: 4,
        longestStreak: 9,
      })
    )
    expect(m.promptShareOnX).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'mattbratos', rank: 7 }),
      '/tmp/hacklab-card.png'
    )
  })

  it('never draws an anonymous @hacker card', async () => {
    await scan()

    const card = m.renderShareCard.mock.calls[0]?.[0] as { handle: string }
    expect(card.handle).not.toBe('hacker')
  })

  it('arms the daemon quietly when it was not scheduled', async () => {
    await scan()

    expect(m.installDailySync).toHaveBeenCalledOnce()
    expect(m.logs).not.toContain('daemon on')
  })

  it('refreshes the daemon silently when it is already scheduled', async () => {
    m.dailySyncInstalled.mockResolvedValue(true)

    await scan()

    expect(m.installDailySync).toHaveBeenCalledOnce()
    expect(m.logs).not.toContain('daemon on')
  })

  it('skips the daemon when --no-daemon is passed', async () => {
    await scan(['--no-daemon'])

    expect(m.uploadTokenScan).toHaveBeenCalledOnce()
    expect(m.renderShareCard).toHaveBeenCalledOnce()
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(m.logs).not.toContain('daemon on')
  })

  it('does not draw a card or arm the daemon when the upload fails', async () => {
    m.uploadTokenScan.mockRejectedValue(new Error('sync failed (500)'))

    await expect(scan()).rejects.toBeInstanceOf(ExitError)

    expect(m.renderShareCard).not.toHaveBeenCalled()
    expect(m.promptShareOnX).not.toHaveBeenCalled()
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(m.error.mock.calls[0]?.[0]).toMatch(/sync failed/)
  })

  it('does not ask for a cursor key on a non-Cursor machine', async () => {
    await scan()
    expect(m.password).not.toHaveBeenCalled()
  })
})
