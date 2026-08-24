import * as clack from '@clack/prompts'

import {
  findAgentCli,
  launchAgentCli,
  notifyAgentHandoff,
} from '../agent-handoff.js'
import { dailySyncState, installDailySync } from '../daily-sync.js'
import { captureEvent, identifyUser } from '../posthog.js'
import {
  loadPromptConsent,
  type PromptConsentTier,
  savePromptConsent,
} from '../prompt-consent.js'
import { rebuildScanState } from '../scanners/incremental.js'
import {
  type AggregateScan,
  collectToolScans,
  mergeToolScans,
  type ScanResult,
} from '../scanners/index.js'
import { formatTokens } from '../scanners/util.js'
import {
  loadSession,
  resolveAppUrl,
  type Session,
  saveSession,
} from '../session.js'
import { scanConsentedPromptStats, uploadTokenScan } from '../sync.js'
import { bold, dim } from '../ui.js'
import { waitForBareEnter } from '../utils/waitForEnter.js'
import { ensureHandleClaimed, performLogin } from './login.js'
import { PROFILE_SETUP_PROMPT } from './rtfm.js'
import { TOOL_LABELS } from './scan.js'
import { canRedraw, railAgentOffer, railDeviceCode } from './setup-rail.js'

/**
 * `hacklab setup` — the front door.
 *
 *   scan → anonymous rank → GitHub auth → one consent question → upload →
 *   daemon → hand the profile work to a coding agent
 *
 * The one deliberate composite command in the CLI (DESIGN.md's "one job per
 * command" carries a recorded exception for it): face-to-face testing showed
 * that install → `login` → `scan` reads as three unrelated chores to someone who
 * has never used hacklab, and people stalled between them. Each stage still
 * degrades on its own terms, and every piece remains its own command for anyone
 * who wants to re-run just that piece.
 *
 * It is also the one command allowed clack chrome, and it spends that allowance
 * on being *one* flow: every line goes on the step rail, and every stage ends as
 * a single line naming the stage and how it went. What a stage shows while it is
 * working — the per-tool receipt, the GitHub code — has done its job by the time
 * the next stage starts, so it comes back off the screen. `setup-rail.ts` holds
 * the two blocks clack has no widget for.
 */
