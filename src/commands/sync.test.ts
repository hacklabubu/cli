import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `sync --tick` runs 1440 times a day on every user's machine, so the contract
// under test is mostly about restraint: don't call the API when there's nothing
// to say, don't re-send what the server already took, don't fill sync.log, and
// don't hammer a server that asked us to stop.

const m = vi.hoisted(() => ({
  uploadTokenScan: vi.fn(),
  loadSessionState: vi.fn(),
  refreshSession: vi.fn(),
  loadPromptSync: vi.fn(),
}))

vi.mock('../sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync.js')>()
  return {
    ...actual,
    uploadTokenScan: m.uploadTokenScan,
    refreshSession: m.refreshSession,
    ensureFreshSession: async (s: unknown) => s,
  }
})
vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return { ...actual, loadSessionState: m.loadSessionState }
})
// Consent lives in ~/.hacklab/config.json, which os.homedir() pins outside the
// tmp dir — so the tier is injected rather than written to the real config.
vi.mock('../prompt-consent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt-consent.js')>()
  return { ...actual, loadPromptSync: m.loadPromptSync }
})
// The state machine itself stays real — it reads and writes the tmp
// scan-state.json — but the tick scans no logs, so what these tests exercise is
// its decisions rather than this machine's own AI transcripts. (Stubbing the
// sources, not $HOME: os.homedir() ignores HOME inside a vitest worker.)
vi.mock('../scanners/incremental.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../scanners/incremental.js')>()
  const noSources = {
    jsonl: [],
    codex: { files: async () => [], dateFor: () => null },
    sqlite: [],
  }
  return {
    ...actual,
    runTick: (prev: Parameters<typeof actual.runTick>[0]) =>
      actual.runTick(prev, noSources),
  }
})

import { appendSyncLog, readSyncPaused, syncLogPath } from '../daily-sync.js'
import {
  emptyState,
  loadScanState,
  saveScanState,
} from '../scanners/incremental.js'
import { LOGIN_EXPIRED_MESSAGE, SyncUploadError } from '../sync.js'
import { sync } from './sync.js'

const SESSION = {
  token: 't',
  email: 'ada@example.com',
  handle: 'ada',
  appUrl: 'https://hacklab.so',
  savedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
}

const today = new Date().toISOString().slice(0, 10)

let dir: string
let sessionPath: string | undefined

/** A state with one outstanding date, as a failed upload would leave it. */
function dirtyState() {
  const state = emptyState()
  state.harnesses.claude_code = {
    files: {},
    daily: { [`${today}|opus`]: { tokens: 500, messages: 2 } },
    models: { opus: 500 },
  }
  state.dirty = [today]
  return state
}

/** A state with one outstanding prompt session and its day, nothing else. */
function promptDirtyState() {
  const state = emptyState()
  const at = new Date().toISOString()
  state.prompts.sessions.s1 = {
    startedAt: at,
    lastActiveAt: at,
    promptCount: 3,
  }
  state.prompts.daily[today] = { prompts: 3, words: 21 }
  state.prompts.dirtySessions = ['s1']
  state.prompts.dirtyDates = [today]
  return state
}

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'hacklab-sync-'))
  // Everything the tick persists (scan-state.json, sync.log, the paused marker)
  // hangs off the session path, so a tmp session path isolates the whole run.
  sessionPath = process.env.HACKLAB_SESSION_PATH
  process.env.HACKLAB_SESSION_PATH = join(dir, 'session.json')
  m.loadSessionState.mockResolvedValue({ status: 'ok', session: SESSION })
  m.uploadTokenScan.mockResolvedValue({ tokensDelta: 500 })
  m.loadPromptSync.mockResolvedValue(null)
})

afterEach(async () => {
  if (sessionPath === undefined) delete process.env.HACKLAB_SESSION_PATH
  else process.env.HACKLAB_SESSION_PATH = sessionPath
  await rm(dir, { recursive: true, force: true })
})

const logLines = async () => {
  try {
    return (await readFile(syncLogPath(), 'utf8')).trim().split('\n')
  } catch {
    return []
  }
}

