import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// join() is a fully interactive command, so this drives it with every collaborator
// mocked, and asserts the behavior that matters here: when the GitHub account
// already owns a *claimed* profile (login set session.handle + usernameClaimed),
// join must log in WITHOUT claiming — i.e. it must never POST /api/cli/claim (the
// rename/hijack path). But an auto-created, *unclaimed* profile (handle but
// usernameClaimed=false) must fall through to claim + upload.

const m = vi.hoisted(() => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  login: vi.fn(),
  collectToolScans: vi.fn(),
  mergeToolScans: vi.fn(),
  rescanCursorWithApi: vi.fn(),
  detectCursorUsage: vi.fn(),
  resolveCursorAuth: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  syncGithubRepos: vi.fn(),
  uploadTokenScan: vi.fn(),
  chat: vi.fn(),
  renderShareCard: vi.fn(),
  promptShareOnX: vi.fn(),
  installDailySync: vi.fn(),
  info: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}))

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: m.outro,
  note: m.note,
  cancel: vi.fn(),
  confirm: m.confirm,
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  text: m.text,
  password: m.password,
  log: { success: vi.fn(), info: vi.fn() },
}))
vi.mock('../session.js', () => ({
  getAppUrl: () => 'https://hacklab.so',
  resolveAppUrl: (session?: { appUrl?: string } | null) =>
    session?.appUrl ?? 'https://hacklab.so',
  loadSession: m.loadSession,
  saveSession: m.saveSession,
}))
vi.mock('./login.js', () => ({ login: m.login }))
vi.mock('./chat.js', () => ({ chat: m.chat }))
// Never touch the real OS scheduler (launchd/systemd/schtasks) from a test.
vi.mock('../daily-sync.js', () => ({ installDailySync: m.installDailySync }))
vi.mock('../sync.js', () => ({
  syncGithubRepos: m.syncGithubRepos,
  uploadTokenScan: m.uploadTokenScan,
}))
vi.mock('../scanners/index.js', () => ({
  collectToolScans: m.collectToolScans,
  mergeToolScans: m.mergeToolScans,
  rescanCursorWithApi: m.rescanCursorWithApi,
  detectCursorUsage: m.detectCursorUsage,
  computeStreaks: () => ({ current: 0, longest: 0 }),
  formatTokens: (n: number) => String(n),
}))
vi.mock('../config.js', () => ({
  resolveCursorAuth: m.resolveCursorAuth,
  loadConfig: m.loadConfig,
  saveConfig: m.saveConfig,
}))
vi.mock('../share.js', () => ({
  promptShareOnX: m.promptShareOnX,
  renderShareCard: m.renderShareCard,
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
  info: m.info,
}))

import { join } from './join.js'

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

let fetchMock: ReturnType<typeof vi.fn>
const calledClaim = () =>
  fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/cli/claim'))

const CLAUDE_SCAN = { tool: 'claude_code', daily: [], hourly: [], models: {} }

