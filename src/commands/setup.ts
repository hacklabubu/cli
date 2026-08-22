import * as clack from '@clack/prompts'

import { dailySyncState, installDailySync } from '../daily-sync.js'
import { captureEvent, identifyUser } from '../posthog.js'
import {
  loadPromptConsent,
  type PromptConsentTier,
  savePromptConsent,
} from '../prompt-consent.js'
import { rebuildScanState } from '../scanners/incremental.js'
import {
  collectToolScans,
  mergeToolScans,
  type ScanResult,
} from '../scanners/index.js'
import {
  loadSession,
  resolveAppUrl,
  type Session,
  saveSession,
} from '../session.js'
import { scanConsentedPromptStats, uploadTokenScan } from '../sync.js'
import { bold, dim, error, info, success } from '../ui.js'
import { ensureHandleClaimed, performLogin } from './login.js'
import { formatScanReceipt } from './scan.js'

/**
 * `hacklab setup` — the front door.
 *
 *   scan → anonymous rank → GitHub auth → one consent question → upload → daemon
 *
 * The one deliberate composite command in the CLI (DESIGN.md's "one job per
 * command" carries a recorded exception for it): face-to-face testing showed
 * that install → `login` → `scan` reads as three unrelated chores to someone who
 * has never used hacklab, and people stalled between them. Each stage still
 * degrades on its own terms, and every piece remains its own command for anyone
 * who wants to re-run just that piece.
 */
export async function setup(): Promise<void> {
  clack.intro(bold('Hacklab CLI setup'))
  console.log(
    dim(
      'scans your AI usage, connects GitHub, and starts a background usage sync'
    )
  )
  console.log('')

  const existing = await loadSession()
  const appUrl = resolveAppUrl(existing)
  const syncState = await dailySyncState()

  // ── Already set up ───────────────────────────────────────────────────────
  // A finished account AND a live daemon means there is genuinely nothing to
  // do. Anything less falls through and skips only the stages already done.
  if (existing?.handle && existing.usernameClaimed && syncState === 'current') {
    console.log(`already set up — you're ${bold(`@${existing.handle}`)}`)
    console.log(
      dim('re-scan with `hacklab scan`, re-upload with `hacklab sync`')
    )
    clack.outro(dim(`${appUrl}/${existing.handle}`))
    return
  }

  // ── Scan (before auth — an anonymous scan needs no account) ──────────────
  const spin = clack.spinner()
  spin.start('scanning local AI tool usage')
  let results: ScanResult[]
  try {
    results = await collectToolScans()
  } catch (err) {
    spin.stop('scan failed')
    clack.cancel(
      `couldn't read local AI usage: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }
  spin.stop('scan complete')

  const scan = mergeToolScans(results)

  if (scan.grandTotal > 0) {
    console.log('')
    for (const line of formatScanReceipt(scan)) console.log(line)
    console.log('')
  } else {
    // No hard floor: a hackathon-door signup on a fresh laptop is exactly who
    // this flow is for, so the default is yes.
    const cont = await clack.confirm({
      message: 'No AI usage found on this machine. Set up your account anyway?',
      initialValue: true,
    })
    if (clack.isCancel(cont) || !cont) {
      clack.outro(
        dim('come back after some Claude Code / Codex / Cursor sessions.')
      )
      return
    }
  }

  // ── Anonymous rank preview (a hook, never a gate) ────────────────────────
  let previewRank: number | undefined
  if (scan.grandTotal > 0) {
    const preview = await fetchRankPreview(appUrl, scan.grandTotal)
    if (preview) {
      previewRank = preview.rank
      console.log(
        `${bold(`you'd be #${preview.rank}`)} of ${preview.ofTotal} hackers`
      )
      console.log('')
    }
  }

  // ── GitHub auth (the exact device flow `hacklab login` runs) ─────────────
  let session: Session
  let claimFailed: boolean
  if (existing) {
    // Reuse a session that's already on disk. It may still be half-finished
    // (auth succeeded, the claim didn't), so run the claim guard over it.
    const outcome = await ensureHandleClaimed(existing, 2)
    if (outcome.session !== existing) await saveSession(outcome.session)
    session = outcome.session
    claimFailed = outcome.claimFailed
    console.log(
      session.handle
        ? `signed in as @${session.handle}`
        : `signed in as ${session.email}`
    )
    console.log('')
  } else {
    try {
      const outcome = await performLogin({ claimAttempts: 2 })
      session = outcome.session
      claimFailed = outcome.claimFailed
    } catch (err) {
      clack.cancel(
        `GitHub sign-in failed: ${err instanceof Error ? err.message : String(err)}. run \`hacklab setup\` again.`
      )
      process.exit(1)
    }
    console.log('')
    console.log(
      session.handle
        ? `signed in as @${session.handle}`
        : `signed in as ${session.email}`
    )
    console.log('')
  }

  // A lost claim must never be silent here: the web onboarding page polls
  // `username_claimed` and would sit spinning forever.
  if (claimFailed) {
    error("couldn't finish claiming your handle")
    info(dim('run `hacklab login` again to finish it'))
    console.log('')
  }

  // ── The one question in the flow ─────────────────────────────────────────
  const consent = await askConversationConsent()

  // ── Upload ───────────────────────────────────────────────────────────────
  spin.start('saving your usage')
  let rank: number | undefined
  try {
    const promptStats = await scanConsentedPromptStats(consent)
    const uploaded = await uploadTokenScan(session, scan, {
      interactive: true,
      timeoutMs: 120_000,
      promptStats,
    })
    // A full scan just went out, so re-base the minutely tick's incremental
    // state on it — otherwise the first tick re-uploads the whole history.
    await rebuildScanState(results)
    spin.stop('usage saved')
    const after = uploaded.rankAfter
    if (typeof after === 'number' && Number.isFinite(after)) rank = after
    if (rank) console.log(`rank: #${rank}`)
  } catch {
    // Never fatal — the account exists, and `hacklab sync` is the recovery.
    spin.stop('usage sync deferred')
    console.log(dim('run `hacklab sync` later to upload it'))
  }

  // ── Daemon (silent; the intro line is the whole disclosure) ──────────────
  await installDaemon(syncState, session.handle)

  // ── Tail ─────────────────────────────────────────────────────────────────
  console.log('')
  success(
    session.handle ? `you're in — ${appUrl}/${session.handle}` : "you're in"
  )
  clack.outro(
    dim('head back to your browser — the page will move on by itself')
  )

  if (session.handle) {
    await identifyUser(session.handle, {
      $set: {
        email: session.email,
        handle: session.handle,
        app_url: appUrl,
      },
      $set_once: { joined_at: new Date().toISOString() },
    })
    await captureEvent(session.handle, 'cli_setup_completed', {
      tokens_total: scan.grandTotal,
      ...((rank ?? previewRank) ? { rank: rank ?? previewRank } : {}),
      prompt_consent: consent,
    })
  }
}

