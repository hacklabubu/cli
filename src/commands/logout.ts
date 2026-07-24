import { clearSyncPaused, uninstallDailySync } from '../daily-sync.js'
import { captureEvent } from '../posthog.js'
import { clearSession, loadSession } from '../session.js'
import { dim, info, success } from '../ui.js'

export async function logout() {
  // Read who we're logged in as first (for the confirmation), then clear.
  const session = await loadSession()
  const removed = await clearSession()

  // Tear down the daily background sync — it can't run without a session, and a
  // leftover schedule would just log failures forever. Best-effort, no output.
  await uninstallDailySync()
  await clearSyncPaused()

  if (!removed) {
    info('not logged in')
    return
  }

  const who = session?.handle ?? session?.email
  success(who ? `logged out (${who})` : 'logged out')
  info(dim('run `hacklab login` to sign back in'))

  await captureEvent(session?.handle, 'cli_logout')
}
