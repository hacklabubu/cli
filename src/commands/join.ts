import * as clack from '@clack/prompts'

import { beltForTokens } from '../belt.js'
import { loadConfig, resolveCursorAuth, saveConfig } from '../config.js'
import { captureEvent, identifyUser } from '../posthog.js'
import { referralUrl } from '../referral.js'
import {
  type AggregateScan,
  collectToolScans,
  computeStreaks,
  detectCursorUsage,
  formatTokens,
  mergeToolScans,
  rescanCursorWithApi,
  type ScanResult,
} from '../scanners/index.js'
import { loadSession, resolveAppUrl, saveSession } from '../session.js'
import {
  promptShareOnX,
  renderShareCard,
  type ShareCardData,
} from '../share.js'
import { syncGithubRepos, uploadTokenScan } from '../sync.js'
import { bold, dim, info } from '../ui.js'
import { login } from './login.js'

type SyncResult = {
  title?: string
  level?: number
  beltColor?: string
  rankAfter?: number
}

const TOOL_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  grok: 'Grok Build',
}

/**
 * The hero command: the guided join ritual.
 *
 *   scan → anonymous rank → GitHub OAuth → pick username → claim → card
 *
 * Value (rank) is shown before any account exists. GitHub auth comes right
 * after the rank and before the username, so we know whether the account
 * already has a claimed handle (and can skip the username prompt) before asking.
 * Each stage degrades on its own terms (see the per-stage handling below) so a
 * network blip on the vanity rank never blocks the actual join.
 */
