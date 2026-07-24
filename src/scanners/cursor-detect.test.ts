import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// detectCursorUsage decides whether `join` interrupts someone to ask for a
// Cursor API key, so both directions are behavioral: a miss means a Cursor user
// silently keeps the rough local estimate, a false positive means every
// non-Cursor joiner answers a question that can't help them.

// HOME/APPDATA live in the hoisted block so the vi.mock('node:os') factory
// (hoisted above the module body) can reference them without hitting the TDZ.
const m = vi.hoisted(() => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  HOME: '/home/test',
  APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
}))

const HOME = m.HOME
const APPDATA = m.APPDATA

vi.mock('node:os', () => ({ homedir: () => m.HOME }))
vi.mock('node:fs/promises', () => ({
  stat: m.stat,
  readdir: m.readdir,
  readFile: vi.fn(),
}))

import { detectCursorUsage } from './index.js'

// Build the paths the same way the code does (path.join + the platform-specific
// Cursor state dir), so the mock's path set matches on Windows (backslashes,
// %APPDATA%\Cursor) as well as macOS/Linux — not just the host running the test.
function cursorStateDir(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Cursor')
  }
  if (process.platform === 'win32') return join(APPDATA, 'Cursor')
  return join(HOME, '.config', 'Cursor')
}

const TRACKING_DB = join(HOME, '.cursor', 'ai-tracking', 'ai-code-tracking.db')
const STATE_DIR = cursorStateDir()
const STATE_VSCDB = join(STATE_DIR, 'User', 'globalStorage', 'state.vscdb')
const WORKSPACE_STORAGE = join(STATE_DIR, 'User', 'workspaceStorage')
const HISTORY = join(STATE_DIR, 'User', 'History')

/** Only the listed paths exist; everything else throws ENOENT like real stat. */
function onlyTheseExist(paths: string[]) {
  m.stat.mockImplementation(async (p: string) => {
    if (paths.includes(String(p))) return { isDirectory: () => false }
    throw new Error('ENOENT')
  })
}

/** Only the listed dirs are readable, each with the given entries. */
function dirs(entries: Record<string, string[]>) {
  m.readdir.mockImplementation(async (p: string) => {
    const found = entries[String(p)]
    if (found) return found
    throw new Error('ENOENT')
  })
}

const origAppData = process.env.APPDATA

beforeEach(() => {
  vi.clearAllMocks()
  // On win32 the code reads %APPDATA% for the Cursor state dir; pin it so the
  // paths it builds match STATE_DIR above.
  process.env.APPDATA = APPDATA
  onlyTheseExist([])
  dirs({})
})

afterEach(() => {
  if (origAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = origAppData
})

describe('detectCursorUsage', () => {
  it('is false on a machine with no Cursor footprint at all', async () => {
    expect(await detectCursorUsage()).toBe(false)
  })

  it("is true when Cursor's AI-tracking db exists", async () => {
    onlyTheseExist([TRACKING_DB])

    expect(await detectCursorUsage()).toBe(true)
  })

  it('is true from editor session state alone, with no tracking db', async () => {
    // Someone who chats in Cursor without its commit tracking still has usage
    // worth fetching from the API — the tracking db can't be the only signal.
    onlyTheseExist([STATE_VSCDB])

    expect(await detectCursorUsage()).toBe(true)
  })

  it('is true when workspace storage has entries', async () => {
    dirs({ [WORKSPACE_STORAGE]: ['a-workspace'] })

    expect(await detectCursorUsage()).toBe(true)
  })

  it('is true when local file history has entries', async () => {
    dirs({ [HISTORY]: ['abc123'] })

    expect(await detectCursorUsage()).toBe(true)
  })

  it('is false when the state dirs exist but are empty', async () => {
    // Installed and launched once, never used: the dirs are there but bare.
    // Prompting here would be a question the user can only skip.
    dirs({
      [WORKSPACE_STORAGE]: [],
      [HISTORY]: [],
    })

    expect(await detectCursorUsage()).toBe(false)
  })
})
