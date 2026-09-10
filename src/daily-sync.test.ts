import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  home: '/home/u',
  platform: vi.fn(() => 'darwin' as string),
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  appendFile: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
  spawn: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
  // Exit code for a spawned command; override per test. Everything succeeds by
  // default (scheduler present, every job accepted).
  exitFor: vi.fn((_cmd: string, _args: string[]) => 0),
  spawned: [] as Array<{ cmd: string; args: string[] }>,
}))

vi.mock('node:os', () => ({ homedir: () => m.home, platform: m.platform }))
vi.mock('node:fs/promises', () => ({
  stat: m.stat,
  writeFile: m.writeFile,
  mkdir: m.mkdir,
  rm: m.rm,
  readFile: m.readFile,
  appendFile: m.appendFile,
}))
vi.mock('node:fs', () => ({ realpathSync: m.realpathSync }))
vi.mock('node:child_process', () => ({ spawn: m.spawn }))
vi.mock('./session.js', () => ({
  getSessionPath: () => join(m.home, '.hacklab', 'session.json'),
}))
vi.mock('./config.js', () => ({
  loadConfig: m.loadConfig,
  saveConfig: m.saveConfig,
  updateConfig: m.updateConfig,
}))

import {
  dailySyncInstalled,
  dailySyncState,
  installDailySync,
  launchdPlist,
  launchdTickPlist,
  manualInstructions,
  resolveSyncCommand,
  schtasksCreateArgs,
  schtasksTickCreateArgs,
  schtasksTickWrapper,
  schtasksWrapper,
  stableNodePath,
  syncCommandFingerprint,
  systemdService,
  systemdTickService,
  systemdTickTimer,
  systemdTimer,
  uninstallDailySync,
} from './daily-sync.js'

const cmd = {
  node: '/usr/local/bin/node',
  script: '/home/u/.npm/lib/node_modules/hacklab/dist/index.js',
}

