import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `setup` is the front door, so these tests drive the whole flow with the
// network mocked and assert the order it happens in: the anonymous rank preview
// must land BEFORE any auth, the handle claim must not be lost in silence, and
// nothing conversation-derived may reach /api/claim/sync without a yes.
//
// Deliberately NOT mocked: ./login.js (the device flow is reused, not
// reimplemented — these tests exercise the real device/start → poll → claim) and
// uploadTokenScan (so the actual upload body is what gets asserted).

const m = vi.hoisted(() => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  collectToolScans: vi.fn(),
  mergeToolScans: vi.fn(),
  rebuildScanState: vi.fn(),
  scanConsentedPromptStats: vi.fn(),
  loadPromptConsent: vi.fn(),
  savePromptConsent: vi.fn(),
  dailySyncState: vi.fn(),
  installDailySync: vi.fn(),
  captureEvent: vi.fn(),
  identifyUser: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  waitForEnter: vi.fn(),
  bareEnter: vi.fn(),
  spawnSync: vi.fn(),
  openBrowser: vi.fn(),
  logs: [] as string[],
  errors: [] as string[],
}))

vi.mock('@clack/prompts', () => ({
  intro: m.intro,
  outro: m.outro,
  cancel: m.cancel,
  note: vi.fn(),
  confirm: m.confirm,
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  text: vi.fn(),
  password: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), error: vi.fn(), message: vi.fn() },
}))
vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return { ...actual, loadSession: m.loadSession, saveSession: m.saveSession }
})
vi.mock('../posthog.js', () => ({
  captureEvent: m.captureEvent,
  identifyUser: m.identifyUser,
  captureException: vi.fn(),
}))
// Never touch the real OS scheduler (launchd/systemd/schtasks) from a test.
vi.mock('../daily-sync.js', () => ({
  dailySyncState: m.dailySyncState,
  installDailySync: m.installDailySync,
  clearSyncPaused: vi.fn(),
  markSyncPaused: vi.fn(),
  readSyncPaused: vi.fn(),
  appendSyncLog: vi.fn(),
  trimSyncLog: vi.fn(),
}))
vi.mock('../prompt-consent.js', () => ({
  loadPromptConsent: m.loadPromptConsent,
  savePromptConsent: m.savePromptConsent,
}))
vi.mock('../scanners/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scanners/index.js')>()
  return {
    ...actual,
    collectToolScans: m.collectToolScans,
    mergeToolScans: m.mergeToolScans,
  }
})
vi.mock('../scanners/incremental.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../scanners/incremental.js')>()
  return { ...actual, rebuildScanState: m.rebuildScanState }
})
vi.mock('../sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync.js')>()
  return { ...actual, scanConsentedPromptStats: m.scanConsentedPromptStats }
})
vi.mock('../ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui.js')>()
  return { ...actual, bold: (s: string) => s, dim: (s: string) => s }
})
vi.mock('../utils/openBrowser.js', () => ({ openBrowser: m.openBrowser }))
vi.mock('../utils/waitForEnter.js', () => ({
  waitForEnter: m.waitForEnter,
  waitForBareEnter: m.bareEnter,
}))
// Only the handoff launch is faked — agent *detection* runs for real against a
// PATH pointed at a temp bin dir, so the probe itself is under test.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: m.spawnSync }
})

import { PROFILE_SETUP_PROMPT } from './rtfm.js'
import { setup } from './setup.js'

const START = {
  deviceCode: 'dev-code',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  verificationUriComplete:
    'https://github.com/login/device?user_code=WDJB-MJHT',
  expiresIn: 900,
  interval: 5,
}

const SCAN = {
  grandTotal: 1_000,
  toolTotals: { claude_code: 1_000 },
  modelsByTool: { claude_code: { 'claude-sonnet-4': 1_000 } },
  dailyTotals: [{ date: '2026-08-20', tool: 'claude_code', tokens: 1_000 }],
  hourlyTotals: [],
  modelTotals: { 'claude-sonnet-4': 1_000 },
  cursorStats: null,
  cursorScanStatus: { source: 'none' },
}

const EMPTY_SCAN = {
  ...SCAN,
  grandTotal: 0,
  toolTotals: {},
  modelsByTool: {},
  dailyTotals: [],
  modelTotals: {},
}

