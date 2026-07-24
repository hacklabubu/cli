import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { getSessionPath } from './session.js'

// Sets up (and tears down) an OS-native daily run of `hacklab sync --quiet`:
// launchd on macOS, a systemd user timer on Linux, and printed instructions
// when neither fits. The scheduled command is resolved to an absolute
// `node <entry>` pair so a scheduler running with a bare PATH (cron/launchd/
// systemd often have almost none) can launch it without a `hacklab` shim.

const LAUNCHD_LABEL = 'so.hacklab.sync'
const SYSTEMD_UNIT = 'hacklab-sync'
const SCHTASKS_TASK = 'hacklab-sync'

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

export function launchdPlist(
  cmd: SyncCommand,
  time: { hour: number; minute: number },
  logPath: string
): string {
  const args = [cmd.node, cmd.script, 'sync', '--quiet']
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${time.hour}</integer>
    <key>Minute</key>
    <integer>${time.minute}</integer>
  </dict>
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

/** Where the Windows scheduled task's wrapper batch file lives. Next to the
 * session file so it honors HACKLAB_SESSION_PATH, mirroring syncLogPath(). */
export function syncWrapperPath(): string {
  return join(dirname(getSessionPath()), 'hacklab-sync.cmd')
}

/** The batch wrapper Task Scheduler runs. schtasks' `/TR` chokes on the nested
 * quotes a full `"node" "script" …` command needs, so we point the task at this
 * one-line .cmd instead and do the quoting here, where plain-batch rules apply.
 * Output is redirected to the same sync.log the job also appends to, so a crash
 * before the CLI's own logging still leaves a trace. */
export function schtasksWrapper(cmd: SyncCommand, logPath: string): string {
  return `@echo off\r\n"${cmd.node}" "${cmd.script}" sync --quiet >> "${logPath}" 2>&1\r\n`
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

// Generic fallback text, reused for both "Linux without a systemd user manager"
// and "OS we don't auto-schedule on" — so it must not name a specific mechanism.
export function manualInstructions(cmd: SyncCommand): string {
  return [
    "Couldn't set up an automatic daily sync on this system.",
    'To run it yourself, schedule this command to run once a day with cron, a',
    "systemd timer, or your init system's scheduler:",
    `  "${cmd.node}" "${cmd.script}" sync --quiet`,
  ].join('\n')
}

async function installLaunchd(
  cmd: SyncCommand,
  logPath: string
): Promise<InstallResult> {
  const plistPath = join(
    homedir(),
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL}.plist`
  )
  // Randomize the time so installs don't all hit the API at the same instant.
  const time = {
    hour: Math.floor(Math.random() * 24),
    minute: Math.floor(Math.random() * 60),
  }
  await mkdir(dirname(plistPath), { recursive: true })
  await writeFile(plistPath, launchdPlist(cmd, time, logPath), 'utf8')
  // Reload idempotently. A plist in ~/Library/LaunchAgents also loads at next
  // login, so even if `load` fails now the agent activates then — report that
  // honestly rather than claiming it's already running.
  await run('launchctl', ['unload', plistPath])
  const loaded = await run('launchctl', ['load', '-w', plistPath])
  return {
    ok: true,
    mechanism: 'launchd',
    detail:
      loaded === 0
        ? `daily around ${pad2(time.hour)}:${pad2(time.minute)} (${plistPath})`
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
  await run('systemctl', ['--user', 'daemon-reload'])
  await run('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`])
  return {
    ok: true,
    mechanism: 'systemd',
    detail: `systemd user timer (${SYSTEMD_UNIT}.timer); logs in journalctl --user -u ${SYSTEMD_UNIT}. To keep it running while logged out: loginctl enable-linger`,
  }
}

async function installSchtasks(cmd: SyncCommand): Promise<InstallResult> {
  const wrapperPath = syncWrapperPath()
  await mkdir(dirname(wrapperPath), { recursive: true })
  await writeFile(wrapperPath, schtasksWrapper(cmd, syncLogPath()), 'utf8')
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
  return {
    ok: true,
    mechanism: 'schtasks',
    detail: `daily around ${pad2(time.hour)}:${pad2(time.minute)} (Task Scheduler task "${SCHTASKS_TASK}")`,
  }
}

/** Install (or refresh) the daily background sync for the current OS. */
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
    // A failed write (permissions, read-only home, …) must not crash the join
    // ritual — fall back to printable instructions.
    return {
      ok: false,
      mechanism: 'manual',
      instructions: manualInstructions(cmd),
    }
  }
}

/** Remove the daily background sync. Best-effort and never throws, so it's safe
 * to call from `logout` whether or not it was ever installed. */
export async function uninstallDailySync(): Promise<void> {
  const os = platform()
  try {
    if (os === 'darwin') {
      const plistPath = join(
        homedir(),
        'Library',
        'LaunchAgents',
        `${LAUNCHD_LABEL}.plist`
      )
      await run('launchctl', ['unload', plistPath])
      await rm(plistPath, { force: true })
    } else if (os === 'linux') {
      await run('systemctl', [
        '--user',
        'disable',
        '--now',
        `${SYSTEMD_UNIT}.timer`,
      ])
      const dir = join(homedir(), '.config', 'systemd', 'user')
      await rm(join(dir, `${SYSTEMD_UNIT}.timer`), { force: true })
      await rm(join(dir, `${SYSTEMD_UNIT}.service`), { force: true })
      await run('systemctl', ['--user', 'daemon-reload'])
    } else if (os === 'win32') {
      await run('schtasks', ['/Delete', '/TN', SCHTASKS_TASK, '/F'])
      await rm(syncWrapperPath(), { force: true })
    }
  } catch {
    // best-effort
  }
}
