import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Detection and launch are the two halves that behave differently per platform,
// and CI is the only place the win32 half ever runs for real — so `process.
// platform` is stubbed both ways here and the shaping is asserted directly.
// The setup flow tests (commands/setup.test.ts) then only care about *which*
// agent was picked, not the argv shape.

const m = vi.hoisted(() => ({ spawnSync: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: m.spawnSync }
})

import { AGENT_CLIS, findAgentCli, launchAgentCli } from './agent-handoff.js'

const PROMPT = 'yo setup my profile'
const CLAUDE = AGENT_CLIS[0]

const originalPath = process.env.PATH
const originalPathExt = process.env.PATHEXT
const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

let binDir: string

/** Drop empty executables on the (temp, test-owned) PATH. */
function installAgents(...files: string[]) {
  for (const file of files) {
    writeFileSync(join(binDir, file), '', { mode: 0o755 })
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  m.spawnSync.mockReturnValue({ status: 0 })
  binDir = await mkdtemp(join(tmpdir(), 'hacklab-agent-'))
  process.env.PATH = binDir
})

afterEach(() => {
  setPlatform(originalPlatform)
  process.env.PATH = originalPath
  if (originalPathExt === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = originalPathExt
})

describe('findAgentCli', () => {
  it('probes the table in order — claude, then codex, then grok', () => {
    setPlatform('darwin')
    installAgents('grok', 'codex', 'claude')
    expect(findAgentCli()?.bin).toBe('claude')
  })

  it('falls through to the next agent when earlier ones are missing', () => {
    setPlatform('darwin')
    installAgents('grok', 'codex')
    expect(findAgentCli()?.bin).toBe('codex')

    installAgents('claude')
    expect(findAgentCli()?.bin).toBe('claude')
  })

  it('finds nothing on an empty PATH', () => {
    setPlatform('darwin')
    expect(findAgentCli()).toBeNull()
  })

  it('looks for PATHEXT suffixes on Windows, not the bare name', () => {
    setPlatform('win32')
    // Pinned so the assertion does not ride on the host filesystem's case
    // sensitivity (`.CMD` vs `.cmd` matches on macOS but not on Linux).
    process.env.PATHEXT = '.cmd'

    installAgents('claude')
    expect(findAgentCli()).toBeNull()

    installAgents('claude.cmd')
    expect(findAgentCli()?.bin).toBe('claude')
  })
})

describe('launchAgentCli', () => {
  it('hands the terminal over with the prompt as the only argument', () => {
    setPlatform('darwin')

    expect(launchAgentCli(CLAUDE, PROMPT)).toBe(true)
    expect(m.spawnSync).toHaveBeenCalledWith('claude', [PROMPT], {
      stdio: 'inherit',
      shell: false,
    })
  })

  it('quotes the prompt and takes a shell on Windows', () => {
    // The `.cmd` shims Node refuses to spawn directly need `shell: true`, and
    // cmd.exe joins argv verbatim — unquoted, the prompt would arrive as a
    // dozen separate arguments.
    setPlatform('win32')

    expect(launchAgentCli(CLAUDE, PROMPT)).toBe(true)
    expect(m.spawnSync).toHaveBeenCalledWith('claude', [`"${PROMPT}"`], {
      stdio: 'inherit',
      shell: true,
    })
  })

  it('counts a non-zero exit as a launch — the user was there', () => {
    setPlatform('darwin')
    m.spawnSync.mockReturnValue({ status: 1 })

    expect(launchAgentCli(CLAUDE, PROMPT)).toBe(true)
  })

  it('reports a process that never started', () => {
    setPlatform('darwin')
    m.spawnSync.mockReturnValue({ error: new Error('spawn ENOENT') })

    expect(launchAgentCli(CLAUDE, PROMPT)).toBe(false)
  })

  it('survives a synchronous throw from spawn', () => {
    setPlatform('darwin')
    m.spawnSync.mockImplementation(() => {
      throw new Error('EPERM')
    })

    expect(launchAgentCli(CLAUDE, PROMPT)).toBe(false)
  })
})