describe('daily-sync content builders', () => {
  it('launchd plist runs `node <script> sync --quiet` at the given time', () => {
    const plist = launchdPlist(
      cmd,
      { hour: 9, minute: 30 },
      '/home/u/.hacklab/sync.log'
    )
    expect(plist).toContain('<string>so.hacklab.sync</string>')
    expect(plist).toContain(`<string>${cmd.node}</string>`)
    expect(plist).toContain(`<string>${cmd.script}</string>`)
    expect(plist).toContain('<string>sync</string>')
    expect(plist).toContain('<string>--quiet</string>')
    expect(plist).toContain('<integer>9</integer>')
    expect(plist).toContain('<integer>30</integer>')
    expect(plist).toContain('<string>/home/u/.hacklab/sync.log</string>')
  })

  it('xml-escapes special characters in paths', () => {
    const plist = launchdPlist(
      { node: 'a&b', script: 'c<d>e' },
      { hour: 0, minute: 0 },
      'log'
    )
    expect(plist).toContain('a&amp;b')
    expect(plist).toContain('c&lt;d&gt;e')
    expect(plist).not.toContain('c<d>e')
  })

  it('systemd service ExecStarts node + script (quoted) with the sync flags', () => {
    const svc = systemdService(cmd)
    expect(svc).toContain(
      `ExecStart="${cmd.node}" "${cmd.script}" sync --quiet`
    )
    expect(svc).toContain('Type=oneshot')
  })

  it('systemd timer fires daily, persists missed runs, and installs to timers.target', () => {
    const timer = systemdTimer()
    expect(timer).toContain('OnCalendar=daily')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('WantedBy=timers.target')
  })

  it('manual instructions include both runnable commands', () => {
    const text = manualInstructions(cmd)
    expect(text).toContain(`"${cmd.node}" "${cmd.script}" sync --tick`)
    expect(text).toContain(`"${cmd.node}" "${cmd.script}" sync --quiet`)
    expect(text.toLowerCase()).toContain('systemd')
  })

  it('schtasks wrapper .cmd runs node + script (quoted) and logs to the sync log', () => {
    const win = {
      node: 'C:\\Program Files\\nodejs\\node.exe',
      script: 'C:\\Users\\a b\\AppData\\Roaming\\npm\\hacklab\\dist\\index.js',
    }
    const bat = schtasksWrapper(win, 'C:\\Users\\a b\\.hacklab\\sync.log')
    expect(bat).toContain('@echo off')
    expect(bat).toContain(
      `"${win.node}" "${win.script}" sync --quiet >> "C:\\Users\\a b\\.hacklab\\sync.log" 2>&1`
    )
    // CRLF line endings so the batch file is well-formed on Windows.
    expect(bat).toContain('\r\n')
  })

  it('schtasks /Create args schedule the wrapper daily at the given time', () => {
    const args = schtasksCreateArgs(
      'C:\\Users\\a b\\.hacklab\\hacklab-sync.cmd',
      {
        hour: 9,
        minute: 5,
      }
    )
    expect(args).toEqual([
      '/Create',
      '/SC',
      'DAILY',
      '/TN',
      'hacklab-sync',
      '/TR',
      '"C:\\Users\\a b\\.hacklab\\hacklab-sync.cmd"',
      '/ST',
      '09:05',
      '/F',
    ])
  })

  // The tick is the same command with a different flag and a different cadence,
  // so what these guard is that the two jobs stay distinct: separate labels and
  // task names (or `daemon off` would leave one behind), and a schedule the OS
  // reads as "every minute" rather than "once a day".
  it('launchd tick plist re-runs `sync --tick` every 60s under its own label', () => {
    const plist = launchdTickPlist(cmd, '/home/u/.hacklab/sync.log')
    expect(plist).toContain('<string>so.hacklab.tick</string>')
    expect(plist).toContain('<string>--tick</string>')
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).toContain('<integer>60</integer>')
    expect(plist).not.toContain('StartCalendarInterval')
    expect(plist).toContain('<string>/home/u/.hacklab/sync.log</string>')
  })

  it('systemd tick service ExecStarts the tick flag', () => {
    expect(systemdTickService(cmd)).toContain(
      `ExecStart="${cmd.node}" "${cmd.script}" sync --tick`
    )
  })

  it('systemd tick timer re-arms every minute, after boot settles', () => {
    const timer = systemdTickTimer()
    expect(timer).toContain('OnUnitActiveSec=1min')
    expect(timer).toContain('OnBootSec=2min')
    // Lets systemd batch the wakeup instead of waking a laptop on the second.
    expect(timer).toContain('AccuracySec=30s')
    expect(timer).toContain('WantedBy=timers.target')
  })

  it('schtasks tick wrapper runs the tick flag into the same sync log', () => {
    const win = {
      node: 'C:\\Program Files\\nodejs\\node.exe',
      script: 'C:\\Users\\a b\\AppData\\Roaming\\npm\\hacklab\\dist\\index.js',
    }
    const bat = schtasksTickWrapper(win, 'C:\\Users\\a b\\.hacklab\\sync.log')
    expect(bat).toContain(
      `"${win.node}" "${win.script}" sync --tick >> "C:\\Users\\a b\\.hacklab\\sync.log" 2>&1`
    )
    expect(bat).toContain('\r\n')
  })

  it('schtasks /Create args schedule the tick task every minute', () => {
    expect(
      schtasksTickCreateArgs('C:\\Users\\a b\\.hacklab\\hacklab-tick.cmd')
    ).toEqual([
      '/Create',
      '/SC',
      'MINUTE',
      '/MO',
      '1',
      '/TN',
      'hacklab-tick',
      '/TR',
      '"C:\\Users\\a b\\.hacklab\\hacklab-tick.cmd"',
      '/F',
    ])
  })

  it('resolveSyncCommand uses the absolute node binary + a concrete script path', () => {
    // Nothing resolves to the running binary under the identity mock, so this
    // is the fallback half of stableNodePath.
    const resolved = resolveSyncCommand()
    expect(resolved.node).toBe(process.execPath)
    expect(typeof resolved.script).toBe('string')
    expect(resolved.script.length).toBeGreaterThan(0)
  })
})

