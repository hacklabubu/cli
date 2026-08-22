import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { getSessionPath } from './session.js'

// Sets up (and tears down) the two OS-native background jobs: a `hacklab sync
// --tick` every minute (the incremental one — reads only what the AI tools
// appended since the last run) and the full `hacklab sync --quiet` once a day
// (the repair pass, which also re-bases the tick's state). launchd on macOS, a
// systemd user timer on Linux, Task Scheduler on Windows, and printed
// instructions when none of those fit. The scheduled command is resolved to an
// absolute `node <entry>` pair so a scheduler running with a bare PATH
// (cron/launchd/systemd often have almost none) can launch it without a
// `hacklab` shim.

const LAUNCHD_LABEL = 'so.hacklab.sync'
const LAUNCHD_TICK_LABEL = 'so.hacklab.tick'
const SYSTEMD_UNIT = 'hacklab-sync'
const SYSTEMD_TICK_UNIT = 'hacklab-tick'
const SCHTASKS_TASK = 'hacklab-sync'
const SCHTASKS_TICK_TASK = 'hacklab-tick'

export type SyncCommand = { node: string; script: string }

export type InstallResult =
  | { ok: true; mechanism: 'launchd' | 'systemd' | 'schtasks'; detail: string }
  | { ok: false; mechanism: 'manual' | 'unsupported'; instructions: string }

/** Run a command without ever rejecting: resolves the exit code (127 when the
 * binary can't even be spawned, e.g. `systemctl` absent). */