const PROMPT_STATS = {
  totalPrompts: 12,
  bucketMax: 40,
  histogram: [],
  projects: [],
  conversationSample: 'a sample of my own prompts',
}

const CLAIMED_SESSION = {
  token: 't',
  email: 'ada@example.com',
  handle: 'ada',
  usernameClaimed: true,
  appUrl: 'https://hacklab.so',
  savedAt: '2026-08-20T00:00:00.000Z',
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

function failResponse(status: number) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: 'nope' }),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
let claimResponder: () => Response
let handoffResponder: () => Response

// Agent detection reads PATH, so the tests own it: an empty temp dir means "no
// agent installed", and `installAgents` drops executables into it in the shape
// the probe looks for on this platform.
let binDir: string
const originalPath = process.env.PATH

function installAgents(...bins: string[]) {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  for (const bin of bins) {
    writeFileSync(join(binDir, `${bin}${ext}`), '', { mode: 0o755 })
  }
}

/** The binary the flow handed the terminal to, or undefined if it launched none. */
const launchedBin = () => m.spawnSync.mock.calls[0]?.[0] as string | undefined

const handoffCalls = () => callsTo('/api/cli/agent-handoff')
const handoffBody = () =>
  JSON.parse(String((handoffCalls()[0]?.[1] as RequestInit | undefined)?.body))

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]))
const callIndex = (fragment: string) =>
  urls().findIndex((u) => u.includes(fragment))
const callsTo = (fragment: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment))
const uploadBody = () => {
  const call = callsTo('/api/claim/sync')[0]
  return JSON.parse(
    String((call?.[1] as RequestInit | undefined)?.body ?? '{}')
  )
}

const originalIsTTY = process.stdin.isTTY

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
}