describe('hacklab sync --tick', () => {
  it('makes no request when nothing changed', async () => {
    await saveScanState(emptyState())

    await sync(['--tick'])

    expect(m.uploadTokenScan).not.toHaveBeenCalled()
    expect(await logLines()).toEqual([])
  })

  it('uploads the dirty dates and clears them on a 200', async () => {
    await saveScanState(dirtyState())

    await sync(['--tick'])

    expect(m.uploadTokenScan).toHaveBeenCalledOnce()
    const scan = m.uploadTokenScan.mock.calls[0]?.[1]
    expect(scan.dailyTotals).toEqual([
      {
        date: today,
        tool: 'claude_code',
        tokens: 500,
        messages: 2,
        model: 'opus',
      },
    ])
    // No prompt stats, and not tagged as user activity.
    expect(m.uploadTokenScan.mock.calls[0]?.[2]).toBeUndefined()

    const state = await loadScanState()
    expect(state?.dirty).toEqual([])
    expect(state?.uploaded.toolTotals.claude_code).toBe(500)
    expect((await logLines()).length).toBe(1)
    expect((await logLines())[0]).toContain('tick: +500 tokens (1 date)')
  })

  it('keeps the dirty dates when the upload fails, and logs it once', async () => {
    await saveScanState(dirtyState())
    m.uploadTokenScan.mockRejectedValue(new SyncUploadError('boom', 500))

    await sync(['--tick'])
    expect((await loadScanState())?.dirty).toEqual([today])
    expect(await logLines()).toEqual([
      expect.stringContaining('tick error: boom'),
    ])

    // Same wall, next minute: the retry happens, the log line doesn't.
    await sync(['--tick'])
    expect(m.uploadTokenScan).toHaveBeenCalledTimes(2)
    expect((await logLines()).length).toBe(1)

    // A different failure is worth saying out loud.
    m.uploadTokenScan.mockRejectedValue(new SyncUploadError('nope', 503))
    await sync(['--tick'])
    expect((await logLines()).length).toBe(2)
  })

  it('honors a 429 by sitting out until Retry-After passes', async () => {
    await saveScanState(dirtyState())
    m.uploadTokenScan.mockRejectedValue(
      new SyncUploadError('slow down', 429, '120')
    )

    await sync(['--tick'])
    const state = await loadScanState()
    expect(state?.nextAllowedAt).toBeGreaterThan(Date.now() + 60_000)
    expect(state?.dirty).toEqual([today])

    // The next minute's tick doesn't even reach the session check.
    await sync(['--tick'])
    expect(m.uploadTokenScan).toHaveBeenCalledOnce()
  })

  it('pauses on an expired session, saying so only once', async () => {
    m.loadSessionState.mockResolvedValue({ status: 'expired', session: null })

    await sync(['--tick'])
    await sync(['--tick'])

    expect(m.uploadTokenScan).not.toHaveBeenCalled()
    expect(await readSyncPaused()).toContain('session expired')
    expect((await logLines()).length).toBe(1)
  })

  it('stays silent on a machine that was never logged in', async () => {
    m.loadSessionState.mockResolvedValue({ status: 'missing', session: null })

    await sync(['--tick'])

    expect(await readSyncPaused()).toBeNull()
    expect(await logLines()).toEqual([])
  })

  it('retries once with a refreshed session before pausing', async () => {
    await saveScanState(dirtyState())
    m.uploadTokenScan
      .mockRejectedValueOnce(new SyncUploadError(LOGIN_EXPIRED_MESSAGE, 401))
      .mockResolvedValueOnce({ tokensDelta: 500 })
    m.refreshSession.mockResolvedValue(SESSION)

    await sync(['--tick'])

    expect(m.uploadTokenScan).toHaveBeenCalledTimes(2)
    expect((await loadScanState())?.dirty).toEqual([])
  })

  it('stays a no-op when only prompts moved and consent is missing', async () => {
    // The tick counts prompts whatever the tier; at `none` they stay on disk,
    // and a minute with nothing else to say still costs no request.
    await saveScanState(promptDirtyState())

    await sync(['--tick'])

    expect(m.uploadTokenScan).not.toHaveBeenCalled()
  })

  it('uploads prompt activity on its own once the tier allows it', async () => {
    await saveScanState(promptDirtyState())
    m.loadPromptSync.mockResolvedValue('stats')

    await sync(['--tick'])

    const scan = m.uploadTokenScan.mock.calls[0]?.[1]
    expect(scan.promptActivity).toEqual({
      sessions: [expect.objectContaining({ sessionId: 's1', promptCount: 3 })],
      dailyPrompts: [{ date: today, prompts: 3, words: 21 }],
    })
    // No token dates moved, so the token half of the payload stays empty.
    expect(scan.dailyTotals).toEqual([])

    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual([])
    expect(state?.prompts.dirtyDates).toEqual([])
  })

  it('keeps prompt rows dirty when the upload fails', async () => {
    await saveScanState(promptDirtyState())
    m.loadPromptSync.mockResolvedValue('full')
    m.uploadTokenScan.mockRejectedValue(new SyncUploadError('boom', 500))

    await sync(['--tick'])

    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual(['s1'])
    expect(state?.prompts.dirtyDates).toEqual([today])
  })

  it('never sends prompt activity at the none tier, even with tokens to push', async () => {
    const state = dirtyState()
    state.prompts = promptDirtyState().prompts
    await saveScanState(state)

    await sync(['--tick'])

    expect(m.uploadTokenScan.mock.calls[0]?.[1].promptActivity).toBeUndefined()
  })

  it('trims a sync.log that got out of hand', async () => {
    // 1440 runs a day: an unbounded log is a slow leak on every user's disk.
    await saveScanState(emptyState())
    await writeFile(
      syncLogPath(),
      `${'x'.repeat(1_000_001)}\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`
    )

    await sync(['--tick'])

    const lines = await logLines()
    expect(lines.length).toBeLessThanOrEqual(200)
    expect(lines.at(-1)).toBe('line 299')
  })

  it('leaves a small log alone', async () => {
    await saveScanState(emptyState())
    await appendSyncLog('ok')

    await sync(['--tick'])

    expect((await logLines()).length).toBe(1)
  })
})