function run(
  cmd: string,
  args: string[],
  opts: { windowsVerbatimArguments?: boolean } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', ...opts })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/** The daily background job writes here; launchd/systemd also point stdout+stderr
 * at it. Lives next to the session file so it honors HACKLAB_SESSION_PATH. */
export function syncLogPath(): string {
  return join(dirname(getSessionPath()), 'sync.log')
}

function pausedMarkerPath(): string {
  return join(dirname(getSessionPath()), 'sync-paused')
}

// The tick runs 1440 times a day, so the log has to be bounded even if every
// one of those runs has something to say.
export const SYNC_LOG_MAX_BYTES = 1_000_000
export const SYNC_LOG_KEEP_LINES = 200

/** Cut an oversized sync.log down to its last few hundred lines. Best-effort,
 * and a no-op while the log is small — which is the normal case. */
export async function trimSyncLog(
  maxBytes = SYNC_LOG_MAX_BYTES,
  keepLines = SYNC_LOG_KEEP_LINES
): Promise<void> {
  try {
    const path = syncLogPath()
    if ((await stat(path)).size <= maxBytes) return
    const lines = (await readFile(path, 'utf8')).split('\n')
    const kept = lines.slice(-keepLines).join('\n')
    await writeFile(path, kept.endsWith('\n') ? kept : `${kept}\n`, 'utf8')
  } catch {
    // no log yet, or we can't rewrite it — either way, nothing to do
  }
}

/** Append a timestamped line to the background-sync log (best-effort). */
export async function appendSyncLog(line: string): Promise<void> {
  try {
    await mkdir(dirname(syncLogPath()), { recursive: true })
    await appendFile(syncLogPath(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // logging must never break the job
  }
}

/** Record that the background sync can't continue (e.g. the session expired), so
 * the next interactive `hacklab` run can surface it. */
export async function markSyncPaused(reason: string): Promise<void> {
  try {
    await mkdir(dirname(pausedMarkerPath()), { recursive: true })
    await writeFile(pausedMarkerPath(), reason, 'utf8')
  } catch {
    // best-effort
  }
}

/** The reason the background sync is paused, or null if it isn't. */
export async function readSyncPaused(): Promise<string | null> {
  try {
    const reason = (await readFile(pausedMarkerPath(), 'utf8')).trim()
    return reason.length > 0 ? reason : null
  } catch {
    return null
  }
}

export async function clearSyncPaused(): Promise<void> {
  try {
    await rm(pausedMarkerPath(), { force: true })
  } catch {
    // best-effort
  }
}

/** Absolute `node` + the CLI's own entry script, so the scheduler doesn't depend
 * on a `hacklab` bin being on its PATH. */
export function resolveSyncCommand(): SyncCommand {
  const argv1 = process.argv[1]
  let script = argv1 ?? 'hacklab'
  try {
    if (argv1) script = realpathSync(argv1)
  } catch {
    // argv1 not resolvable (unusual) — fall back to the raw path.
  }
  return { node: process.execPath, script }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The plist skeleton both jobs share — same command shape, different schedule. */
function launchdDoc(
  label: string,
  cmd: SyncCommand,
  mode: string,
  schedule: string,
  logPath: string
): string {
  const args = [cmd.node, cmd.script, 'sync', mode]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${schedule}
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

export function launchdPlist(
  cmd: SyncCommand,
  time: { hour: number; minute: number },
  logPath: string
): string {
  return launchdDoc(
    LAUNCHD_LABEL,
    cmd,
    '--quiet',
    `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${time.hour}</integer>
    <key>Minute</key>
    <integer>${time.minute}</integer>
  </dict>`,
    logPath
  )
}

/** The minutely tick. StartInterval (not a calendar interval) so launchd just
 * re-runs it every 60s; a tick with nothing to report exits without a request. */
export function launchdTickPlist(cmd: SyncCommand, logPath: string): string {
  return launchdDoc(
    LAUNCHD_TICK_LABEL,
    cmd,
    '--tick',
    `  <key>StartInterval</key>
  <integer>60</integer>`,
    logPath
  )
}

export function systemdService(cmd: SyncCommand): string {
  // Quote node + script so paths with spaces survive systemd's parser.
  return `[Unit]
Description=hacklab daily token sync

[Service]
Type=oneshot
ExecStart="${cmd.node}" "${cmd.script}" sync --quiet
`
}

export function systemdTimer(): string {
  // OnCalendar=daily with a randomized delay spreads load across users; Persistent
  // catches up a run missed while the machine was off.
  return `[Unit]
Description=hacklab daily token sync

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=3600

[Install]
WantedBy=timers.target
`
}

export function systemdTickService(cmd: SyncCommand): string {
  return `[Unit]
Description=hacklab token tick

[Service]
Type=oneshot
ExecStart="${cmd.node}" "${cmd.script}" sync --tick
`
}

export function systemdTickTimer(): string {
  // OnUnitActiveSec re-arms a minute after each run finishes (so a slow tick
  // can't stack up), OnBootSec gives the desktop a moment to settle first, and
  // AccuracySec lets systemd batch the wakeup with others — a minutely timer is
  // otherwise a needless drain on a laptop.
  return `[Unit]
Description=hacklab token tick

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=30s

[Install]
WantedBy=timers.target
`
}

/** Where the Windows scheduled task's wrapper batch file lives. Next to the
 * session file so it honors HACKLAB_SESSION_PATH, mirroring syncLogPath(). */
export function syncWrapperPath(): string {
  return join(dirname(getSessionPath()), 'hacklab-sync.cmd')
}

/** The tick's own wrapper — same pattern, its own file so the two tasks can be
 * created and deleted independently. */
export function tickWrapperPath(): string {
  return join(dirname(getSessionPath()), 'hacklab-tick.cmd')
}

/** The batch wrapper Task Scheduler runs. schtasks' `/TR` chokes on the nested
 * quotes a full `"node" "script" …` command needs, so we point the task at this
 * one-line .cmd instead and do the quoting here, where plain-batch rules apply.
 * Output is redirected to the same sync.log the job also appends to, so a crash
 * before the CLI's own logging still leaves a trace. */
export function schtasksWrapper(cmd: SyncCommand, logPath: string): string {
  return `@echo off\r\n"${cmd.node}" "${cmd.script}" sync --quiet >> "${logPath}" 2>&1\r\n`
}

/** Same wrapper for the minutely tick, logging to the same sync.log. */
export function schtasksTickWrapper(cmd: SyncCommand, logPath: string): string {
  return `@echo off\r\n"${cmd.node}" "${cmd.script}" sync --tick >> "${logPath}" 2>&1\r\n`
}

/** Args for `schtasks /Create`. The `/TR` value is a single pre-quoted path;
 * spawn must run with windowsVerbatimArguments so Node doesn't re-escape it. */
export function schtasksCreateArgs(
  wrapperPath: string,
  time: { hour: number; minute: number }
): string[] {
  return [
    '/Create',
    '/SC',
    'DAILY',
    '/TN',
    SCHTASKS_TASK,
    '/TR',
    `"${wrapperPath}"`,
    '/ST',
    `${pad2(time.hour)}:${pad2(time.minute)}`,
    '/F',
  ]
}

/** Args for `schtasks /Create` for the tick: every minute, forever. */
export function schtasksTickCreateArgs(wrapperPath: string): string[] {
  return [
    '/Create',
    '/SC',
    'MINUTE',
    '/MO',
    '1',
    '/TN',
    SCHTASKS_TICK_TASK,
    '/TR',
    `"${wrapperPath}"`,
    '/F',
  ]
}

// Generic fallback text, reused for both "Linux without a systemd user manager"
// and "OS we don't auto-schedule on" — so it must not name a specific mechanism.
export function manualInstructions(cmd: SyncCommand): string {
  return [
    "Couldn't set up the automatic background sync on this system.",
    'To run it yourself, schedule these two commands with cron, a systemd timer,',
    "or your init system's scheduler — the tick every minute, the full sync once",
    'a day:',
    `  "${cmd.node}" "${cmd.script}" sync --tick`,
    `  "${cmd.node}" "${cmd.script}" sync --quiet`,
  ].join('\n')
}

function launchAgentPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** Write a plist and (re)load it. Unload first so a re-run replaces the agent
 * rather than stacking a second copy. */
async function loadAgent(path: string, contents: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
  await run('launchctl', ['unload', path])
  return run('launchctl', ['load', '-w', path])
}

async function installLaunchd(
  cmd: SyncCommand,
  logPath: string
): Promise<InstallResult> {
  const plistPath = launchAgentPath(LAUNCHD_LABEL)
  // Randomize the time so installs don't all hit the API at the same instant.
  const time = {
    hour: Math.floor(Math.random() * 24),
    minute: Math.floor(Math.random() * 60),
  }
  const loaded = await loadAgent(plistPath, launchdPlist(cmd, time, logPath))
  await loadAgent(
    launchAgentPath(LAUNCHD_TICK_LABEL),
    launchdTickPlist(cmd, logPath)
  )
  // A plist in ~/Library/LaunchAgents also loads at next login, so even if
  // `load` fails now the agent activates then — report that honestly rather
  // than claiming it's already running.
  return {
    ok: true,
    mechanism: 'launchd',
    detail:
      loaded === 0
        ? `tick every minute, full sync daily around ${pad2(time.hour)}:${pad2(time.minute)} (${plistPath})`
        : `installed (${plistPath}) — activates at next login`,
  }
}

async function installSystemd(cmd: SyncCommand): Promise<InstallResult> {
  // systemd captures stdout/stderr in the journal (journalctl --user), so unlike
  // launchd there's no log file to point at here.
  // Probe the user manager before writing anything, so a box without systemd
  // (or without a user D-Bus) gets clean manual instructions and no litter.
  if ((await run('systemctl', ['--user', 'daemon-reload'])) !== 0) {
    return {
      ok: false,
      mechanism: 'manual',
      instructions: manualInstructions(cmd),
    }
  }
  const dir = join(homedir(), '.config', 'systemd', 'user')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${SYSTEMD_UNIT}.service`),
    systemdService(cmd),
    'utf8'
  )
  await writeFile(join(dir, `${SYSTEMD_UNIT}.timer`), systemdTimer(), 'utf8')
  await writeFile(
    join(dir, `${SYSTEMD_TICK_UNIT}.service`),
    systemdTickService(cmd),
    'utf8'
  )
  await writeFile(
    join(dir, `${SYSTEMD_TICK_UNIT}.timer`),
    systemdTickTimer(),
    'utf8'
  )
  await run('systemctl', ['--user', 'daemon-reload'])
  await run('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`])
  await run('systemctl', [
    '--user',
    'enable',
    '--now',
    `${SYSTEMD_TICK_UNIT}.timer`,
  ])
  return {
    ok: true,
    mechanism: 'systemd',
    detail: `systemd user timers (${SYSTEMD_TICK_UNIT}.timer every minute, ${SYSTEMD_UNIT}.timer daily); logs in journalctl --user -u ${SYSTEMD_UNIT}. To keep them running while logged out: loginctl enable-linger`,
  }
}

async function installSchtasks(cmd: SyncCommand): Promise<InstallResult> {
  const wrapperPath = syncWrapperPath()
  await mkdir(dirname(wrapperPath), { recursive: true })
  await writeFile(wrapperPath, schtasksWrapper(cmd, syncLogPath()), 'utf8')
  await writeFile(
    tickWrapperPath(),
    schtasksTickWrapper(cmd, syncLogPath()),
    'utf8'
  )
  // Randomize the time so installs don't all hit the API at the same instant.
  const time = {
    hour: Math.floor(Math.random() * 24),
    minute: Math.floor(Math.random() * 60),
  }
  // /F overwrites an existing task (idempotent re-install). Verbatim args so the
  // pre-quoted /TR path reaches schtasks intact. A non-zero exit (e.g. schtasks
  // absent, or policy blocks task creation) falls back to manual instructions.
  const created = await run('schtasks', schtasksCreateArgs(wrapperPath, time), {
    windowsVerbatimArguments: true,
  })
  if (created !== 0) {
    return {
      ok: false,
      mechanism: 'manual',
      instructions: manualInstructions(cmd),
    }
  }
  // The daily job is the one that must exist; a refused minutely task (some
  // policies cap task frequency) costs freshness, not the streak.
  const tick = await run(
    'schtasks',
    schtasksTickCreateArgs(tickWrapperPath()),
    { windowsVerbatimArguments: true }
  )
  return {
    ok: true,
    mechanism: 'schtasks',
    detail: `${tick === 0 ? 'tick every minute, ' : ''}full sync daily around ${pad2(time.hour)}:${pad2(time.minute)} (Task Scheduler task "${SCHTASKS_TASK}")`,
  }
}

/** Install (or refresh) both background jobs (tick + daily) for the current OS. */
export async function installDailySync(): Promise<InstallResult> {
  const cmd = resolveSyncCommand()
  try {
    await mkdir(dirname(syncLogPath()), { recursive: true }).catch(
      () => undefined
    )
    const os = platform()
    if (os === 'darwin') return await installLaunchd(cmd, syncLogPath())
    if (os === 'linux') return await installSystemd(cmd)
    if (os === 'win32') return await installSchtasks(cmd)
    return {
      ok: false,
      mechanism: 'unsupported',
      instructions: manualInstructions(cmd),
    }
  } catch {
    // A failed write (permissions, read-only home, …) must not crash the command
    // ritual — fall back to printable instructions.
    return {
      ok: false,
      mechanism: 'manual',
      instructions: manualInstructions(cmd),
    }
  }
}

/** Remove both background jobs. Best-effort and never throws, so it's safe to
 * call from `logout` whether or not they were ever installed. */
export async function uninstallDailySync(): Promise<void> {
  const os = platform()
  try {
    if (os === 'darwin') {
      for (const label of [LAUNCHD_LABEL, LAUNCHD_TICK_LABEL]) {
        const plistPath = launchAgentPath(label)
        await run('launchctl', ['unload', plistPath])
        await rm(plistPath, { force: true })
      }
    } else if (os === 'linux') {
      const dir = join(homedir(), '.config', 'systemd', 'user')
      for (const unit of [SYSTEMD_UNIT, SYSTEMD_TICK_UNIT]) {
        await run('systemctl', ['--user', 'disable', '--now', `${unit}.timer`])
        await rm(join(dir, `${unit}.timer`), { force: true })
        await rm(join(dir, `${unit}.service`), { force: true })
      }
      await run('systemctl', ['--user', 'daemon-reload'])
    } else if (os === 'win32') {
      await run('schtasks', ['/Delete', '/TN', SCHTASKS_TASK, '/F'])
      await run('schtasks', ['/Delete', '/TN', SCHTASKS_TICK_TASK, '/F'])
      await rm(syncWrapperPath(), { force: true })
      await rm(tickWrapperPath(), { force: true })
    }
  } catch {
    // best-effort
  }
}
