import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the npm plumbing so the command's control flow is tested without ever
// shelling out to a real `npm i -g`. vi.mock factories are hoisted above the
// imports, so the spies they close over must come from vi.hoisted().
const { runNpm, npmGlobalRoot, isWritable, captureEvent, fetchLatest } =
  vi.hoisted(() => ({
    runNpm: vi.fn(),
    npmGlobalRoot: vi.fn(),
    isWritable: vi.fn(),
    captureEvent: vi.fn(async () => undefined),
    fetchLatest: vi.fn(),
  }))
vi.mock('../utils/npmGlobal.js', () => ({
  runNpm,
  npmGlobalRoot,
  isWritable,
  userNpmPrefix: () => '/home/john/.npm-global',
}))
// Only the registry lookup is mocked; isNewerVersion stays real (it's pure).
vi.mock('../utils/updateCheck.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/updateCheck.js')>()),
  fetchLatest,
}))
vi.mock('../session.js', () => ({
  loadSession: async () => ({ handle: 'ada' }),
}))
vi.mock('../posthog.js', () => ({ captureEvent }))

import { update } from './update.js'

// The running version the command reads from package.json — computed the same
// way here so the telemetry/early-return assertions can't drift from it.
const CURRENT = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version

describe('update', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  const originalPlatform = process.platform
  const originalPath = process.env.PATH

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // process.exit throws so we can assert on it without killing the test run.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`)
    })
    setPlatform('linux')
    // Default: registry reports a much newer version, so the early-return is not
    // taken and the install proceeds. Tests that need otherwise override this.
    fetchLatest.mockResolvedValue('99.0.0')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    process.env.PATH = originalPath
  })

  it('installs directly when the global folder is writable (no reconfigure)', async () => {
    npmGlobalRoot.mockReturnValue('/usr/lib/node_modules')
    isWritable.mockReturnValue(true)
    runNpm.mockReturnValue({ status: 0 })

    await update()

    // Only the install call — never `config set prefix`.
    expect(runNpm).toHaveBeenCalledTimes(1)
    expect(runNpm).toHaveBeenCalledWith(['install', '-g', 'hacklab@latest'])
    expect(captureEvent).toHaveBeenCalledWith('ada', 'cli_update', {
      from: CURRENT,
      to: '99.0.0',
    })
  })

  it('reconfigures to a user prefix when the global folder is read-only, then installs', async () => {
    npmGlobalRoot.mockReturnValue('/usr/local/lib/node_modules')
    isWritable.mockReturnValue(false)
    // config set prefix → ok, then install → ok
    runNpm.mockReturnValue({ status: 0 })

    await update()

    expect(runNpm).toHaveBeenCalledWith(
      ['config', 'set', 'prefix', '/home/john/.npm-global'],
      { capture: true }
    )
    expect(runNpm).toHaveBeenCalledWith(['install', '-g', 'hacklab@latest'])
    // The new bin dir is prepended to PATH for this process's children.
    expect(
      process.env.PATH?.startsWith(join('/home/john/.npm-global', 'bin'))
    ).toBe(true)
    expect(captureEvent).toHaveBeenCalledWith('ada', 'cli_update', {
      from: CURRENT,
      to: '99.0.0',
    })
  })

  it('skips the writability probe entirely on Windows', async () => {
    setPlatform('win32')
    runNpm.mockReturnValue({ status: 0 })

    await update()

    expect(npmGlobalRoot).not.toHaveBeenCalled()
    expect(runNpm).toHaveBeenCalledExactlyOnceWith([
      'install',
      '-g',
      'hacklab@latest',
    ])
  })

  it('exits non-zero and reports failure when the install fails', async () => {
    npmGlobalRoot.mockReturnValue('/usr/lib/node_modules')
    isWritable.mockReturnValue(true)
    runNpm.mockReturnValue({ status: 1 })

    await expect(update()).rejects.toThrow('exit:1')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(captureEvent).toHaveBeenCalledWith('ada', 'cli_update_failed')
  })

  it('exits when the read-only prefix reconfigure itself fails', async () => {
    npmGlobalRoot.mockReturnValue('/usr/local/lib/node_modules')
    isWritable.mockReturnValue(false)
    // config set prefix → fails
    runNpm.mockReturnValueOnce({ status: 1 })

    await expect(update()).rejects.toThrow('exit:1')
    // Never reached the install step.
    expect(runNpm).toHaveBeenCalledTimes(1)
  })

  it('returns early when already on the latest — no install, no prefix reconfigure', async () => {
    // Registry reports our exact running version.
    fetchLatest.mockResolvedValue(CURRENT)
    // Would report read-only if probed — proves we never probe/reconfigure.
    npmGlobalRoot.mockReturnValue('/usr/local/lib/node_modules')
    isWritable.mockReturnValue(false)

    await update()

    expect(npmGlobalRoot).not.toHaveBeenCalled()
    expect(runNpm).not.toHaveBeenCalled()
    // We returned before the install, so no cli_update event fires.
    expect(captureEvent).not.toHaveBeenCalled()
  })

  it('falls through to the install when the version lookup fails', async () => {
    // A timed-out / failed registry lookup resolves to undefined.
    fetchLatest.mockResolvedValue(undefined)
    npmGlobalRoot.mockReturnValue('/usr/lib/node_modules')
    isWritable.mockReturnValue(true)
    runNpm.mockReturnValue({ status: 0 })

    await update()

    expect(runNpm).toHaveBeenCalledWith(['install', '-g', 'hacklab@latest'])
    // `to` is null when we couldn't determine the latest version.
    expect(captureEvent).toHaveBeenCalledWith('ada', 'cli_update', {
      from: CURRENT,
      to: null,
    })
  })
})