export async function join(opts: { browser?: boolean } = {}) {
  clack.intro(bold('hacklab'))

  // Already logged in → abort immediately. `join` must not switch accounts,
  // re-register, or scan anything when a session already exists; the way to
  // change accounts is an explicit logout + login.
  // Gate on a *completed* account (username claimed), not merely a handle. A
  // handle alone isn't enough: a profile auto-created on first auth carries a
  // (GitHub-derived) handle but hasn't claimed a username, and that user still
  // needs to run join to pick one and upload their tokens. Only a claimed
  // username means a real, finished profile — stop and point them at the
  // logout/login switch path. Sessions saved before this field existed report
  // it as undefined and fall through (they re-resolve on the next login).
  const current = await loadSession()
  if (current?.handle && current.usernameClaimed) {
    clack.note(
      `you're already logged in as ${bold(`@${current.handle}`)} (${current.email}).\n` +
        'join here would not switch accounts or change anything, so it stops.\n\n' +
        'to use a different account:\n' +
        '  hacklab logout\n' +
        '  hacklab login',
      'already logged in'
    )
    clack.outro(dim('nothing to do — log out first to switch accounts.'))
    return
  }

  // Derive the backend from the reused session when one exists: an unclaimed
  // session saved against a non-production backend (via --env or
  // HACKLAB_APP_URL) must not send its token to the production default.
  // HACKLAB_APP_URL still wins inside resolveAppUrl.
  const appUrl = resolveAppUrl(current)

  // ── Stage 1: scan ────────────────────────────────────────────────────────
  // Keep the per-tool results, not just the merged totals: Stage 1.5 may re-scan
  // Cursor alone and re-merge, which needs the other tools' results intact.
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

  let scan = mergeToolScans(results)
  printToolTotals(scan)

  // ── Stage 1.5: offer a Cursor API key ────────────────────────────────────
  // Before the rank preview, so an accepted key feeds the rank we show and the
  // numbers we upload — otherwise we'd rank the estimate and upload something
  // else.
  const rescanned = await offerCursorApiKey(results, spin)
  if (rescanned) {
    results = rescanned
    scan = mergeToolScans(results)
    printToolTotals(scan)
  }

  // Empty-scan branch: no hard floor gate, but nothing to rank — let the user
  // decide whether to continue.
  if (scan.grandTotal <= 0) {
    const cont = await clack.confirm({
      message:
        'No AI token usage found on this machine. Sign up anyway? (you can sync usage later)',
      initialValue: false,
    })
    if (clack.isCancel(cont) || !cont) {
      clack.outro(
        dim('come back after some Claude Code / Codex / Cursor sessions.')
      )
      process.exit(0)
    }
  }

  // ── Stage 2: anonymous rank (best-effort; never blocks the join) ──────────
  // Captured for the share card later — the preview rank equals the post-sync
  // rank (rank counts users with MORE tokens, so the user joining the set
  // doesn't change it), so the card can show it without waiting on the upload.
  let previewRank: number | null = null
  try {
    const res = await fetch(`${appUrl}/api/rank/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalTokens: scan.grandTotal }),
    })
    if (res.ok) {
      const { rank, ofTotal } = (await res.json()) as {
        rank: number
        ofTotal: number
      }
      previewRank = rank
      clack.note(
        `${bold(`you'd be #${rank}`)} of ${ofTotal} hackers`,
        'your rank'
      )
    }
  } catch {
    // Rank is a hook, not a gate. Skip silently and continue the join.
  }

  // ── Stage 3: GitHub OAuth when needed ─────────────────────────────────────
  // The web onboarding flow runs `hacklab login` before `join`, so reuse that
  // unclaimed session instead of making the user authorize GitHub twice. A
  // direct `hacklab join` still performs the full login flow here.
  let session = current
  if (!session) {
    try {
      await login({ allowSignup: true, browser: opts.browser })
    } catch (err) {
      clack.cancel(
        `GitHub sign-in failed: ${err instanceof Error ? err.message : String(err)}. run \`hacklab join\` again.`
      )
      process.exit(1)
    }
    session = await loadSession()
  }
  if (!session) {
    clack.cancel('GitHub sign-in did not complete. run `hacklab join` again.')
    process.exit(1)
  }

  // ── Stage 4: already-CLAIMED GitHub account → log in, never rename ─────────
  // `login` resolves an existing GitHub link to its Hacklab account and stores
  // that account's handle + claim status on the session. Gate on a *claimed*
  // username, not handle presence: a profile auto-created on first auth (web
  // signup, or a prior device login) carries a GitHub-derived handle but
  // `usernameClaimed === false`, and that user came here precisely to pick a
  // username and upload tokens — they fall through to Stage 5. Only a genuinely
  // claimed account owns its handle, so behave like a plain `hacklab login`:
  // leave the profile untouched and stop. (The server's claim route enforces
  // this too — it refuses to rename a claimed profile — so this is UX, not the
  // security boundary.)
  if (session.handle && session.usernameClaimed) {
    const base = appUrl.replace(/\/$/, '')
    clack.note(
      `that GitHub account already has a hacklab account: ${bold(`@${session.handle}`)}.\n` +
        'logged you in — username, bio, and links are unchanged.',
      'welcome back'
    )
    clack.outro(
      dim(
        `${base}/${session.handle} · \`hacklab sync\` to update usage · \`hacklab chat\` to jump in`
      )
    )
    return
  }

  // ── Stage 5: pick username, then claim ───────────────────────────────────
  // Only reached when the account has no claimed username yet: a fresh signup,
  // or a first-time web user who authenticated on the site and now needs to
  // choose a handle. An account that already set its username skipped this at
  // Stage 4.
  const username = await promptAvailableUsername(appUrl, {
    token: session.token,
    // Default to the handle GitHub auth already assigned, so a user who wants
    // to keep their GitHub username just presses Enter (it no longer reads as
    // taken now that the check excludes their own row).
    initialValue: session.handle ?? undefined,
  })
  if (username === null) {
    clack.outro(dim('cancelled.'))
    process.exit(0)
  }

  // Claim (re-prompt username on a TOCTOU collision).
  let claimedHandle = username
  while (true) {
    const res = await fetch(`${appUrl}/api/cli/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        username: claimedHandle,
      }),
    })

    if (res.ok) {
      const data = (await res.json()) as { handle: string; profileUrl: string }
      claimedHandle = data.handle
      break
    }

    if (res.status === 409) {
      const reprompt = await promptAvailableUsername(appUrl, {
        token: session.token,
        message: 'that name was just taken — pick another',
      })
      if (reprompt === null) {
        clack.cancel('cancelled before claiming a handle.')
        process.exit(1)
      }
      claimedHandle = reprompt
      continue
    }

    const data = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    clack.cancel(data?.error ?? `claim failed (${res.status})`)
    process.exit(1)
  }

  // Record the claimed handle on the local session so it reflects a *completed*
  // account. The logged-in guard (here and in the installer) keys off a claimed
  // username, so set both — without this a finished signup would still look
  // half-done and a re-run of join would scan/upload again instead of stopping.
  const claimedSession = {
    ...session,
    handle: claimedHandle,
    usernameClaimed: true,
  }
  await saveSession(claimedSession)

  // ── Stage 6: save usage and mirror pinned projects ────────────────────────
  // Finish essential work before the viral loop. The card is the reward for a
  // completed claim, never something standing between the user and an account.
  spin.start('saving your usage')
  let syncResult: SyncResult | null = null
  try {
    const result = await uploadTokenScan(claimedSession, scan, {
      timeoutMs: 120_000,
    })
    syncResult = {
      title: typeof result.title === 'string' ? result.title : undefined,
      level: typeof result.level === 'number' ? result.level : undefined,
      beltColor:
        typeof result.beltColor === 'string' ? result.beltColor : undefined,
      rankAfter:
        typeof result.rankAfter === 'number' ? result.rankAfter : undefined,
    }
  } catch {
    // A failed usage upload does not undo the claimed handle. `hacklab sync`
    // remains the explicit recovery path.
  }

  const base = appUrl.replace(/\/$/, '')
  if (syncResult?.title && syncResult.level != null) {
    spin.stop('usage saved')
    info(
      `${bold(syncResult.title)} lv.${syncResult.level}${syncResult.beltColor ? ` (${syncResult.beltColor} belt)` : ''}`
    )
    if (syncResult.rankAfter) info(`rank: #${syncResult.rankAfter}`)
  } else {
    spin.stop('usage sync deferred')
    info(dim('run `hacklab sync` if your stats look off.'))
  }

  spin.start('syncing pinned github repos')
  const repos = await syncGithubRepos(claimedSession)
  if (repos && repos.synced > 0) {
    spin.stop(
      `synced ${repos.synced} github project${repos.synced === 1 ? '' : 's'}`
    )
  } else {
    spin.stop('github projects synced')
  }

  clack.log.success(`${bold('claimed.')} ${base}/${claimedHandle}`)

  if (claimedSession.email) {
    await identifyUser(claimedHandle, {
      $set: {
        email: claimedSession.email,
        handle: claimedHandle,
        app_url: appUrl,
      },
      $set_once: { joined_at: new Date().toISOString() },
    })
  }
  await captureEvent(claimedHandle, 'cli_join_completed', {
    tokens_total: scan.grandTotal,
    rank: syncResult?.rankAfter ?? previewRank ?? undefined,
  })

  // ── Stage 7: show the reward, then offer one sharing action ───────────────
  const belt = beltForTokens(scan.grandTotal)
  const streaks = computeStreaks(scan.dailyTotals.map((entry) => entry.date))
  const card: ShareCardData = {
    handle: claimedHandle,
    level: belt.level,
    title: belt.title,
    beltColor: belt.beltColor,
    tokensTotal: scan.grandTotal,
    rank: syncResult?.rankAfter ?? previewRank ?? 0,
    streak: streaks.current,
    longestStreak: streaks.longest,
    progressPercent: belt.progressPercent,
    estimatedCost: estimateCost(scan.toolTotals),
    toolBreakdown: {
      claudeCode: scan.toolTotals.claude_code ?? 0,
      codex: scan.toolTotals.codex ?? 0,
      cursor: scan.toolTotals.cursor ?? 0,
    },
    models: Object.entries(scan.modelTotals)
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    dailyActivity: aggregateDailyActivity(scan.dailyTotals),
  }
  const cardPath = await renderShareCard(card)
  await promptShareOnX(card, cardPath)

  // Keep the required discovery notice visible without another decision or a
  // wall of text in the join path.
  //
  // Temporarily disabled (2026-08): scout discovery isn't live — no profile
  // data is shared with employers — so the notice is pure noise in the join
  // flow right now. Flip this back on before discovery launches.
  const DISCOVERY_NOTICE_ENABLED = false
  if (DISCOVERY_NOTICE_ENABLED) {
    clack.note(
      'Your public profile can appear in vetted scout discovery. Email, DMs, and AI session content are never shared. Change "get discovered" anytime in profile settings.',
      'discovery'
    )
  }

  // The viral loop's last beat: a personal referral link at the very end of the
  // ritual, once the account is real and there's a handle to key it on. Purely
  // informational — no prompt to answer — so it never stands between the user
  // and their finished profile. `hacklab referral` reprints it any time.
  clack.note(
    `${bold(referralUrl(claimedHandle, base))}\n\n` +
      'Send it to your smartest hacker friends. The more of your crew here,\n' +
      'the better the network — they join, you both climb the ranks.',
    'invite your crew'
  )

  // Point at the daemon instead of scheduling it here. Onboarding makes it its
  // own step, and a background job installed on someone's machine as a silent
  // side effect of joining is exactly the kind of thing that should be a
  // deliberate command they ran.
  clack.note(
    `${bold('hacklab daemon')}\n\n` +
      'Schedules a daily background re-scan so your tokens, rank, and streak\n' +
      'stay current without you running anything. No daemon, no streak.',
    'next: summon the daemon'
  )

  clack.outro(
    dim(
      'run `hacklab daemon`, then return to onboarding for your bio and drop.'
    )
  )
}