export async function setup(): Promise<void> {
  clack.intro(bold('Hacklab CLI setup'))
  clack.log.message(
    dim(
      'scans your AI usage, connects GitHub, and starts a background usage sync'
    )
  )

  const existing = await loadSession()
  const appUrl = resolveAppUrl(existing)
  const syncState = await dailySyncState()

  // ── Already set up ───────────────────────────────────────────────────────
  // A finished account AND a live daemon means there is genuinely nothing to
  // do. Anything less falls through and skips only the stages already done.
  if (existing?.handle && existing.usernameClaimed && syncState === 'current') {
    clack.log.step(`already set up — you're ${bold(`@${existing.handle}`)}`)
    clack.log.message(
      dim('re-scan with `hacklab scan`, re-upload with `hacklab sync`'),
      { spacing: 0 }
    )
    clack.outro(dim(`${appUrl}/${existing.handle}`))
    return
  }

  // ── Scan (before auth — an anonymous scan needs no account) ──────────────
  const scanStep = startScanStep()
  let results: ScanResult[]
  try {
    results = await collectToolScans()
  } catch (err) {
    scanStep.failed('scan failed')
    clack.cancel(
      `couldn't read local AI usage: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }

  const scan = mergeToolScans(results)

  // The per-tool tally is worth reading while the rank call is in flight and
  // worth nothing after it — `hacklab scan` is where it lives permanently, and
  // the share card carries it onward. So it goes inside the step, and leaves
  // with it.
  for (const line of scanNotes(scan)) scanStep.note(line)

  // ── Anonymous rank preview (a hook, never a gate) ────────────────────────
  const preview =
    scan.grandTotal > 0 ? await fetchRankPreview(appUrl, scan.grandTotal) : null

  scanStep.done(scanSummary(scan))
  if (preview) {
    clack.log.step(
      `you'd be #${preview.rank} of ${preview.ofTotal.toLocaleString('en-US')} hackers`
    )
  }

  if (scan.grandTotal === 0) {
    // No hard floor: a hackathon-door signup on a fresh laptop is exactly who
    // this flow is for, so the default is yes. The step above already said
    // there is nothing here, so the question only has to be the question.
    const cont = await clack.confirm({
      message: 'set up your account anyway?',
      initialValue: true,
    })
    if (clack.isCancel(cont) || !cont) {
      clack.outro(
        dim('come back after some Claude Code / Codex / Cursor sessions.')
      )
      return
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
  } else {
    try {
      const outcome = await performLogin({
        claimAttempts: 2,
        // The rail block ends by redrawing itself away; with no terminal to
        // redraw, `login`'s plain block is the honest thing to print.
        ...(canRedraw() ? { deviceCode: railDeviceCode() } : {}),
      })
      session = outcome.session
      claimFailed = outcome.claimFailed
    } catch (err) {
      clack.cancel(
        `GitHub sign-in failed: ${err instanceof Error ? err.message : String(err)}. run \`hacklab setup\` again.`
      )
      process.exit(1)
    }
  }
  clack.log.step(
    session.handle
      ? `github · signed in as @${session.handle}`
      : `github · signed in as ${session.email}`
  )

  // A lost claim must never be silent here: the web onboarding page polls
  // `username_claimed` and would sit spinning forever.
  if (claimFailed) {
    clack.log.error("couldn't finish claiming your handle")
    clack.log.message(dim('run `hacklab login` again to finish it'), {
      spacing: 0,
    })
  }

  // ── The one question in the flow ─────────────────────────────────────────
  const consent = await askConversationConsent()

  // ── Upload ───────────────────────────────────────────────────────────────
  const spin = clack.spinner()
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
    const after = uploaded.rankAfter
    if (typeof after === 'number' && Number.isFinite(after)) rank = after
    spin.stop(rank ? `synced · rank #${rank}` : 'synced')
  } catch {
    // Never fatal — the account exists, and `hacklab sync` is the recovery.
    spin.stop('usage sync deferred')
    clack.log.message(dim('run `hacklab sync` later to upload it'), {
      spacing: 0,
    })
  }

  // ── Daemon (silent; the intro line is the whole disclosure) ──────────────
  await installDaemon(syncState, session.handle)

  // ── Tail ─────────────────────────────────────────────────────────────────
  clack.log.success(
    session.handle ? `you're in — ${appUrl}/${session.handle}` : "you're in"
  )

  const handoff = await offerAgentHandoff(session, appUrl)

  if (session.handle) {
    await identifyUser(session.handle, {
      $set: {
        email: session.email,
        handle: session.handle,
        app_url: appUrl,
      },
      $set_once: { joined_at: new Date().toISOString() },
    })
    const reportedRank = rank ?? preview?.rank
    await captureEvent(session.handle, 'cli_setup_completed', {
      tokens_total: scan.grandTotal,
      ...(reportedRank ? { rank: reportedRank } : {}),
      prompt_consent: consent,
    })
    await captureEvent(session.handle, 'cli_agent_handoff', {
      ...(handoff.agent ? { agent: handoff.agent } : {}),
      outcome: handoff.outcome,
    })
  }
}

/**
 * What the scan step shows while it is still running: one line per tool it
 * found, biggest first.
 *
 * Deliberately not `scan`'s full receipt. That breaks every tool down by model,
 * which on a heavy machine is twenty-odd lines — a wall to put up and take down
 * again for the few seconds the rank call is in flight. One line per tool is the
 * same answer at the altitude a first run needs, and it stays short.
 */
function scanNotes(scan: AggregateScan): string[] {
  return Object.entries(scan.toolTotals)
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([tool, total]) =>
        `${TOOL_LABELS[tool] ?? tool} · ${formatTokens(total)} tokens`
    )
}

/** The one line the scan stage leaves on the rail. */
function scanSummary(scan: AggregateScan): string {
  return scan.grandTotal > 0
    ? `scanned · ${formatTokens(scan.grandTotal)} tokens`
    : 'scanned · no AI usage on this machine'
}

type ScanStep = {
  /** Show a working note, visible only until the step ends. */
  note(line: string): void
  done(summary: string): void
  failed(summary: string): void
}

/**
 * The scan stage as a step that shows its working and then compresses.
 *
 * clack's `taskLog` is exactly this shape — notes on the rail while the step
 * runs, one line where they were once it finishes — but it collapses by walking
 * the cursor back, which is litter down a pipe and a divide by zero on a
 * terminal that reports no width. A plain spinner is the honest stand-in there:
 * same single closing line, no notes.
 */
function startScanStep(): ScanStep {
  const title = 'scanning local AI tool usage'
  if (!canRedraw()) {
    const spin = clack.spinner()
    spin.start(title)
    return {
      note: () => {
        // A spinner has nowhere to put notes it could take back.
      },
      done: (summary) => spin.stop(summary),
      failed: (summary) => spin.stop(summary),
    }
  }
  const log = clack.taskLog({ title })
  return {
    // taskLog dims its own notes and sizes them by raw string length, so they
    // arrive as plain text: colouring them would both fight the dim and throw
    // its row arithmetic off by the length of every escape sequence.
    note: (line) => log.message(line),
    done: (summary) => log.success(summary),
    failed: (summary) => log.error(summary, { showLog: false }),
  }
}

