import * as clack from '@clack/prompts'

import {
  appendSyncLog,
  clearSyncPaused,
  markSyncPaused,
} from '../daily-sync.js'
import { captureEvent } from '../posthog.js'
import { scanAllTools } from '../scanners/index.js'
import { loadSessionState, type Session } from '../session.js'
import {
  checkSession,
  ensureFreshSession,
  formatTokens,
  LOGIN_EXPIRED_MESSAGE,
  refreshSession,
  runSync,
  syncGithubRepos,
  uploadTokenScan,
} from '../sync.js'
import { bold, dim, error, info, success } from '../ui.js'
import { demon } from './demon.js'

const SESSION_EXPIRED_REASON =
  'your hacklab session expired — run `hacklab login`'

/**
 * `hacklab sync` — dispatch on flags:
 *   (none)            interactive sync (scan, upload, show stats)
 *   --install-daily   deprecated alias for `hacklab demon`
 *   --quiet           the unattended daily run (logs to a file, no output)
 */
export async function sync(args: string[] = []): Promise<void> {
  if (args.includes('--install-daily')) {
    // Kept working (it shipped, and installed CLIs / old docs still say it) but
    // no longer advertised: scheduling the daemon is `hacklab demon` now, which
    // is what the web onboarding flow tells people to run.
    info(dim('`sync --install-daily` is now `hacklab demon` — running that.'))
    return demon()
  }
  if (args.includes('--quiet')) return quietSync()
  return interactiveSync()
}

/**
 * The unattended daily run (launchd/systemd invoke `hacklab sync --quiet`).
 * Silent by design — everything goes to ~/.hacklab/sync.log. Proactively
 * refreshes a near-expiry session; if the session has truly lapsed it drops a
 * paused marker the next interactive run surfaces, then exits cleanly.
 */
async function quietSync(): Promise<void> {
  const state = await loadSessionState()
  if (!state.session) {
    await appendSyncLog(`skip: ${state.status}`)
    // 'expired' or 'invalid' (corrupt/unparseable file) both mean the user must
    // log in again — surface it. 'missing' means logged out / never set up, so
    // stay silent (nothing to pause).
    if (state.status === 'expired' || state.status === 'invalid') {
      await markSyncPaused(
        state.status === 'invalid'
          ? 'your hacklab session file is unreadable — run `hacklab login`'
          : SESSION_EXPIRED_REASON
      )
    }
    return
  }

  const session = await ensureFreshSession(state.session)
  const scan = await scanAllTools()

  // Upload tokens AND mirror pinned repos together, so the after-refresh retry
  // below does the exact same work as the happy path (no silently-skipped repo
  // sync on a day the session had to be refreshed mid-run).
  const push = async (s: Session) => {
    await uploadTokenScan(s, scan)
    await syncGithubRepos(s)
  }

  try {
    await push(session)
    await clearSyncPaused()
    await appendSyncLog('ok')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== LOGIN_EXPIRED_MESSAGE) {
      await appendSyncLog(`error: ${msg}`)
      return
    }
    // Proactive refresh missed it — try once more, then pause.
    const refreshed = await refreshSession(session)
    if (refreshed) {
      try {
        await push(refreshed)
        await clearSyncPaused()
        await appendSyncLog('ok (after refresh)')
        return
      } catch {
        // fall through to pause
      }
    }
    await markSyncPaused(SESSION_EXPIRED_REASON)
    await appendSyncLog('paused: session expired')
  }
}

async function interactiveSync() {
  const sessionState = await loadSessionState()
  if (!sessionState.session) {
    error(sessionState.status === 'expired' ? 'login expired' : 'not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }

  // Fail fast with clear diagnostics (auth / wrong-backend / server-down) before
  // scanning and uploading.
  const sessionCheck = await checkSession(sessionState.session)
  if (sessionCheck.status === 'unauthorized') {
    error('login expired')
    info(`run ${dim('hacklab login')} again`)
    process.exit(1)
  }
  if (sessionCheck.status === 'failed') {
    error(sessionCheck.message)
    process.exit(1)
  }

  // Proactively slide a near-expiry session forward — same behavior as the daily
  // job, so expiry management doesn't differ by entry point.
  const session = await ensureFreshSession(sessionState.session)

  console.log('')
  console.log(bold('  hacklab sync'))
  console.log(dim('  scanning local AI tool usage...'))
  console.log('')

  let result: Awaited<ReturnType<typeof runSync>>
  try {
    // Manual `hacklab sync` — tag the upload as interactive so the backend counts
    // it as user activity (the daily background job and join's upload don't).
    result = await runSync(session, { interactive: true })
  } catch (e) {
    error(e instanceof Error ? e.message : 'sync failed')
    process.exit(1)
  }

  const {
    claudeTotal,
    codexTotal,
    cursorTotal,
    openclawTotal,
    hermesTotal,
    opencodeTotal,
    cursorScanStatus,
    result: r,
  } = result

  if (claudeTotal > 0)
    info(`  Claude Code  ${formatTokens(claudeTotal)} tokens`)
  if (codexTotal > 0) info(`  Codex        ${formatTokens(codexTotal)} tokens`)
  if (cursorTotal > 0)
    info(`  Cursor       ${formatTokens(cursorTotal)} tokens`)
  if (openclawTotal > 0)
    info(`  OpenClaw     ${formatTokens(openclawTotal)} tokens`)
  if (hermesTotal > 0)
    info(`  Hermes       ${formatTokens(hermesTotal)} tokens`)
  if (opencodeTotal > 0)
    info(`  OpenCode     ${formatTokens(opencodeTotal)} tokens`)

  // A key Cursor rejected must never be silent: the Cursor line above would be
  // the local estimate while the user believes they're getting exact counts.
  if (cursorScanStatus.source === 'api-failed') {
    error(`  cursor: ${cursorScanStatus.reason}`)
    info(
      dim('  fell back to a local estimate — the Cursor number above is rough')
    )
    info(dim('  fix it with `hacklab config cursor-api-key <key>`'))
  } else if (cursorScanStatus.source === 'api-partial') {
    info(dim(`  cursor: partial scan — ${cursorScanStatus.reason}`))
  }

  console.log('')
  success(
    `  ${bold(String(r.title))} lv.${r.level} — ${formatTokens(Number(r.tokensTotal))} total`
  )
  if (Number(r.tokensDelta) > 0) {
    info(`  +${formatTokens(Number(r.tokensDelta))} since last sync`)
  }

  // Mirror pinned GitHub repos into projects (best-effort; never fails sync).
  const repos = await syncGithubRepos(session)
  if (repos && (repos.synced > 0 || repos.removed > 0)) {
    const parts = [`${repos.synced} project${repos.synced === 1 ? '' : 's'}`]
    if (repos.removed > 0) parts.push(`removed ${repos.removed}`)
    info(`  github: ${parts.join(', ')}`)
  }

  await captureEvent(session.handle, 'cli_sync_completed', {
    tokens_claude: claudeTotal,
    tokens_codex: codexTotal,
    tokens_cursor: cursorTotal,
    tokens_openclaw: openclawTotal,
    tokens_hermes: hermesTotal,
    tokens_opencode: opencodeTotal,
    level: r.level,
    title: r.title,
  })

  clack.outro(dim('synced.'))
}