// The version-specific node path is what killed background sync on a Homebrew
// machine: `brew upgrade node` moved the libraries out from under the exact
// binary the plist named, and the daemon died on a dyld error for three days.
describe('stableNodePath', () => {
  /** What Homebrew's `process.execPath` looks like: a version-scoped keg. */
  const KEG = '/opt/homebrew/Cellar/node/26.5.0/bin/node'
  const OTHER_KEG = '/opt/homebrew/Cellar/node/25.1.0/bin/node'
  const BREW = '/opt/homebrew/bin/node'

  /** Resolve exactly these paths; everything else is ENOENT. process.execPath
   * is read live, so it goes in the map rather than getting reassigned. */
  const resolving = (map: Record<string, string>) => {
    m.realpathSync.mockImplementation((path: string) => {
      const real = map[String(path)]
      if (!real) throw new Error('ENOENT')
      return real
    })
  }

  it('prefers a stable path that resolves to the same binary', () => {
    resolving({ [process.execPath]: KEG, [BREW]: KEG })

    expect(stableNodePath()).toBe(BREW)
  })

  it('falls back to execPath when no candidate resolves at all', () => {
    // fnm/nvm/asdf: the shims are per-shell and version-scoped, so none of the
    // well-known paths exist. Pinning execPath is the best available answer.
    resolving({ [process.execPath]: KEG })

    expect(stableNodePath()).toBe(process.execPath)
  })

  it('falls back when a candidate is a different node install', () => {
    // Identity is by resolved real path, never by name: a second node parked at
    // the stable path would silently swap the interpreter under the daemon.
    resolving({ [process.execPath]: KEG, [BREW]: OTHER_KEG })

    expect(stableNodePath()).toBe(process.execPath)
  })

  it('walks the candidates in order', () => {
    resolving({
      [process.execPath]: KEG,
      '/usr/local/bin/node': KEG,
      '/usr/bin/node': KEG,
    })

    expect(stableNodePath()).toBe('/usr/local/bin/node')
  })

  it('honors VOLTA_HOME', () => {
    vi.stubEnv('VOLTA_HOME', '/opt/volta')
    resolving({
      [process.execPath]: KEG,
      [join('/opt/volta', 'bin', 'node')]: KEG,
    })

    expect(stableNodePath()).toBe(join('/opt/volta', 'bin', 'node'))
    vi.unstubAllEnvs()
  })

  it('invents no candidates on windows', () => {
    // There execPath is already a version-stable install location.
    m.platform.mockReturnValue('win32')
    resolving({ [process.execPath]: KEG, [BREW]: KEG })

    expect(stableNodePath()).toBe(process.execPath)
    expect(m.realpathSync).not.toHaveBeenCalledWith(BREW)
  })

  it('falls back when the running binary itself cannot be resolved', () => {
    resolving({})

    expect(stableNodePath()).toBe(process.execPath)
  })

  it('changes the fingerprint, so an install pointing at the keg is rebuilt', () => {
    expect(syncCommandFingerprint({ node: BREW, script: cmd.script })).not.toBe(
      syncCommandFingerprint({ node: KEG, script: cmd.script })
    )
  })
})

// Everything below drives the real installers with the fs/spawn/config
// boundaries mocked out. What's under test is *when* we touch the OS scheduler:
// a reinstall rewrites the jobs and bounces them, so it has to be earned.

// Built with `join`, never as literals: the CI matrix includes native Windows,
// where node:path joins with backslashes and a hardcoded POSIX path would match
// nothing the code under test writes or stats.
const AGENTS = join(m.home, 'Library', 'LaunchAgents')
const DAILY_PLIST = join(AGENTS, 'so.hacklab.sync.plist')
const TICK_PLIST = join(AGENTS, 'so.hacklab.tick.plist')
const SYSTEMD_DIR = join(m.home, '.config', 'systemd', 'user')
const DAILY_TIMER = join(SYSTEMD_DIR, 'hacklab-sync.timer')
const TICK_TIMER = join(SYSTEMD_DIR, 'hacklab-tick.timer')

/** Make `stat` succeed for exactly these paths (the installed artifacts). */
function present(...paths: string[]) {
  m.stat.mockImplementation(async (p: string) => {
    if (!paths.includes(String(p))) throw new Error('ENOENT')
    return { size: 0 }
  })
}

const wrote = (path: string): string | undefined =>
  m.writeFile.mock.calls.find((c) => c[0] === path)?.[1] as string | undefined

const savedConfig = () =>
  m.saveConfig.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined

/** Every schtasks call about the minutely tick task fails: the Windows policy
 * that caps task frequency, both when creating it and when querying it later. */
const tickRefused = (_cmd: string, args: string[]) =>
  args.includes('hacklab-tick') ? 1 : 0

