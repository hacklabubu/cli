import * as clack from '@clack/prompts'

import {
  appendSyncLog,
  clearSyncPaused,
  markSyncPaused,
  readSyncPaused,
  trimSyncLog,
} from '../daily-sync.js'
import { captureEvent } from '../posthog.js'
import {
  loadPromptConsent,
  parsePromptStatsFlag,
  resolvePromptConsent,
  savePromptConsent,
} from '../prompt-consent.js'
import {
  cumulativeTotals,
  loadScanState,
  markUploaded,
  rebuildScanState,
  runTick,
  type ScanState,
  sameTotals,
  saveScanState,
  tickPayload,
} from '../scanners/incremental.js'
import { collectToolScans, mergeToolScans } from '../scanners/index.js'
import { loadSessionState, type Session } from '../session.js'
import {
  checkSession,
  ensureFreshSession,
  formatTokens,
  LOGIN_EXPIRED_MESSAGE,
  refreshSession,
  runSync,
  SyncUploadError,
  scanConsentedPromptStats,
  syncGithubRepos,
  uploadTokenScan,
} from '../sync.js'
import { bold, dim, error, info, success } from '../ui.js'
import { daemon } from './daemon.js'

const SESSION_EXPIRED_REASON =
  'your hacklab session expired — run `hacklab login`'

/**
 * `hacklab sync` — dispatch on flags:
 *   (none)            interactive sync (scan, upload, show stats)
 *   --install-daily   deprecated alias for `hacklab daemon`
 *   --tick            the every-minute incremental run (usually a no-op)
 *   --quiet           the unattended daily run (logs to a file, no output)
 */
export async function sync(args: string[] = []): Promise<void> {
  // Pull --share-prompt-stats out first so it works alongside every mode
  // below (an agent can set consent on the same run that installs the daemon).
  const { tier: flagTier, rest } = parsePromptStatsFlag(args)
  if (flagTier) await savePromptConsent(flagTier)
  args = rest

  if (args.includes('--install-daily')) {
    // Kept working (it shipped, and installed CLIs / old docs still say it) but
    // no longer advertised: scheduling the daemon is `hacklab daemon` now, which
    // is what the web onboarding flow tells people to run.
    info(dim('`sync --install-daily` is now `hacklab daemon` — running that.'))
    return daemon()
  }
  if (args.includes('--tick')) return tickSync()
  if (args.includes('--quiet')) return quietSync()
  return interactiveSync()
}

/**
 * The unattended daily run (launchd/systemd invoke `hacklab sync --quiet`).
 * Silent by design — everything goes to ~/.hacklab/sync.log. Proactively
 * refreshes a near-expiry session; if the session has truly lapsed it drops a
 * paused marker the next interactive run surfaces, then exits cleanly.
 *
 * It's also the repair pass for the minutely tick: a full stateless scan, so
 * whatever the tick's tail-follow missed or double-counted is corrected here and
 * the tick's state is re-based on the result. Incremental drift therefore can't
 * outlive a day.
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
  const results = await collectToolScans()
  const scan = mergeToolScans(results)
  // Whatever the user already consented to. The unattended run never asks, so
  // a machine that has never answered uploads token counts only.
  const promptStats = await scanConsentedPromptStats(
    (await loadPromptConsent()) ?? 'none'
  )

  // Upload tokens AND mirror pinned repos together, so the after-refresh retry
  // below does the exact same work as the happy path (no silently-skipped repo
  // sync on a day the session had to be refreshed mid-run). The state rebuild
  // rides along: everything just went out, so nothing is left dirty.
  const push = async (s: Session) => {
    await uploadTokenScan(s, scan, { promptStats })
    await rebuildScanState(results)
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

/** How long to sit out after a 429 that came without a Retry-After. */
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000

function backoffMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BACKOFF_MS
  return Math.min(seconds * 1000, MAX_BACKOFF_MS)
}

/**
 * Log a tick failure once. A minutely job that keeps hitting the same wall (no
 * network, server down) would otherwise write 1440 identical lines a day, so the
 * first one goes in and the rest are suppressed until something changes.
 */
async function logTickError(state: ScanState, line: string): Promise<void> {
  if (state.lastError === line) return
  state.lastError = line
  await appendSyncLog(line)
}

/** Pause the background sync, logging it only the first time. */
async function pauseTick(reason: string): Promise<void> {
  const alreadyPaused = await readSyncPaused()
  await markSyncPaused(reason)
  if (!alreadyPaused) await appendSyncLog(`tick paused: ${reason}`)
}