/**
 * Ask once whether to share conversation text, defaulting to yes.
 *
 * Deliberately NOT prompt-consent.ts's `askYesNo` (which refuses to carry a
 * default): setup is the one place a default-yes is the product decision, and
 * `clack.confirm` with `initialValue: true` still requires the user to accept it
 * — a keypress they perform, not a value applied behind their back. `sync`'s
 * no-default disclosure is untouched. A non-TTY run has nobody to accept, so it
 * stays at 'none'.
 */
async function askConversationConsent(): Promise<PromptConsentTier> {
  const stored = await loadPromptConsent()
  if (stored) {
    console.log(
      dim(
        `conversation sharing: ${stored} — change with \`hacklab config prompt-stats <full|stats|none>\``
      )
    )
    console.log('')
    return stored
  }

  if (!process.stdin.isTTY) return 'none'

  console.log(bold('share your prompts?'))
  console.log(
    'hacklab scores how well you work with AI. your real prompts give the'
  )
  console.log(
    'scoring model actual evidence — a sharper score, and a profile that'
  )
  console.log(
    'stands out. a sample of up to 20,000 characters is read by the model,'
  )
  console.log('scored, and discarded. never stored, never shown to anyone.')
  console.log(
    dim('change anytime: hacklab config prompt-stats <full|stats|none>')
  )
  console.log('')

  const answer = await clack.confirm({
    message: 'share a sample of your prompts?',
    initialValue: true,
  })
  // Only the two tiers that were actually asked about. 'stats' (numbers, no
  // text) was never on the table here; it stays reachable via `hacklab config`.
  const tier: PromptConsentTier =
    !clack.isCancel(answer) && answer === true ? 'full' : 'none'
  await savePromptConsent(tier)
  return tier
}

/** The anonymous "you'd be #N of M" call. Any failure is skipped in silence. */
async function fetchRankPreview(
  appUrl: string,
  totalTokens: number
): Promise<{ rank: number; ofTotal: number } | null> {
  try {
    const res = await fetch(`${appUrl}/api/rank/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalTokens }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { rank?: number; ofTotal?: number }
    if (typeof data.rank !== 'number' || typeof data.ofTotal !== 'number') {
      return null
    }
    return { rank: data.rank, ofTotal: data.ofTotal }
  } catch {
    return null
  }
}

/**
 * Arm the background sync without asking — the intro line already disclosed it.
 * Same install-once / repair-'stale' rules `scan` uses: a reinstall rewrites the
 * plists/units and bounces the jobs, so only touch the scheduler when something
 * is actually wrong, and only announce a genuinely fresh install.
 */
async function installDaemon(
  state: Awaited<ReturnType<typeof dailySyncState>>,
  handle: string | undefined
): Promise<void> {
  if (state === 'current') return

  const result = await installDailySync()
  if (!result.ok) {
    // A failed *repair* means the jobs are still scheduled — printing cron
    // instructions there talks the user into a second, duplicate schedule.
    if (state === 'missing') {
      console.log(dim(result.instructions))
      if (handle) {
        await captureEvent(handle, 'cli_daily_sync_manual', {
          mechanism: result.mechanism,
          source: 'setup',
        })
      }
    }
    return
  }
  if (!result.recorded) {
    console.log(dim('could not record daily-sync state — config unwritable'))
    return
  }
  if (state === 'missing') {
    console.log(dim(`background sync scheduled (${result.mechanism})`))
    if (handle) {
      await captureEvent(handle, 'cli_daily_sync_installed', {
        mechanism: result.mechanism,
        source: 'setup',
      })
    }
  }
}
