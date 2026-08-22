import * as clack from '@clack/prompts'

import { beltForTokens } from '../belt.js'
import { loadConfig, resolveCursorAuth, saveConfig } from '../config.js'
import { captureEvent } from '../posthog.js'
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
import { loadSession } from '../session.js'
import {
  promptShareOnX,
  renderShareCard,
  type ShareCardData,
} from '../share.js'
import { bold, dim } from '../ui.js'

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
 * Scan local AI usage, render the share card, and optionally post it to X.
 * Local-only unless they choose to share. Login is optional: a handle on the
 * session goes on the card; without one the card still renders.
 */
export async function scan(): Promise<void> {
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

  let scanResult = mergeToolScans(results)
  printToolTotals(scanResult)

  const rescanned = await offerCursorApiKey(results, spin)
  if (rescanned) {
    results = rescanned
    scanResult = mergeToolScans(results)
    printToolTotals(scanResult)
  }

  const session = await loadSession()
  const handle = session?.handle ?? 'hacker'
  const belt = beltForTokens(scanResult.grandTotal)
  const streaks = computeStreaks(
    scanResult.dailyTotals.map((entry) => entry.date)
  )
  const card: ShareCardData = {
    handle,
    level: belt.level,
    title: belt.title,
    beltColor: belt.beltColor,
    tokensTotal: scanResult.grandTotal,
    rank: 0,
    streak: streaks.current,
    longestStreak: streaks.longest,
    progressPercent: belt.progressPercent,
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
  const cardPath = await renderShareCard(card)
  if (session?.handle) {
    await promptShareOnX(card, cardPath)
  } else {
    clack.log.message(dim('hacklab login to put your name on the card'))
  }

  if (session?.handle) {
    await captureEvent(session.handle, 'cli_scan_completed', {
      tokens_total: scanResult.grandTotal,
    })
  }

  clack.outro(dim('done.'))
}

function printToolTotals(scan: AggregateScan): void {
  for (const [tool, total] of Object.entries(scan.toolTotals)) {
    if (total > 0) {
      clack.log.message(
        `${(TOOL_LABELS[tool] ?? tool).padEnd(12)} ${formatTokens(total)} tokens`
      )
    }
  }
  clack.log.message(bold(`total: ${formatTokens(scan.grandTotal)} tokens`))
}

async function offerCursorApiKey(
  results: ScanResult[],
  spin: ReturnType<typeof clack.spinner>
): Promise<ScanResult[] | null> {
  const { apiKey } = await resolveCursorAuth()
  if (apiKey) return null
  if (!(await detectCursorUsage())) return null

  clack.log.step('cursor detected')
  clack.log.message(dim('a cursor api key gets exact counts. enter to skip.'))

  const entered = await clack.password({
    message: 'cursor api key (enter to skip)',
  })
  if (clack.isCancel(entered)) return null
  const key = String(entered ?? '').trim()
  if (!key) {
    clack.log.message(dim('skipped — cursor tokens will stay estimated.'))
    return null
  }

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

  spin.start('fetching exact cursor usage')
  let rescanned: ScanResult[]
  try {
    rescanned = await rescanCursorWithApi(results)
  } catch (err) {
    spin.stop('cursor api scan failed')
    clack.log.message(
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
      clack.log.message(dim(`stopped early: ${status.reason}`))
      return rescanned
    case 'api-failed':
      spin.stop('cursor api scan failed')
      clack.log.message(dim(`${status.reason} — keeping the local estimate.`))
      return null
    default:
      spin.stop('cursor api returned no usage events')
      clack.log.message(dim('keeping the local estimate.'))
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