type HandoffResult = {
  outcome: 'launched' | 'declined' | 'unavailable' | 'spawn_failed'
  agent?: string
}

/**
 * The last beat of setup: offer to hand the profile work to a coding agent the
 * user already has installed, and close the flow.
 *
 * Every path ends with one closing line, and the browser line is printed before
 * the agent takes over the terminal — once it does, nothing we print afterwards
 * would be read in time. Every path also tells the backend what happened: the
 * web onboarding only waits on a `launched`, and switches to the manual
 * paste-the-prompt step on `declined` / `unavailable` or on hearing nothing.
 */
async function offerAgentHandoff(
  session: Session,
  appUrl: string
): Promise<HandoffResult> {
  const browserLine =
    'head back to your browser — the page will move on by itself'
  const agent = process.stdin.isTTY ? findAgentCli() : null

  if (!agent) {
    await notifyAgentHandoff(appUrl, session.token, 'unavailable')
    if (process.stdin.isTTY) printManualPrompt()
    clack.outro(dim(browserLine))
    return { outcome: 'unavailable' }
  }

  const offer = railAgentOffer(agent.name)
  const accepted = await waitForBareEnter(offer.prompt)
  offer.settle()

  if (!accepted) {
    clack.log.step('skipped')
    await notifyAgentHandoff(appUrl, session.token, 'declined')
    printManualPrompt()
    clack.outro(dim(browserLine))
    return { outcome: 'declined', agent: agent.bin }
  }

  clack.log.step(`handed off to ${agent.name}`)
  clack.log.message(dim(browserLine))

  // Ordering is load-bearing: the `launched` signal must be *awaited* before
  // the spawn. `launchAgentCli` uses `spawnSync`, which blocks the event loop
  // for the whole agent session, so a fire-and-forget fetch would not actually
  // go out until the agent exits — by which time the web page it was meant to
  // steer has long since given up. The 8s timeout inside `notifyAgentHandoff`
  // caps how long this can hold up the spawn; the typical case is one fast POST.
  await notifyAgentHandoff(appUrl, session.token, 'launched', agent.bin)

  if (!launchAgentCli(agent, PROFILE_SETUP_PROMPT)) {
    // The correction to the `launched` we just sent: the process never
    // started, so the page must stop waiting and show the manual prompt.
    await notifyAgentHandoff(appUrl, session.token, 'unavailable', agent.bin)
    clack.log.error(`couldn't start ${agent.name}`)
    printManualPrompt()
    clack.outro(dim(session.handle ? `${appUrl}/${session.handle}` : appUrl))
    return { outcome: 'spawn_failed', agent: agent.bin }
  }

  clack.outro(
    dim(
      session.handle
        ? `${agent.name} finished — ${appUrl}/${session.handle}`
        : `${agent.name} finished`
    )
  )
  return { outcome: 'launched', agent: agent.bin }
}

/** The fallback when no agent runs here: the same line the web page shows. */
function printManualPrompt(): void {
  clack.log.message([
    dim("paste this into your agent when you're ready:"),
    bold(PROFILE_SETUP_PROMPT),
  ])
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
    // Already answered, so it is not a step to walk — one dim line saying what
    // the answer is and where to change it.
    clack.log.message(
      dim(
        `conversation sharing · ${stored} — change with \`hacklab config prompt-stats <full|stats|none>\``
      )
    )
    return stored
  }

  if (!process.stdin.isTTY) return 'none'

  clack.log.message([
    bold('share your prompts?'),
    'hacklab scores how well you work with AI. your real prompts give the',
    'scoring model actual evidence — a sharper score, and a profile that',
    'stands out. a sample of up to 20,000 characters is read by the model,',
    'scored, and discarded. never stored, never shown to anyone.',
    dim('change anytime: hacklab config prompt-stats <full|stats|none>'),
  ])

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
      clack.log.warn('background sync · schedule it yourself')
      clack.log.message(result.instructions.split('\n').map(dim), {
        spacing: 0,
      })
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
    clack.log.warn('background sync · not recorded, config unwritable')
    return
  }
  if (state === 'missing') {
    clack.log.step(`background sync · scheduled (${result.mechanism})`)
    if (handle) {
      await captureEvent(handle, 'cli_daily_sync_installed', {
        mechanism: result.mechanism,
        source: 'setup',
      })
    }
  }
}
