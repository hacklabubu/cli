import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  loadSession: vi.fn(),
  collectToolScans: vi.fn(),
  mergeToolScans: vi.fn(),
  detectCursorUsage: vi.fn(),
  resolveCursorAuth: vi.fn(),
  renderShareCard: vi.fn(),
  promptShareOnX: vi.fn(),
  outro: vi.fn(),
  password: vi.fn(),
}))

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  password: m.password,
  text: vi.fn(),
  outro: m.outro,
  log: { step: vi.fn(), message: vi.fn() },
}))
vi.mock('../session.js', () => ({
  loadSession: m.loadSession,
}))
vi.mock('../scanners/index.js', () => ({
  collectToolScans: m.collectToolScans,
  mergeToolScans: m.mergeToolScans,
  detectCursorUsage: m.detectCursorUsage,
  computeStreaks: () => ({ current: 0, longest: 0 }),
  formatTokens: (n: number) => String(n),
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
vi.mock('../belt.js', () => ({
  beltForTokens: () => ({
    level: 1,
    title: 'pyro',
    beltColor: 'white',
    progressPercent: 0,
  }),
}))
vi.mock('../ui.js', () => ({
  bold: (s: string) => s,
  dim: (s: string) => s,
}))
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn(),
}))

import { scan } from './scan.js'

const CLAUDE_SCAN = { tool: 'claude_code', daily: [], hourly: [], models: {} }

beforeEach(() => {
  vi.clearAllMocks()
  m.collectToolScans.mockResolvedValue([CLAUDE_SCAN])
  m.mergeToolScans.mockReturnValue({
    grandTotal: 100,
    toolTotals: { claude_code: 100 },
    dailyTotals: [{ date: '2026-06-20', tool: 'claude_code', tokens: 100 }],
    hourlyTotals: [],
    modelTotals: { 'claude-sonnet': 100 },
    cursorStats: null,
    cursorScanStatus: { source: 'none' },
  })
  m.detectCursorUsage.mockResolvedValue(false)
  m.resolveCursorAuth.mockResolvedValue({
    apiKeySource: 'none',
    emailSource: 'none',
  })
  m.renderShareCard.mockResolvedValue('/tmp/hacklab-card.png')
  m.loadSession.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scan', () => {
  it('renders the card after a local scan', async () => {
    await scan()

    expect(m.collectToolScans).toHaveBeenCalled()
    expect(m.renderShareCard).toHaveBeenCalledOnce()
    expect(m.renderShareCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ handle: 'hacker', tokensTotal: 100 })
    )
    expect(m.promptShareOnX).not.toHaveBeenCalled()
    expect(m.outro).toHaveBeenCalled()
  })

  it('puts the session handle on the card and offers to share', async () => {
    m.loadSession.mockResolvedValue({
      token: 't',
      email: 'me@example.com',
      handle: 'mattbratos',
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await scan()

    expect(m.renderShareCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ handle: 'mattbratos' })
    )
    expect(m.promptShareOnX).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'mattbratos' }),
      '/tmp/hacklab-card.png'
    )
  })

  it('does not ask for a cursor key on a non-Cursor machine', async () => {
    await scan()
    expect(m.password).not.toHaveBeenCalled()
  })
})