beforeEach(() => {
  vi.clearAllMocks()
  m.installDailySync.mockResolvedValue({
    ok: false,
    mechanism: 'unsupported',
    instructions: '',
  })
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
  // Default: not a Cursor machine, so the key prompt stays out of the way of
  // every test that isn't about it.
  m.detectCursorUsage.mockResolvedValue(false)
  m.resolveCursorAuth.mockResolvedValue({
    apiKeySource: 'none',
    emailSource: 'none',
  })
  m.loadConfig.mockResolvedValue({})
  m.saveConfig.mockResolvedValue(undefined)
  m.text.mockResolvedValue('newname')
  m.login.mockResolvedValue(undefined)
  m.saveSession.mockResolvedValue(undefined)
  m.syncGithubRepos.mockResolvedValue({ synced: 0 })
  m.uploadTokenScan.mockResolvedValue({})
  m.renderShareCard.mockResolvedValue('/tmp/hacklab-card.png')
  m.confirm.mockResolvedValue(false)

  fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/rank/preview'))
      return jsonResponse({ rank: 1, ofTotal: 10 })
    if (u.includes('/username-available'))
      return jsonResponse({ available: true })
    if (u.includes('/api/cli/claim'))
      return jsonResponse({ handle: 'newname', profileUrl: '/newname' })
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('join — existing GitHub account', () => {
  it('logs in without claiming when the account already has a handle', async () => {
    // loadSession is called twice: the top-of-join guard (not logged in yet ->
    // null, so the flow proceeds) and again after login resolves the existing
    // GitHub account to its profile.
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'owner@example.com',
      handle: 'existing-owner',
      usernameClaimed: true,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    // The rename hole: join must NOT claim for an already-linked account.
    expect(calledClaim()).toBe(false)
    // It messages "welcome back" and doesn't run the join tail.
    expect(
      m.note.mock.calls.some((c) =>
        String(c[0]).includes('already has a hacklab account')
      )
    ).toBe(true)
    expect(m.syncGithubRepos).not.toHaveBeenCalled()
    expect(m.chat).not.toHaveBeenCalled()
  })

  it('still claims for a brand-new account (no handle on the session)', async () => {
    // Not logged in at the start (guard passes), then a fresh signup after login.
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(calledClaim()).toBe(true)
    // The claimed handle is written back so the session reflects a finished
    // account (what the logged-in guard keys off).
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'newname' })
    )
    expect(m.chat).not.toHaveBeenCalled()
  })

  it('asks only for the username before claiming', async () => {
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.text).toHaveBeenCalledTimes(1)
    expect(m.confirm).not.toHaveBeenCalled()
    const claimCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/cli/claim')
    )
    expect(JSON.parse(String(claimCall?.[1]?.body))).toEqual({
      username: 'newname',
    })
  })

  it('shows the card before offering the single X share action', async () => {
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.renderShareCard).toHaveBeenCalledOnce()
    const card = m.renderShareCard.mock.calls[0]?.[0]
    expect(m.promptShareOnX).toHaveBeenCalledWith(card, '/tmp/hacklab-card.png')
    expect(m.uploadTokenScan.mock.invocationCallOrder[0]).toBeLessThan(
      m.renderShareCard.mock.invocationCallOrder[0] ?? 0
    )
    expect(m.syncGithubRepos.mock.invocationCallOrder[0]).toBeLessThan(
      m.renderShareCard.mock.invocationCallOrder[0] ?? 0
    )
    expect(m.renderShareCard.mock.invocationCallOrder[0]).toBeLessThan(
      m.promptShareOnX.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('shows the account-wide total from the upload, not the local scan', async () => {
    // The upload response carries the server's account-wide figure (all
    // machines, full history) — join must surface that one, so it never
    // disagrees with what `hacklab sync` reports for the same account.
    m.uploadTokenScan.mockResolvedValue({
      title: 'pyro',
      level: 2,
      beltColor: 'blue',
      rankAfter: 3,
      tokensTotal: 5000,
    })
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(
      m.info.mock.calls.some((c) => String(c[0]).includes('5000 total'))
    ).toBe(true)
    const card = m.renderShareCard.mock.calls[0]?.[0]
    expect(card.tokensTotal).toBe(5000)
    expect(card.level).toBe(2)
    expect(card.title).toBe('pyro')
    expect(card.beltColor).toBe('blue')
  })

  it('falls back to the local scan total when the upload fails', async () => {
    m.uploadTokenScan.mockRejectedValue(new Error('server down'))
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    // scan.grandTotal from the mocked merge — the join still completes and the
    // card still renders with the machine-local number.
    const card = m.renderShareCard.mock.calls[0]?.[0]
    expect(card.tokensTotal).toBe(100)
  })

  it('still shows the card when a zero-token user chooses to continue', async () => {
    m.mergeToolScans.mockReturnValue({
      grandTotal: 0,
      toolTotals: {},
      dailyTotals: [],
      hourlyTotals: [],
      modelTotals: {},
      cursorStats: null,
      cursorScanStatus: { source: 'none' },
    })
    m.confirm.mockResolvedValue(true)
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.renderShareCard).toHaveBeenCalledOnce()
    expect(m.promptShareOnX).toHaveBeenCalledOnce()
  })

  it('does not put a discovery section on the join tail', async () => {
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.note.mock.calls.some((c) => c[1] === 'discovery')).toBe(false)
    expect(
      m.note.mock.calls.some((c) => String(c[0]).includes('get discovered'))
    ).toBe(false)
  })

  it('does NOT show the join tail to an already-claimed account', async () => {
    // The already-claimed path short-circuits at Stage 4: nothing new became
    // a profile, so the next block would be noise on every `join`.
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'owner@example.com',
      handle: 'existing-owner',
      usernameClaimed: true,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.note.mock.calls.some((c) => c[1] === 'next')).toBe(false)
    expect(m.note.mock.calls.some((c) => c[1] === 'discovery')).toBe(false)
  })

  it('claims + uploads for an auto-created but UNCLAIMED profile (handle, usernameClaimed=false)', async () => {
    // Regression: a profile auto-created on first auth carries a GitHub-derived
    // handle but has never claimed a username (usernameClaimed=false). join used
    // to short-circuit on handle presence alone — logging the user in, silently
    // dropping the username they typed, and never uploading their scanned tokens.
    // It must now fall through to claim the chosen username AND upload.
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'unclaimed@example.com',
      handle: 'github-derived',
      usernameClaimed: false,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(calledClaim()).toBe(true)
    expect(m.uploadTokenScan).toHaveBeenCalled()
    // The daemon is its own onboarding step now: join must never schedule a
    // background job behind the user's back, only tell them to run it.
    expect(m.installDailySync).not.toHaveBeenCalled()
    // No "welcome back" short-circuit for an unclaimed profile.
    expect(
      m.note.mock.calls.some((c) =>
        String(c[0]).includes('already has a hacklab account')
      )
    ).toBe(false)
    // The claimed handle (+ claimed flag) is persisted so a re-run stops cleanly.
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'newname', usernameClaimed: true })
    )
  })

  it('ends with a single next block: referral link + daemon command', async () => {
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(calledClaim()).toBe(true)
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(m.note.mock.calls.some((c) => c[1] === 'invite your crew')).toBe(
      false
    )
    expect(
      m.note.mock.calls.some((c) => String(c[1]).includes('summon the daemon'))
    ).toBe(false)
    const nextNotes = m.note.mock.calls.filter((c) => c[1] === 'next')
    expect(nextNotes).toHaveLength(1)
    expect(nextNotes[0]?.[0]).toBe(
      'invite your crew\nhttps://hacklab.so/?ref=newname\n\n' +
        'install the daemon — keeps your ai dashboard live\n' +
        '$ hacklab daemon'
    )
    expect(m.outro).toHaveBeenCalledWith(
      'done. return to onboarding for your bio and drop.'
    )
  })

  it('reuses a half-finished authenticated signup without logging in again', async () => {
    // login() writes a session before the claim, so a cancelled/failed claim
    // leaves a token with no handle. Re-running join must let them finish, not
    // treat them as already logged in.
    m.loadSession.mockResolvedValue({
      token: 't',
      email: 'half@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    // Guard passed: it scanned and reached the claim using the saved session.
    expect(m.collectToolScans).toHaveBeenCalled()
    expect(m.login).not.toHaveBeenCalled()
    expect(calledClaim()).toBe(true)
  })

  it('aborts immediately when already logged in — no scan, login, or claim', async () => {
    // A claimed session already exists at the top of join: it must stop right away.
    m.loadSession.mockResolvedValue({
      token: 't',
      email: 'me@example.com',
      handle: 'me',
      usernameClaimed: true,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })

    await join({})

    expect(m.collectToolScans).not.toHaveBeenCalled()
    expect(m.login).not.toHaveBeenCalled()
    expect(calledClaim()).toBe(false)
    expect(m.syncGithubRepos).not.toHaveBeenCalled()
    expect(
      m.note.mock.calls.some((c) => String(c[0]).includes('already logged in'))
    ).toBe(true)
  })
})

