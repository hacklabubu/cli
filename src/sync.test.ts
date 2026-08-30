import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The gap this file guards: a machine with no daemon has no minutely tick, so
// if prompt activity only ever rode on the tick it would never leave that
// machine at all. `runSync` therefore stages the same rebuild the tick does,
// carries whatever is outstanding, and clears it only when the server says 200.

const m = vi.hoisted(() => ({
  collectToolScans: vi.fn(),
  mergeToolScans: vi.fn(),
  scanPromptStats: vi.fn(),
}))

vi.mock('./scanners/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scanners/index.js')>()
  return {
    ...actual,
    collectToolScans: m.collectToolScans,
    mergeToolScans: m.mergeToolScans,
    // The staged rebuild walks the real harness dirs by default. Point every
    // one of them at nothing, so the test reads this machine's transcripts
    // never — and runs in milliseconds.
    claudeCodeFiles: async () => [],
    codexFiles: async () => [],
    openclawFiles: async () => [],
    grokLogFiles: async () => [],
    hermesDbPath: () => join(tmpdir(), 'hacklab-no-such.db'),
    opencodeDbPath: () => join(tmpdir(), 'hacklab-no-such.db'),
    scanHermes: async () => actual.emptyResult('hermes'),
    scanOpenCode: async () => actual.emptyResult('opencode'),
  }
})
vi.mock('./prompt-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompt-stats.js')>()
  return { ...actual, scanPromptStats: m.scanPromptStats }
})

import { loadScanState } from './scanners/incremental.js'
import { runSync } from './sync.js'

const SESSION = {
  token: 't',
  email: 'ada@example.com',
  handle: 'ada',
  appUrl: 'https://hacklab.so',
  savedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
}

const today = new Date().toISOString().slice(0, 10)
const startedAt = new Date(Date.now() - 3_600_000).toISOString()
const lastActiveAt = new Date().toISOString()

const SCAN = {
  toolTotals: { claude_code: 500 },
  dailyTotals: [{ date: today, tool: 'claude_code', tokens: 500, messages: 2 }],
  modelTotals: { opus: 500 },
  grandTotal: 500,
  cursorStats: null,
  cursorScanStatus: { source: 'none' as const },
}

/** What a full prompt scan finds on this machine. */
const PROMPT_STATS = {
  totalPrompts: 6,
  bucketMax: 10,
  histogram: [{ length: 3, count: 6 }],
  projects: [],
  activity: {
    sessions: { s1: { startedAt, lastActiveAt, promptCount: 6 } },
    daily: { [today]: { prompts: 6, words: 18 } },
  },
}

let dir: string
let sessionPath: string | undefined
let machinePath: string | undefined
let fetchMock: ReturnType<typeof vi.fn>

/** The parsed body of the Nth /api/claim/sync POST. */
function uploadBody(n = 0) {
  const call = fetchMock.mock.calls[n]
  return JSON.parse(String((call?.[1] as { body?: string })?.body ?? '{}'))
}

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'hacklab-runsync-'))
  // scan-state.json hangs off the session path, so a tmp one isolates the run.
  sessionPath = process.env.HACKLAB_SESSION_PATH
  machinePath = process.env.HACKLAB_MACHINE_PATH
  process.env.HACKLAB_SESSION_PATH = join(dir, 'session.json')
  process.env.HACKLAB_MACHINE_PATH = join(dir, 'machine.json')

  m.collectToolScans.mockResolvedValue([
    {
      tool: 'claude_code',
      daily: [{ date: today, tool: 'claude_code', tokens: 500, messages: 2 }],
      models: { opus: 500 },
    },
  ])
  // A fresh object per call, as the real one builds: a shared one would let a
  // field set on one sync leak into the next.
  m.mergeToolScans.mockImplementation(() => ({ ...SCAN }))
  m.scanPromptStats.mockResolvedValue(PROMPT_STATS)

  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ level: 3, title: 'hacker', tokensTotal: 500 }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  if (sessionPath === undefined) delete process.env.HACKLAB_SESSION_PATH
  else process.env.HACKLAB_SESSION_PATH = sessionPath
  if (machinePath === undefined) delete process.env.HACKLAB_MACHINE_PATH
  else process.env.HACKLAB_MACHINE_PATH = machinePath
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe('runSync — prompt activity without a daemon', () => {
  it('uploads the outstanding prompt rows on an interactive sync', async () => {
    // No scan-state.json at all: the daemon-less machine, syncing by hand.
    await runSync(SESSION, { interactive: true, promptSync: 'stats' })

    const body = uploadBody()
    expect(body.promptActivity).toEqual({
      sessions: [{ sessionId: 's1', startedAt, lastActiveAt, promptCount: 6 }],
      dailyPrompts: [{ date: today, prompts: 6, words: 18 }],
    })
    // The histogram half still travels in its own block, without the local
    // activity aggregate.
    expect(body.promptStats).toEqual({
      totalPrompts: 6,
      bucketMax: 10,
      histogram: [{ length: 3, count: 6 }],
      projects: [],
    })
    expect(body.promptStats.activity).toBeUndefined()
  })

  it('clears the claim once the server takes it', async () => {
    await runSync(SESSION, { interactive: true, promptSync: 'stats' })

    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual([])
    expect(state?.prompts.dirtyDates).toEqual([])
    expect(state?.prompts.sessions.s1?.promptCount).toBe(6)

    // A second sync that found nothing new has nothing left to say.
    await runSync(SESSION, { interactive: true, promptSync: 'stats' })
    expect(uploadBody(1).promptActivity).toBeUndefined()
  })

  it('keeps the rows dirty when the upload fails, and resends them', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({ error: 'boom' }),
    })

    await expect(
      runSync(SESSION, { interactive: true, promptSync: 'stats' })
    ).rejects.toThrow('boom')

    // Nothing was committed, so the retry re-derives the same claim.
    await runSync(SESSION, { interactive: true, promptSync: 'stats' })
    expect(uploadBody(1).promptActivity?.sessions).toEqual([
      { sessionId: 's1', startedAt, lastActiveAt, promptCount: 6 },
    ])

    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual([])
  })

  it('sends nothing conversational at the none tier', async () => {
    await runSync(SESSION, { interactive: true, promptSync: 'none' })

    const body = uploadBody()
    expect(body.promptActivity).toBeUndefined()
    expect(body.promptStats).toBeUndefined()
    // Opted out, so the transcripts are never even read.
    expect(m.scanPromptStats).not.toHaveBeenCalled()
  })
})
