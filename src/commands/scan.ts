import * as clack from '@clack/prompts'

import { beltForTokens } from '../belt.js'
import { loadConfig, resolveCursorAuth, saveConfig } from '../config.js'
import { dailySyncState, installDailySync } from '../daily-sync.js'
import { captureEvent } from '../posthog.js'
import { rebuildScanState } from '../scanners/incremental.js'
import {
  type AggregateScan,
  collectToolScans,
  detectCursorUsage,
  mergeToolScans,
  rescanCursorWithApi,
  type ScanResult,
} from '../scanners/index.js'
import {
  computeStreaks,
  formatTokens,
  shortModelName,
} from '../scanners/util.js'
import { loadSessionState } from '../session.js'
import {
  promptShareOnX,
  renderShareCard,
  type ShareCardData,
} from '../share.js'
import { checkSession, ensureFreshSession, uploadTokenScan } from '../sync.js'
import { bold, dim, error, info } from '../ui.js'

const MAX_MODELS = 8

export const TOOL_LABELS: Record<string, string> = {
  claude_code: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  openclaw: 'openclaw',
  hermes: 'hermes',
  opencode: 'opencode',
  grok: 'grok',
}

/**
 * Scan this machine, upload to the logged-in profile, draw the real card,
 * offer the X share, and arm the daemon so the card stays true.
 *
 * Login is required: an anonymous card says @hacker and points at the wrong
 * URL, which is how the viral loop dies. `--no-daemon` skips the schedule for
 * a one-shot flex on a machine you don't want ticking.
 */
