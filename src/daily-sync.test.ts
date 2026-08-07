import { describe, expect, it } from 'vitest'

import {
  launchdPlist,
  launchdTickPlist,
  manualInstructions,
  resolveSyncCommand,
  schtasksCreateArgs,
  schtasksTickCreateArgs,
  schtasksTickWrapper,
  schtasksWrapper,
  systemdService,
  systemdTickService,
  systemdTickTimer,
  systemdTimer,
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
    const resolved = resolveSyncCommand()
    expect(resolved.node).toBe(process.execPath)
    expect(typeof resolved.script).toBe('string')
    expect(resolved.script.length).toBeGreaterThan(0)
  })
})