/** The per-tool token lines + grand total shown after a scan. */
function printToolTotals(scan: AggregateScan): void {
  for (const [tool, total] of Object.entries(scan.toolTotals)) {
    if (total > 0) {
      info(
        `${(TOOL_LABELS[tool] ?? tool).padEnd(12)} ${formatTokens(total)} tokens`
      )
    }
  }
  info(bold(`total: ${formatTokens(scan.grandTotal)} tokens`))
}

/**
 * Offer to take a Cursor API key, but only from people it can actually help.
 *
 * Without a key the Cursor scanner can only estimate — AI lines × 30, all
 * stamped on today, so no real history — which is the least accurate number in
 * the scan. With one we read exact per-event token counts from Cursor's API.
 * That's worth interrupting a Cursor user for, and worth interrupting nobody
 * else for, so this asks only when the machine shows evidence of Cursor use and
 * no key is configured yet.
 *
 * Returns the re-scanned per-tool results, or null when nothing changed (no
 * Cursor, key already set, or the user skipped) and the caller should keep the
 * scan it has.
 */
async function offerCursorApiKey(
  results: ScanResult[],
  spin: ReturnType<typeof clack.spinner>
): Promise<ScanResult[] | null> {
  const { apiKey } = await resolveCursorAuth()
  if (apiKey) return null
  if (!(await detectCursorUsage())) return null

  clack.note(
    'your cursor tokens are currently a rough estimate from local activity.\n' +
      'a cursor api key gets exact per-event counts and real daily history.\n' +
      dim(
        'grab one from your cursor dashboard, or skip — you can add it later\n'
      ) +
      dim('with `hacklab config cursor-api-key <key>`.'),
    'cursor detected'
  )

  // password(), not text(): an API key shouldn't be echoed into the terminal or
  // left sitting in scrollback.
  const entered = await clack.password({
    message: 'cursor api key (enter to skip)',
  })
  if (clack.isCancel(entered)) return null
  const key = String(entered ?? '').trim()
  if (!key) {
    info(dim('skipped — cursor tokens will stay estimated.'))
    return null
  }

  // A team key returns every member's events unless it's filtered by email, so
  // an unscoped team key would credit the whole team's tokens to this profile.
  const email = await optionalText(
    'cursor account email (optional — scopes a team key to just you)',
    'enter to skip'
  )

  await saveConfig({
    ...(await loadConfig()),
    cursorApiKey: key,
    ...(email ? { cursorEmail: email } : {}),
  })

  spin.start('fetching exact cursor usage')
  let rescanned: ScanResult[]
  try {
    rescanned = await rescanCursorWithApi(results)
  } catch (err) {
    spin.stop('cursor api scan failed')
    info(
      dim(
        `keeping the local estimate: ${err instanceof Error ? err.message : String(err)}`
      )
    )
    return null
  }

  const status = rescanned.find((r) => r.tool === 'cursor')?.cursorScanStatus
  switch (status?.source) {
    case 'api':
      spin.stop(`cursor: exact counts from ${status.events} usage events`)
      return rescanned
    case 'api-partial':
      spin.stop(`cursor: ${status.events} usage events (partial)`)
      info(dim(`stopped early: ${status.reason}`))
      return rescanned
    case 'api-failed':
      spin.stop('cursor api scan failed')
      info(dim(`${status.reason} — keeping the local estimate.`))
      info(dim('fix it later with `hacklab config cursor-api-key <key>`.'))
      return null
    default:
      // Key accepted, but the API had no token-based events to report (a brand
      // new account, or a team key scoped to an email with no usage).
      spin.stop('cursor api returned no usage events')
      info(dim('keeping the local estimate.'))
      return null
  }
}