/**
 * `hacklab sync --tick` — the every-minute run. Where `--quiet` re-scans every
 * log from scratch (~6s and a few hundred MB for a heavy user), this reads only
 * what the AI tools appended since the last tick, and on the overwhelmingly
 * common minute where nothing was appended it exits after a stat walk, without
 * touching the network. Silent unless it uploaded, failed, or got paused: the
 * log has to survive 1440 runs a day.
 */
async function tickSync(): Promise<void> {
  const saved = await loadScanState()
  // The server asked us to back off — respect it before doing any work at all.
  if (saved?.nextAllowedAt && Date.now() < saved.nextAllowedAt) return
  await trimSyncLog()

  const sessionState = await loadSessionState()
  if (!sessionState.session) {
    // 'missing' is a logged-out machine: nothing to say, every minute.
    if (
      sessionState.status === 'expired' ||
      sessionState.status === 'invalid'
    ) {
      await pauseTick(
        sessionState.status === 'invalid'
          ? 'your hacklab session file is unreadable — run `hacklab login`'
          : SESSION_EXPIRED_REASON
      )
    }
    return
  }
  const session = await ensureFreshSession(sessionState.session)

  const { state, changed } = await runTick(saved)
  const totals = cumulativeTotals(state)
  if (
    state.dirty.length === 0 &&
    sameTotals(totals.toolTotals, state.uploaded.toolTotals) &&
    sameTotals(totals.modelTotals, state.uploaded.modelTotals)
  ) {
    // The common case: nothing new to say. Persist only if the walk actually
    // saw something move (a touched file, a re-read harness).
    if (changed) await saveScanState(state)
    return
  }

  const scan = tickPayload(state)
  const dates = state.dirty.length
  // No prompt stats and no GitHub mirror: those are the daily job's work, and a
  // minutely run has no business re-reading transcripts. Not interactive either
  // — a background tick isn't user activity.
  try {
    const result = await uploadTokenScan(session, scan)
    markUploaded(state)
    await saveScanState(state)
    await clearSyncPaused()
    await appendSyncLog(
      `tick: +${formatTokens(Number(result.tokensDelta ?? 0))} tokens (${dates} date${dates === 1 ? '' : 's'})`
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = e instanceof SyncUploadError ? e.status : 0

    if (status === 429) {
      const wait = backoffMs(e instanceof SyncUploadError ? e.retryAfter : null)
      state.nextAllowedAt = Date.now() + wait
      await logTickError(
        state,
        `tick: rate limited, pausing ${Math.round(wait / 1000)}s`
      )
      await saveScanState(state)
      return
    }

    if (message === LOGIN_EXPIRED_MESSAGE) {
      const refreshed = await refreshSession(session)
      if (refreshed) {
        try {
          const result = await uploadTokenScan(refreshed, scan)
          markUploaded(state)
          await saveScanState(state)
          await clearSyncPaused()
          await appendSyncLog(
            `tick: +${formatTokens(Number(result.tokensDelta ?? 0))} tokens (${dates} dates, after refresh)`
          )
          return
        } catch {
          // fall through to pause
        }
      }
      await saveScanState(state)
      await pauseTick(SESSION_EXPIRED_REASON)
      return
    }

    // Dirty dates stay dirty, so the next tick retries them.
    await logTickError(state, `tick error: ${message}`)
    await saveScanState(state)
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

  // Ask before scanning anything conversational. Asked once, then remembered;
  // an unanswered or non-TTY run resolves to 'none'.
  const promptConsent = await resolvePromptConsent(null, { interactive: true })

  console.log('')
  console.log(bold('  hacklab sync'))
  console.log(dim('  scanning local AI tool usage...'))
  console.log('')

  let result: Awaited<ReturnType<typeof runSync>>
  try {
    // Manual `hacklab sync` — tag the upload as interactive so the backend counts
    // it as user activity (the daily background job and join's upload don't).
    result = await runSync(session, { interactive: true, promptConsent })
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

  if (result.promptStats) {
    const { totalPrompts } = result.promptStats
    info(
      `  prompts      ${formatTokens(totalPrompts)} scanned${
        promptConsent === 'full' ? dim(' (+ text sample)') : ''
      }`
    )
    // The backend can only attach a project's count if the repo matches one of
    // this user's own projects. Reporting the match rate keeps a scan that
    // matched nothing from reading as a success.
    const summary = result.result.promptStats as
      | { projectsMatched?: number; projectsReported?: number }
      | undefined
    const reported = summary?.projectsReported ?? 0
    const matched = summary?.projectsMatched ?? 0
    if (reported > 0 && matched === 0) {
      info(
        dim(
          `  none of your ${reported} local repos matched a hacklab project — run \`hacklab brag\` in one`
        )
      )
    } else if (matched > 0) {
      info(dim(`  matched ${matched} of ${reported} local repos to projects`))
    }
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