describe('join — cursor api key prompt', () => {
  const CURSOR_API_SCAN = [
    {
      tool: 'cursor',
      daily: [],
      hourly: [],
      models: {},
      cursorScanStatus: { source: 'api', events: 42 },
    },
  ]

  beforeEach(() => {
    // Brand-new signup for every case here.
    m.loadSession.mockResolvedValueOnce(null).mockResolvedValue({
      token: 't',
      email: 'new@example.com',
      handle: undefined,
      appUrl: 'https://hacklab.so',
      savedAt: '2026-06-20T00:00:00.000Z',
    })
  })

  it('never asks a non-Cursor user for a key', async () => {
    m.detectCursorUsage.mockResolvedValue(false)

    await join({})

    expect(m.password).not.toHaveBeenCalled()
    expect(m.saveConfig).not.toHaveBeenCalled()
    expect(m.rescanCursorWithApi).not.toHaveBeenCalled()
  })

  it('asks a Cursor user with no key, then saves it and re-scans', async () => {
    m.detectCursorUsage.mockResolvedValue(true)
    m.password.mockResolvedValue('key_abc123')
    m.text.mockResolvedValueOnce('me@team.com') // cursor email prompt
    m.rescanCursorWithApi.mockResolvedValue(CURSOR_API_SCAN)

    await join({})

    expect(m.password).toHaveBeenCalled()
    expect(m.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        cursorApiKey: 'key_abc123',
        cursorEmail: 'me@team.com',
      })
    )
    expect(m.rescanCursorWithApi).toHaveBeenCalled()
    // The re-scanned results are what gets uploaded, not the pre-key scan.
    expect(m.mergeToolScans).toHaveBeenLastCalledWith(CURSOR_API_SCAN)
  })

  it('does not ask when a key already resolves from env or config', async () => {
    m.detectCursorUsage.mockResolvedValue(true)
    m.resolveCursorAuth.mockResolvedValue({
      apiKey: 'already-set',
      apiKeySource: 'env',
      emailSource: 'none',
    })

    await join({})

    expect(m.password).not.toHaveBeenCalled()
    expect(m.saveConfig).not.toHaveBeenCalled()
  })

  it('keeps the local estimate when the user skips the prompt', async () => {
    m.detectCursorUsage.mockResolvedValue(true)
    m.password.mockResolvedValue('') // enter to skip

    await join({})

    expect(m.saveConfig).not.toHaveBeenCalled()
    expect(m.rescanCursorWithApi).not.toHaveBeenCalled()
    // Still joins — a skipped key is not a failed join.
    expect(calledClaim()).toBe(true)
  })

  it('falls back to the local estimate when Cursor rejects the key', async () => {
    // The silent-fallback trap: a bad key must not leave the user believing the
    // uploaded Cursor number is exact.
    m.detectCursorUsage.mockResolvedValue(true)
    m.password.mockResolvedValue('bad-key')
    m.rescanCursorWithApi.mockResolvedValue([
      {
        tool: 'cursor',
        daily: [],
        hourly: [],
        models: {},
        cursorScanStatus: { source: 'api-failed', reason: 'auth 401' },
      },
    ])

    await join({})

    // The pre-key scan stands; the failed re-scan is not merged in.
    expect(m.mergeToolScans).toHaveBeenLastCalledWith([CLAUDE_SCAN])
    expect(calledClaim()).toBe(true)
  })
})