beforeEach(async () => {
  vi.clearAllMocks()
  m.logs.length = 0
  m.errors.length = 0
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    m.logs.push(String(msg ?? ''))
  })
  vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
    m.errors.push(String(msg ?? ''))
  })

  // Keep the machine id (written on the first upload) out of the real $HOME.
  const dir = await mkdtemp(join(tmpdir(), 'hacklab-setup-'))
  process.env.HACKLAB_MACHINE_PATH = join(dir, 'machine.json')
  delete process.env.HACKLAB_APP_URL

  binDir = await mkdtemp(join(tmpdir(), 'hacklab-bin-'))
  process.env.PATH = binDir

  setTTY(true)
  m.loadSession.mockResolvedValue(null)
  m.saveSession.mockResolvedValue(undefined)
  m.collectToolScans.mockResolvedValue([{ tool: 'claude_code' }])
  m.mergeToolScans.mockReturnValue(SCAN)
  m.rebuildScanState.mockResolvedValue(undefined)
  m.loadPromptConsent.mockResolvedValue(null)
  m.savePromptConsent.mockResolvedValue(undefined)
  m.scanConsentedPromptStats.mockImplementation(async (tier: string) =>
    tier === 'full' ? PROMPT_STATS : null
  )
  m.dailySyncState.mockResolvedValue('missing')
  m.installDailySync.mockResolvedValue({
    ok: true,
    recorded: true,
    mechanism: 'launchd',
  })
  m.confirm.mockResolvedValue(true)
  m.waitForEnter.mockResolvedValue(false)
  m.bareEnter.mockResolvedValue(false)
  m.spawnSync.mockReturnValue({ status: 0 })
  m.openBrowser.mockResolvedValue(true)

  claimResponder = () => jsonResponse({ handle: 'ada' })
  handoffResponder = () => jsonResponse({})

  fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/cli/agent-handoff')) return handoffResponder()
    if (u.includes('/api/cli/device/start')) return jsonResponse(START)
    if (u.includes('/api/cli/device/poll')) {
      return jsonResponse({
        status: 'approved',
        token: 't',
        email: 'ada@example.com',
        login: 'ada',
        usernameClaimed: false,
      })
    }
    if (u.includes('/api/cli/claim')) return claimResponder()
    if (u.includes('/api/rank/preview')) {
      return jsonResponse({ rank: 7, ofTotal: 420 })
    }
    if (u.includes('/api/claim/sync')) {
      return jsonResponse({ rankAfter: 7, tokensTotal: 1_000, level: 2 })
    }
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  setTTY(originalIsTTY as boolean)
  process.env.PATH = originalPath
  delete process.env.HACKLAB_MACHINE_PATH
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('setup — happy path', () => {
  it('previews the rank anonymously before auth, then claims and uploads', async () => {
    await setup()

    // Value first: the rank preview goes out before the device flow starts, and
    // carries no credentials.
    expect(callIndex('/api/rank/preview')).toBeGreaterThanOrEqual(0)
    expect(callIndex('/api/rank/preview')).toBeLessThan(
      callIndex('/api/cli/device/start')
    )
    const preview = callsTo('/api/rank/preview')[0]?.[1] as RequestInit
    expect(
      (preview.headers as Record<string, string>).Authorization
    ).toBeUndefined()
    expect(JSON.parse(String(preview.body))).toEqual({ totalTokens: 1_000 })

    // The reused device flow, in order.
    expect(callIndex('/api/cli/device/start')).toBeLessThan(
      callIndex('/api/cli/device/poll')
    )
    expect(callIndex('/api/cli/device/poll')).toBeLessThan(
      callIndex('/api/cli/claim')
    )
    expect(callIndex('/api/cli/claim')).toBeLessThan(
      callIndex('/api/claim/sync')
    )
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'ada', usernameClaimed: true })
    )

    // Consented, so the conversation sample rides along on the upload.
    expect(m.savePromptConsent).toHaveBeenCalledWith('full')
    expect(uploadBody().promptStats).toEqual(PROMPT_STATS)

    expect(m.logs.join('\n')).toContain("you'd be #7 of 420 hackers")
    expect(m.logs.join('\n')).toContain("you're in — https://hacklab.so/ada")
    expect(m.outro).toHaveBeenCalledWith(
      'head back to your browser — the page will move on by itself'
    )
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_setup_completed', {
      tokens_total: 1_000,
      rank: 7,
      prompt_consent: 'full',
    })
  })

  it('installs the background sync silently and tags the source', async () => {
    await setup()

    expect(m.installDailySync).toHaveBeenCalledOnce()
    expect(m.captureEvent).toHaveBeenCalledWith(
      'ada',
      'cli_daily_sync_installed',
      { mechanism: 'launchd', source: 'setup' }
    )
    // Announced, never asked about — the intro line is the whole disclosure.
    expect(m.logs.join('\n')).toContain('background sync scheduled (launchd)')
    expect(m.confirm).toHaveBeenCalledOnce() // the consent question, nothing else
  })

  it('leaves the schedule alone when it is already current', async () => {
    // 'current' with a half-finished account: the guard must not fire, but the
    // scheduler must not be rewritten either (a reinstall bounces the jobs).
    m.dailySyncState.mockResolvedValue('current')

    await setup()

    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(callIndex('/api/claim/sync')).toBeGreaterThanOrEqual(0)
  })
})

describe('setup — handle claim', () => {
  it('retries the claim once and surfaces a visible error when it never lands', async () => {
    // The web onboarding UI polls `username_claimed` and hangs forever if the
    // claim is lost, so setup may not swallow this the way bare `login` does.
    claimResponder = () => failResponse(500)

    await setup()

    expect(callsTo('/api/cli/claim')).toHaveLength(2)
    const said = [...m.logs, ...m.errors].join('\n')
    expect(said).toContain("couldn't finish claiming your handle")
    expect(said).toContain('hacklab login')
  })

  it('claims a session that was already authenticated but never claimed', async () => {
    m.loadSession.mockResolvedValue({
      ...CLAIMED_SESSION,
      handle: 'ada',
      usernameClaimed: false,
    })

    await setup()

    // Reuses the saved token — no second trip through GitHub.
    expect(callIndex('/api/cli/device/start')).toBe(-1)
    expect(callsTo('/api/cli/claim')).toHaveLength(1)
    expect(m.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'ada', usernameClaimed: true })
    )
  })
})