/** Blended cost estimate ($/M tokens) across the scanned tools, for the card. */
function estimateCost(toolTotals: Record<string, number>): number {
  const rate: Record<string, number> = {
    claude_code: 0.6,
    codex: 0.25,
    cursor: 0.4,
    openclaw: 0.5,
    hermes: 0.5,
    opencode: 0.5,
    grok: 0.5,
  }
  let cost = 0
  for (const [tool, tokens] of Object.entries(toolTotals)) {
    cost += (tokens / 1_000_000) * (rate[tool] ?? 0.4)
  }
  return cost
}

/** Collapse per-tool daily entries into one {date, tokens}[] for the card graph. */
function aggregateDailyActivity(
  dailyTotals: AggregateScan['dailyTotals']
): Array<{ date: string; tokens: number }> {
  const byDate = new Map<string, number>()
  for (const entry of dailyTotals) {
    byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + entry.tokens)
  }
  return Array.from(byDate.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Prompt for a username and loop until it passes the availability check or the
 * user cancels. Returns the chosen username, or null if cancelled.
 *
 * `token` is sent on the availability check so the server can exclude the
 * caller's OWN auto-assigned handle (auth now happens before this prompt, so
 * without it the user's current handle reads back as "taken"). `initialValue`
 * pre-fills the field on the first prompt — their current handle, so the common
 * case is just pressing Enter to keep it.
 */
async function promptAvailableUsername(
  appUrl: string,
  opts: { token?: string; message?: string; initialValue?: string } = {}
): Promise<string | null> {
  let message = opts.message ?? 'pick your hacklab username'
  // Pre-fill only the first prompt; once the user has edited/submitted, don't
  // re-seed the field (a rejected name shouldn't reappear pre-filled).
  let initialValue = opts.initialValue
  while (true) {
    const value = await clack.text({
      message,
      placeholder: 'e.g. ada-lovelace',
      initialValue,
    })
    if (clack.isCancel(value)) return null
    initialValue = undefined
    const candidate = String(value).trim()

    let available = false
    let reason = 'could not check availability — try again'
    try {
      const res = await fetch(
        `${appUrl}/api/cli/username-available?u=${encodeURIComponent(candidate)}`,
        opts.token
          ? { headers: { Authorization: `Bearer ${opts.token}` } }
          : undefined
      )
      if (res.ok) {
        const data = (await res.json()) as {
          available: boolean
          reason?: string
        }
        available = data.available
        if (!available && data.reason) reason = data.reason
      } else if (res.status === 429) {
        reason = 'too many checks — wait a moment and try again'
      } else if (res.status === 401) {
        // The check is authenticated now. A rejected session can't be fixed by
        // retrying a name, so break the loop instead of spinning on it. In
        // practice this is near-impossible (the token was just minted this run).
        clack.log.error(
          'your hacklab session is no longer valid. run `hacklab login`, then `hacklab join` again.'
        )
        return null
      }
    } catch {
      // network error — fall through to re-prompt with the generic reason
    }

    if (available) return candidate
    message = `${reason}\n  pick your hacklab username`
  }
}

/** A clack text prompt that returns trimmed text, or undefined if empty/cancelled. */
async function optionalText(
  message: string,
  placeholder = '(optional)'
): Promise<string | undefined> {
  const value = await clack.text({ message, placeholder })
  if (clack.isCancel(value)) return undefined
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : undefined
}
