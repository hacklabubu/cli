import {
  clearSyncPaused,
  installDailySync,
  syncLogPath,
  uninstallDailySync,
} from '../daily-sync.js'
import { captureEvent } from '../posthog.js'
import { loadSession } from '../session.js'
import { dim, error, info, success } from '../ui.js'

/**
 * `hacklab daemon` — arm the background sync, as its own explicit step.
 *
 *   hacklab daemon        summon it (install/refresh the OS-native jobs)
 *   hacklab daemon off    dismiss it (tear the schedule down)
 *
 * Two cadences, one command: a token tick every minute (incremental — it reads
 * only what your tools appended since the last run) and a full sync once a day
 * that re-scans everything and repairs whatever the tick got wrong.
 *
 * This used to be a side effect of signup (and a flag on `sync`), which made it
 * invisible: users couldn't tell whether anything was scheduled, and the web
 * onboarding had no step to point at. Now it's a command the onboarding flow
 * tells people to run, so arming the daemon is a thing you *did*, not a thing
 * that happened to you. Re-running is idempotent — the installers overwrite the
 * existing schedule rather than stacking a second one.
 */
export async function daemon(args: string[] = []): Promise<void> {
  if (args.includes('off') || args.includes('--off')) return dismiss()
  return summon()
}

/** Install (or refresh) the background sync jobs. Requires a session — they run
 * as this user and upload to their profile. */
async function summon(): Promise<void> {
  const session = await loadSession()
  if (!session) {
    error('not logged in')
    info(
      `run ${dim('hacklab login')} first`
    )
    process.exit(1)
  }

  const result = await installDailySync()
  if (result.ok) {
    success(
      `daemon summoned — token tick every minute, full sync daily, via ${result.mechanism}`
    )
    info(dim(`  ${result.detail}`))
    info(dim(`  log: ${syncLogPath()}`))
    info(dim('  dismiss it with `hacklab daemon off` (logout removes it too)'))
    await captureEvent(session.handle, 'cli_daily_sync_installed', {
      mechanism: result.mechanism,
      source: 'daemon',
    })
    return
  }

  // Nothing was scheduled: a platform we don't auto-schedule on (e.g. BSD) or a
  // failed scheduler write. Say so plainly and print the copy-paste cron
  // commands — silently reporting success here would cost the user their streak.
  error("couldn't schedule the background sync on this system")
  info(result.instructions)
  await captureEvent(session.handle, 'cli_daily_sync_manual', {
    mechanism: result.mechanism,
  })
}

/** Tear the schedule down. Deliberately does NOT require a session: a lapsed or
 * cleared session is exactly when someone wants the leftover job gone. */
async function dismiss(): Promise<void> {
  const session = await loadSession()
  await uninstallDailySync()
  await clearSyncPaused()
  success('daemon dismissed — no more background sync')
  info(dim('run `hacklab daemon` to summon it again'))
  await captureEvent(session?.handle, 'cli_daily_sync_removed')
}