describe('setup — conversation sharing consent', () => {
  it('asks with a yes default and uploads nothing conversational on a no', async () => {
    m.confirm.mockResolvedValue(false)

    await setup()

    expect(m.confirm).toHaveBeenCalledWith({
      message: 'share a sample of your prompts?',
      initialValue: true,
    })
    expect(m.savePromptConsent).toHaveBeenCalledWith('none')
    expect(uploadBody().promptStats).toBeUndefined()
  })

  it('never default-yeses without a human — a non-TTY run stays at none', async () => {
    setTTY(false)

    await setup()

    expect(m.confirm).not.toHaveBeenCalled()
    // Unanswered, not answered: nothing is written to the config either.
    expect(m.savePromptConsent).not.toHaveBeenCalled()
    expect(uploadBody().promptStats).toBeUndefined()
    expect(m.captureEvent).toHaveBeenCalledWith(
      'ada',
      'cli_setup_completed',
      expect.objectContaining({ prompt_consent: 'none' })
    )
  })

  it('skips the question entirely when consent is already on file', async () => {
    m.loadPromptConsent.mockResolvedValue('stats')

    await setup()

    expect(m.confirm).not.toHaveBeenCalled()
    expect(m.savePromptConsent).not.toHaveBeenCalled()
    expect(m.logs.join('\n')).toContain('conversation sharing: stats')
  })
})

// The last beat of setup hands the profile work to a coding agent the user
// already has. Two rules the tests pin down: a launched agent is announced to
// nobody but the user (its own `hacklab ping` is the success signal), and every
// path where no agent runs tells the backend, because the web onboarding is
// waiting on that to show the manual prompt instead.
describe('setup — agent handoff', () => {
  // Which agent the flow picks and announces. The argv it is launched with is
  // platform-shaped, so that lives in agent-handoff.test.ts where
  // `process.platform` is stubbed both ways.
  it('takes the first agent on PATH, in table order', async () => {
    installAgents('grok', 'codex', 'claude')
    m.bareEnter.mockResolvedValue(true)

    await setup()

    expect(launchedBin()).toBe('claude')
    expect(m.logs.join('\n')).toContain('found Claude Code')
  })

  it('falls through to the next agent when the first is missing', async () => {
    installAgents('grok', 'codex')
    m.bareEnter.mockResolvedValue(true)

    await setup()

    expect(launchedBin()).toBe('codex')
    expect(m.logs.join('\n')).toContain('found Codex')
  })

  it('launches interactively on enter and never notifies the backend', async () => {
    installAgents('claude')
    m.bareEnter.mockResolvedValue(true)
    // The browser line has to be printed BEFORE the agent owns the terminal —
    // afterwards nobody is reading our output.
    let logsAtSpawn: string[] = []
    m.spawnSync.mockImplementation(() => {
      logsAtSpawn = [...m.logs]
      return { status: 0 }
    })

    await setup()

    expect(logsAtSpawn.join('\n')).toContain('head back to your browser')
    expect(handoffCalls()).toHaveLength(0)
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_agent_handoff', {
      agent: 'claude',
      outcome: 'launched',
    })
  })

  it('notifies `declined` and prints the prompt to paste when skipped', async () => {
    installAgents('claude')
    m.bareEnter.mockResolvedValue(false)

    await setup()

    expect(m.spawnSync).not.toHaveBeenCalled()
    expect(handoffBody()).toEqual({ outcome: 'declined' })
    const req = handoffCalls()[0]?.[1] as RequestInit
    expect((req.headers as Record<string, string>).Authorization).toBe(
      'Bearer t'
    )
    expect(m.logs.join('\n')).toContain(PROFILE_SETUP_PROMPT)
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_agent_handoff', {
      agent: 'claude',
      outcome: 'declined',
    })
  })

  it('notifies `unavailable` when no agent is installed', async () => {
    await setup()

    expect(m.bareEnter).not.toHaveBeenCalled()
    expect(handoffBody()).toEqual({ outcome: 'unavailable' })
    expect(m.logs.join('\n')).toContain(PROFILE_SETUP_PROMPT)
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_agent_handoff', {
      outcome: 'unavailable',
    })
  })

  it('treats an agent that will not start as unavailable', async () => {
    installAgents('claude')
    m.bareEnter.mockResolvedValue(true)
    m.spawnSync.mockReturnValue({ error: new Error('spawn ENOENT') })

    await setup()

    expect(handoffBody()).toEqual({ outcome: 'unavailable' })
    expect(m.logs.join('\n')).toContain("couldn't start Claude Code")
    expect(m.logs.join('\n')).toContain(PROFILE_SETUP_PROMPT)
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_agent_handoff', {
      agent: 'claude',
      outcome: 'spawn_failed',
    })
  })

  it('never offers a handoff without a human — a non-TTY run just notifies', async () => {
    installAgents('claude')
    setTTY(false)

    await setup()

    expect(m.bareEnter).not.toHaveBeenCalled()
    expect(m.spawnSync).not.toHaveBeenCalled()
    expect(handoffBody()).toEqual({ outcome: 'unavailable' })
    // Nothing to paste into: there is nobody at the terminal.
    expect(m.logs.join('\n')).not.toContain(PROFILE_SETUP_PROMPT)
  })

  it('shrugs off a backend that has no such route yet', async () => {
    handoffResponder = () => failResponse(404)

    await setup()

    expect(m.outro).toHaveBeenCalledWith(
      'head back to your browser — the page will move on by itself'
    )
    expect(m.captureEvent).toHaveBeenCalledWith('ada', 'cli_agent_handoff', {
      outcome: 'unavailable',
    })
  })

  it('shrugs off a network failure on the notification', async () => {
    handoffResponder = () => {
      throw new Error('offline')
    }

    await setup()

    expect(m.outro).toHaveBeenCalledWith(
      'head back to your browser — the page will move on by itself'
    )
    expect(m.captureEvent).toHaveBeenCalledWith(
      'ada',
      'cli_setup_completed',
      expect.anything()
    )
  })
})