beforeEach(() => {
  vi.clearAllMocks()
  m.spawned.length = 0
  m.platform.mockReturnValue('darwin')
  present()
  // Identity by default: every path resolves to itself, so no stable candidate
  // is ever the same binary as process.execPath (see the stableNodePath block).
  m.realpathSync.mockImplementation((path: string) => path)
  m.mkdir.mockResolvedValue(undefined)
  m.writeFile.mockResolvedValue(undefined)
  m.rm.mockResolvedValue(undefined)
  m.loadConfig.mockResolvedValue({})
  m.saveConfig.mockResolvedValue(undefined)
  // Stand-in for the real updateConfig: apply the mutator to what's on "disk",
  // write unless it declines, and report that the write landed.
  m.updateConfig.mockImplementation(
    async (mutate: (c: object) => object | null) => {
      const next = mutate(await m.loadConfig())
      if (next) await m.saveConfig(next)
      return true
    }
  )
  m.exitFor.mockReturnValue(0)
  m.spawn.mockImplementation((cmd: string, args: string[]) => {
    m.spawned.push({ cmd, args })
    const handlers: Record<string, (arg?: unknown) => void> = {}
    queueMicrotask(() => handlers.close?.(m.exitFor(cmd, args)))
    return {
      on: (event: string, fn: (arg?: unknown) => void) => {
        handlers[event] = fn
      },
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dailySyncInstalled', () => {
  it('reads a half-install (daily plist present, tick missing) as not installed', async () => {
    present(DAILY_PLIST)
    expect(await dailySyncInstalled()).toBe(false)

    present(DAILY_PLIST, TICK_PLIST)
    expect(await dailySyncInstalled()).toBe(true)
  })

  it('requires both systemd timers on linux', async () => {
    m.platform.mockReturnValue('linux')
    present(DAILY_TIMER)
    expect(await dailySyncInstalled()).toBe(false)

    present(DAILY_TIMER, TICK_TIMER)
    expect(await dailySyncInstalled()).toBe(true)
  })

  it('requires both scheduled tasks on windows', async () => {
    m.platform.mockReturnValue('win32')
    expect(await dailySyncInstalled()).toBe(true)

    // A non-zero /Query for the tick task is a half-install.
    m.exitFor.mockImplementation(tickRefused)
    expect(await dailySyncInstalled()).toBe(false)
  })

  it('stops expecting a tick job that was refused', async () => {
    m.platform.mockReturnValue('win32')
    m.exitFor.mockImplementation(tickRefused)

    expect(await dailySyncInstalled({ expectTick: false })).toBe(true)
    // …and it never even asked about the tick task.
    expect(m.spawned.some((s) => s.args.includes('hacklab-tick'))).toBe(false)
  })
})

describe('dailySyncState', () => {
  const fingerprint = () => syncCommandFingerprint(resolveSyncCommand())

  it('is missing when the jobs are absent', async () => {
    expect(await dailySyncState()).toBe('missing')
  })

  it('is current when the jobs exist and the command is unchanged', async () => {
    present(DAILY_PLIST, TICK_PLIST)
    m.loadConfig.mockResolvedValue({
      dailySync: { command: fingerprint(), hour: 7, minute: 3 },
    })

    expect(await dailySyncState()).toBe('current')
  })

  it('is stale when the recorded command no longer matches', async () => {
    present(DAILY_PLIST, TICK_PLIST)
    m.loadConfig.mockResolvedValue({
      dailySync: { command: '/old/node /old/cli.js', hour: 7, minute: 3 },
    })

    expect(await dailySyncState()).toBe('stale')
  })

  it('is stale when installed jobs predate the fingerprint', async () => {
    // 0.13.x installs have no record: reinstall once to write one, then settle.
    present(DAILY_PLIST, TICK_PLIST)

    expect(await dailySyncState()).toBe('stale')
  })

  // A command whose node and script both still exist on disk: what an nvm user
  // (or someone with two checkouts) leaves behind after switching away.
  const OTHER = {
    node: join(m.home, '.nvm', 'versions', 'node', 'v20', 'bin', 'node'),
    script: join(m.home, 'src', 'cli', 'dist', 'index.js'),
  }

  it('stays current while the scheduled command still resolves', async () => {
    // Alternating node versions flips the fingerprint every run, but the jobs
    // keep working — reinstalling each way round would ping-pong forever.
    present(DAILY_PLIST, TICK_PLIST, OTHER.node, OTHER.script)
    m.loadConfig.mockResolvedValue({
      dailySync: { command: syncCommandFingerprint(OTHER), hour: 7, minute: 3 },
    })

    expect(await dailySyncState()).toBe('current')
  })

  it('is stale once the scheduled command is gone', async () => {
    // The node binary survives an uninstall of that version, the script doesn't
    // (or vice versa) — either way the jobs are now dead and need rebuilding.
    for (const stillThere of [OTHER.node, OTHER.script]) {
      present(DAILY_PLIST, TICK_PLIST, stillThere)
      m.loadConfig.mockResolvedValue({
        dailySync: {
          command: syncCommandFingerprint(OTHER),
          hour: 7,
          minute: 3,
        },
      })

      expect(await dailySyncState()).toBe('stale')
    }
  })

  it('is stale when the jobs came from an older template generation', async () => {
    // Everything still resolves, but the artifacts were written by templates
    // this version has since changed, so they get rebuilt. v:1 is what every
    // pre-0.21.1 install recorded, and re-arming those with a node path that
    // survives an upgrade is the only way the corrected path ever lands.
    for (const v of [0, 1]) {
      present(DAILY_PLIST, TICK_PLIST, OTHER.node, OTHER.script)
      m.loadConfig.mockResolvedValue({
        dailySync: {
          command: JSON.stringify({ v, ...OTHER }),
          hour: 7,
          minute: 3,
        },
      })

      expect(await dailySyncState()).toBe('stale')
    }
  })

  it('is current on a machine whose policy refused the tick task', async () => {
    // The daily job is all this box will ever have; expecting a tick task that
    // can't exist would reinstall (and announce itself) on every single scan.
    m.platform.mockReturnValue('win32')
    m.exitFor.mockImplementation(tickRefused)
    m.loadConfig.mockResolvedValue({
      dailySync: { command: fingerprint(), hour: 7, minute: 3, tick: false },
    })

    expect(await dailySyncState()).toBe('current')
  })

  it('still repairs a missing tick job when the record expected one', async () => {
    m.platform.mockReturnValue('win32')
    m.exitFor.mockImplementation(tickRefused)
    for (const dailySync of [
      { command: fingerprint(), hour: 7, minute: 3, tick: true },
      { command: fingerprint(), hour: 7, minute: 3 },
    ]) {
      m.loadConfig.mockResolvedValue({ dailySync })
      expect(await dailySyncState()).toBe('missing')
    }
  })
})

describe('installDailySync', () => {
  it('picks a random slot on a fresh install and records it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const result = await installDailySync()

    expect(result).toMatchObject({
      ok: true,
      mechanism: 'launchd',
      tick: true,
      recorded: true,
    })
    expect(wrote(DAILY_PLIST)).toContain('<integer>12</integer>')
    expect(wrote(DAILY_PLIST)).toContain('<integer>30</integer>')
    expect(savedConfig()?.dailySync).toEqual({
      command: syncCommandFingerprint(resolveSyncCommand()),
      hour: 12,
      minute: 30,
      tick: true,
    })
  })

  it('reuses the recorded slot instead of re-rolling it', async () => {
    m.loadConfig.mockResolvedValue({
      dailySync: { command: '/old/node /old/cli.js', hour: 7, minute: 3 },
    })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await installDailySync()

    const plist = wrote(DAILY_PLIST) ?? ''
    expect(plist).toContain('<integer>7</integer>')
    expect(plist).toContain('<integer>3</integer>')
    expect(plist).not.toContain('<integer>12</integer>')
    // …and the record now points at the command we actually installed.
    expect(savedConfig()?.dailySync).toEqual({
      command: syncCommandFingerprint(resolveSyncCommand()),
      hour: 7,
      minute: 3,
      tick: true,
    })
  })

  it('records tick:false when the scheduler refuses the minutely task', async () => {
    m.platform.mockReturnValue('win32')
    m.exitFor.mockImplementation(tickRefused)

    const result = await installDailySync()

    // The daily job is the one that must exist: a refused tick costs freshness,
    // not the streak, so this is still a successful install.
    expect(result).toMatchObject({ ok: true, mechanism: 'schtasks' })
    expect(savedConfig()?.dailySync).toMatchObject({ tick: false })
  })

  it('upgrades the record when a re-run gets the tick accepted', async () => {
    // `hacklab daemon` force-reinstalls, so a machine whose policy loosened can
    // pick the tick back up.
    m.platform.mockReturnValue('win32')
    m.loadConfig.mockResolvedValue({
      dailySync: { command: 'old', hour: 7, minute: 3, tick: false },
    })

    await installDailySync()

    expect(savedConfig()?.dailySync).toMatchObject({ tick: true })
  })

  it('keeps the rest of the config when recording the install', async () => {
    m.loadConfig.mockResolvedValue({ cursorApiKey: 'key' })

    await installDailySync()

    expect(savedConfig()).toMatchObject({ cursorApiKey: 'key' })
  })

  it('reports recorded:false when the config could not be written', async () => {
    // Scheduled, but nothing will know it next time — the caller has to be able
    // to say so instead of silently reinstalling on every run.
    m.updateConfig.mockResolvedValue(false)

    const result = await installDailySync()

    expect(result).toMatchObject({ ok: true, recorded: false })
  })

  it('records nothing when nothing got scheduled', async () => {
    m.platform.mockReturnValue('linux')
    // No user systemd manager: daemon-reload fails, so we never write units.
    m.exitFor.mockReturnValue(1)

    const result = await installDailySync()

    expect(result.ok).toBe(false)
    expect(m.saveConfig).not.toHaveBeenCalled()
  })
})

// The point of stableNodePath is only realized if the path it returns is what
// actually reaches the OS scheduler, so these drive the installers end to end.
describe('the scheduled command carries the stable node path', () => {
  const KEG = '/opt/homebrew/Cellar/node/26.5.0/bin/node'
  const BREW = '/opt/homebrew/bin/node'

  beforeEach(() => {
    // A Homebrew machine: execPath is the keg, /opt/homebrew/bin/node is the
    // symlink brew relinks on every upgrade, and both are the same binary now.
    m.realpathSync.mockImplementation((path: string) => {
      const real = { [process.execPath]: KEG, [BREW]: KEG }[String(path)]
      if (!real) throw new Error('ENOENT')
      return real
    })
  })

  it('into both launchd plists', async () => {
    await installDailySync()

    for (const plist of [wrote(DAILY_PLIST), wrote(TICK_PLIST)]) {
      expect(plist).toContain(`<string>${BREW}</string>`)
      expect(plist).not.toContain(KEG)
    }
  })

  it('into both systemd services', async () => {
    m.platform.mockReturnValue('linux')

    await installDailySync()

    for (const unit of [
      wrote(join(SYSTEMD_DIR, 'hacklab-sync.service')),
      wrote(join(SYSTEMD_DIR, 'hacklab-tick.service')),
    ]) {
      expect(unit).toContain(`ExecStart="${BREW}"`)
      expect(unit).not.toContain(KEG)
    }
  })

  it('into both schtasks wrappers', async () => {
    // Windows contributes no candidates — execPath there is already a stable
    // install location — so what this pins is that the wrapper runs whatever
    // resolveSyncCommand decided, not some second opinion.
    m.platform.mockReturnValue('win32')
    const { node } = resolveSyncCommand()

    await installDailySync()

    for (const bat of [
      wrote(join(m.home, '.hacklab', 'hacklab-sync.cmd')),
      wrote(join(m.home, '.hacklab', 'hacklab-tick.cmd')),
    ]) {
      expect(bat).toContain(`"${node}"`)
    }
  })

  it('and gets recorded, so the next run reads as current', async () => {
    await installDailySync()
    present(DAILY_PLIST, TICK_PLIST)
    m.loadConfig.mockResolvedValue({ dailySync: savedConfig()?.dailySync })

    expect(savedConfig()?.dailySync).toMatchObject({
      command: syncCommandFingerprint({
        node: BREW,
        script: resolveSyncCommand().script,
      }),
    })
    expect(await dailySyncState()).toBe('current')
  })
})

describe('uninstallDailySync', () => {
  it('clears the recorded command and slot', async () => {
    m.loadConfig.mockResolvedValue({
      cursorApiKey: 'key',
      dailySync: { command: 'node cli.js', hour: 7, minute: 3 },
    })

    await uninstallDailySync()

    expect(savedConfig()).toEqual({ cursorApiKey: 'key' })
  })

  it('leaves the config untouched when there was no record', async () => {
    // `logout` and `daemon off` run this unconditionally: rewriting config.json
    // for every user who never had a schedule is churn (and a clobber risk).
    m.loadConfig.mockResolvedValue({ cursorApiKey: 'key' })

    await uninstallDailySync()

    expect(m.saveConfig).not.toHaveBeenCalled()
  })
})