export async function scan(args: string[] = []): Promise<void> {
  const noDaemon = args.includes('--no-daemon')

  const sessionState = await loadSessionState()
  if (!sessionState.session) {
    error(sessionState.status === 'expired' ? 'login expired' : 'not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }

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

  const session = await ensureFreshSession(sessionState.session)
  if (!session.handle) {
    error('no handle on this session')
    info(`run ${dim('hacklab login')} again`)
    process.exit(1)
  }

  let results: ScanResult[]
  try {
    results = await collectToolScans()
  } catch (err) {
    error(
      `couldn't read local AI usage: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }

  let scanResult = mergeToolScans(results)

  const rescanned = await offerCursorApiKey(results)
  if (rescanned) {
    results = rescanned
    scanResult = mergeToolScans(results)
  }

  let uploaded: Record<string, unknown>
  try {
    uploaded = await uploadTokenScan(session, scanResult, { interactive: true })
    await rebuildScanState(results)
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // The sync response is the source of truth, but a backend that predates a
  // field must not silently mint a white belt / 0-day streak: fall back to the
  // same numbers the profile will show. Rank has no local equivalent, so an
  // absent rank stays off the card entirely.
  const tokensTotal = numberField(uploaded.tokensTotal) ?? scanResult.grandTotal
  const belt = beltForTokens(tokensTotal)
  const streaks = computeStreaks(scanResult.dailyTotals.map((e) => e.date))
  const rank = numberField(uploaded.rankAfter)

  const card: ShareCardData = {
    handle: session.handle,
    level: numberField(uploaded.level) ?? belt.level,
    title: stringField(uploaded.title) ?? belt.title,
    beltColor: stringField(uploaded.beltColor) ?? belt.beltColor,
    tokensTotal,
    rank,
    streak: numberField(uploaded.streak) ?? streaks.current,
    longestStreak: numberField(uploaded.longestStreak) ?? streaks.longest,
    progressPercent:
      numberField(uploaded.progressPercent) ?? belt.progressPercent,
    estimatedCost: estimateCost(scanResult.toolTotals),
    toolBreakdown: {
      claudeCode: scanResult.toolTotals.claude_code ?? 0,
      codex: scanResult.toolTotals.codex ?? 0,
      cursor: scanResult.toolTotals.cursor ?? 0,
    },
    models: Object.entries(scanResult.modelTotals)
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    dailyActivity: aggregateDailyActivity(scanResult.dailyTotals),
  }

  for (const line of formatScanReceipt(scanResult)) {
    console.log(line)
  }
  console.log('')

  // Only touch the scheduler when something is actually wrong with it: a
  // reinstall rewrites the plists/units and bounces the jobs (killing a tick
  // mid-run), so doing it every scan is pure churn.
  if (!noDaemon) {
    const state = await dailySyncState()
    if (state !== 'current') {
      const result = await installDailySync()
      if (!result.ok) {
        // Only a machine with nothing scheduled gets the manual fallback. A
        // failed *repair* means the jobs are still there (an SSH session with no
        // user D-Bus fails the systemd probe every time while the desktop
        // session's timers keep running), and printing cron instructions there
        // both spams every scan and talks the user into a second, duplicate
        // schedule.
        if (state === 'missing') {
          console.log(dim(result.instructions))
          await captureEvent(session.handle, 'cli_daily_sync_manual', {
            mechanism: result.mechanism,
            source: 'scan',
          })
        }
      } else if (!result.recorded) {
        // The jobs are scheduled but we couldn't write the config, so every
        // future scan will reinstall. Explain the churn instead of repeating an
        // "installed" announcement (and its event) forever.
        console.log(
          dim('could not record daily-sync state — config unwritable')
        )
      } else if (state === 'missing') {
        console.log(dim(`daily sync scheduled (${result.mechanism})`))
        await captureEvent(session.handle, 'cli_daily_sync_installed', {
          mechanism: result.mechanism,
          source: 'scan',
        })
      }
    }
  }

  const cardPath = await renderShareCard(card)
  await promptShareOnX(card, cardPath)

  await captureEvent(session.handle, 'cli_scan_completed', {
    tokens_total: tokensTotal,
    ...(rank !== undefined ? { rank } : {}),
  })
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function formatScanReceipt(scan: AggregateScan): string[] {
  const groups = Object.entries(scan.toolTotals)
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, total]) => ({
      label: TOOL_LABELS[tool] ?? tool,
      value: formatTokens(total),
      models: Object.entries(scan.modelsByTool?.[tool] ?? {})
        .filter(([, tokens]) => tokens > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_MODELS)
        .map(([name, tokens]) => ({
          label: shortModelName(name).toLowerCase(),
          value: formatTokens(tokens),
        }))
        .filter((row) => row.label.length > 0),
    }))

  const rows = groups.flatMap((group) => [
    { label: group.label, value: group.value },
    ...group.models.map((model) => ({
      label: `  ${model.label}`,
      value: model.value,
    })),
  ])
  const aligned = alignRows(rows)

  const lines = [
    `you burned ${bold(`${formatTokens(scan.grandTotal)} tokens`)}`,
  ]
  let offset = 0
  for (const group of groups) {
    lines.push('')
    const n = 1 + group.models.length
    lines.push(...aligned.slice(offset, offset + n))
    offset += n
  }
  return lines
}

function alignRows(rows: Array<{ label: string; value: string }>): string[] {
  if (rows.length === 0) return []
  const labelWidth = Math.max(...rows.map((r) => r.label.length))
  const valueWidth = Math.max(...rows.map((r) => r.value.length))
  return rows.map(
    (row) =>
      `${dim(row.label.padEnd(labelWidth))}  ${bold(row.value.padStart(valueWidth))}`
  )
}

async function offerCursorApiKey(
  results: ScanResult[]
): Promise<ScanResult[] | null> {
  const { apiKey } = await resolveCursorAuth()
  if (apiKey) return null
  if (!(await detectCursorUsage())) return null

  const entered = await clack.password({
    message: 'cursor api key (enter to skip)',
  })
  if (clack.isCancel(entered)) return null
  const key = String(entered ?? '').trim()
  if (!key) return null

  const emailValue = await clack.text({
    message: 'cursor account email (optional — scopes a team key to just you)',
    placeholder: 'enter to skip',
  })
  const email =
    clack.isCancel(emailValue) || !String(emailValue ?? '').trim()
      ? undefined
      : String(emailValue).trim()

  await saveConfig({
    ...(await loadConfig()),
    cursorApiKey: key,
    ...(email ? { cursorEmail: email } : {}),
  })

  let rescanned: ScanResult[]
  try {
    rescanned = await rescanCursorWithApi(results)
  } catch (err) {
    console.log(
      dim(
        `keeping the local estimate: ${err instanceof Error ? err.message : String(err)}`
      )
    )
    return null
  }

  const status = rescanned.find((r) => r.tool === 'cursor')?.cursorScanStatus
  switch (status?.source) {
    case 'api':
      return rescanned
    case 'api-partial':
      console.log(dim(`stopped early: ${status.reason}`))
      return rescanned
    case 'api-failed':
      console.log(dim(`${status.reason} — keeping the local estimate.`))
      return null
    default:
      console.log(dim('keeping the local estimate.'))
      return null
  }
}

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