describe('setup — guards and edge cases', () => {
  it('short-circuits when the account is finished and the daemon is live', async () => {
    m.loadSession.mockResolvedValue(CLAIMED_SESSION)
    m.dailySyncState.mockResolvedValue('current')

    await setup()

    expect(m.collectToolScans).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(m.installDailySync).not.toHaveBeenCalled()
    expect(m.logs.join('\n')).toContain("already set up — you're @ada")
    expect(m.logs.join('\n')).toContain('hacklab scan')
    expect(m.outro).toHaveBeenCalledWith('https://hacklab.so/ada')
  })

  it('offers to continue on an empty scan, defaulting to yes', async () => {
    m.mergeToolScans.mockReturnValue(EMPTY_SCAN)

    await setup()

    expect(m.confirm).toHaveBeenNthCalledWith(1, {
      message: 'No AI usage found on this machine. Set up your account anyway?',
      initialValue: true,
    })
    // Nothing to rank, so the preview is skipped — but the account is still made.
    expect(callIndex('/api/rank/preview')).toBe(-1)
    expect(callIndex('/api/cli/claim')).toBeGreaterThanOrEqual(0)
  })

  it('stops politely when an empty-scan user declines', async () => {
    m.mergeToolScans.mockReturnValue(EMPTY_SCAN)
    m.confirm.mockResolvedValue(false)

    await setup()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(m.outro).toHaveBeenCalledWith(
      'come back after some Claude Code / Codex / Cursor sessions.'
    )
  })

  it('keeps a failed upload non-fatal', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/cli/device/start')) return jsonResponse(START)
      if (u.includes('/api/cli/device/poll')) {
        return jsonResponse({
          status: 'approved',
          token: 't',
          email: 'ada@example.com',
          login: 'ada',
          usernameClaimed: true,
        })
      }
      if (u.includes('/api/claim/sync')) return failResponse(503)
      return jsonResponse({ rank: 7, ofTotal: 420 })
    })

    await setup()

    expect(m.logs.join('\n')).toContain('run `hacklab sync` later')
    // The account still exists, so the tail and the daemon still happen.
    expect(m.installDailySync).toHaveBeenCalledOnce()
    expect(m.logs.join('\n')).toContain("you're in — https://hacklab.so/ada")
    // No real rank came back, so the anonymous preview is what we report.
    expect(m.captureEvent).toHaveBeenCalledWith(
      'ada',
      'cli_setup_completed',
      expect.objectContaining({ rank: 7 })
    )
  })
})
