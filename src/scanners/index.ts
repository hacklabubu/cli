import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveCursorAuth } from '../config.js'
import { num, queryDb, str } from './sqlite.js'
import {
  type CursorScanStatus,
  type CursorStats,
  type DailyToolEntry,
  emptyResult,
  findFiles,
  type HourlyEntry,
  type ScanResult,
  TokenCollector,
  toDateStr,
} from './util.js'

export * from './util.js'

// One self-contained scanner per tool. Each returns a uniform ScanResult and
// keeps its own state (via TokenCollector), so they're pure and run in parallel.

export async function scanClaudeCode(): Promise<ScanResult> {
  const dir = join(homedir(), '.claude', 'projects')
  try {
    await stat(dir)
  } catch {
    return emptyResult('claude_code')
  }

  const files = await findFiles(dir, '.jsonl')
  const collector = new TokenCollector('claude_code')

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          const usage = parsed.message?.usage ?? parsed.usage ?? null
          if (!usage) continue
          const tokens =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
          if (tokens <= 0) continue

          let date: string
          let hour: number | null = null
          if (parsed.timestamp) {
            const d = new Date(
              typeof parsed.timestamp === 'string' &&
                /^\d+$/.test(parsed.timestamp)
                ? Number(parsed.timestamp)
                : parsed.timestamp
            )
            date = toDateStr(d)
            hour = d.getHours()
          } else {
            date = toDateStr((await stat(filePath)).mtime)
          }

          const model: string = parsed.message?.model ?? ''
          collector.addDaily(date, model, tokens, 1)
          if (hour !== null) collector.addHourly(date, hour, model, tokens, 1)
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return collector.result()
}

/**
 * Extract the session date from a Codex session path laid out as
 * `YYYY/MM/DD/file.jsonl`, or null if the path doesn't carry one. Splits on
 * either separator so it works on Windows (backslashes) too.
 */
export function codexDateFromRelPath(relPath: string): string | null {
  const parts = relPath.split(/[\\/]/)
  if (parts.length >= 3) {
    return `${parts[0]}-${parts[1]?.padStart(2, '0')}-${parts[2]?.padStart(2, '0')}`
  }
  return null
}

export async function scanCodex(): Promise<ScanResult> {
  const dir = join(homedir(), '.codex', 'sessions')
  try {
    await stat(dir)
  } catch {
    return emptyResult('codex')
  }

  const files = await findFiles(dir, '.jsonl')
  const collector = new TokenCollector('codex')

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf8')
      // Date from path: .codex/sessions/YYYY/MM/DD/file.jsonl.
      const relPath = filePath.slice(dir.length + 1)
      const date =
        codexDateFromRelPath(relPath) ?? toDateStr((await stat(filePath)).mtime)

      // Codex stores running totals; take the max per file.
      let maxTotal = 0
      let fileModel = ''
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.payload?.model) fileModel = parsed.payload.model as string
          const usage = parsed.payload?.info?.total_token_usage
          if (usage) {
            const t = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
            if (t > maxTotal) maxTotal = t
          }
        } catch {
          // skip
        }
      }

      if (maxTotal > 0) collector.addDaily(date, fileModel, maxTotal, 1)
    } catch {
      // skip unreadable files
    }
  }

  return collector.result()
}

export async function scanHermes(): Promise<ScanResult> {
  const dbPath = join(homedir(), '.hermes', 'state.db')
  try {
    await stat(dbPath)
  } catch {
    return emptyResult('hermes')
  }

  const collector = new TokenCollector('hermes')

  try {
    const rows = await queryDb(
      dbPath,
      `select s.id, coalesce(s.model,'') as model, s.started_at, s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens, s.reasoning_tokens, coalesce((select count(*) from messages m where m.session_id = s.id and m.role = 'assistant'), 0) as msg_count from sessions s`
    )
    if (rows.length === 0) return emptyResult('hermes')

    for (const row of rows) {
      const [
        ,
        model,
        startedAt,
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
        reasoning,
        msgCount,
      ] = row
      const tokens =
        num(inputTokens) +
        num(outputTokens) +
        num(cacheRead) +
        num(cacheWrite) +
        num(reasoning)
      if (tokens <= 0) continue
      const tsSec = num(startedAt)
      if (!Number.isFinite(tsSec) || tsSec <= 0) continue
      const d = new Date(Math.round(tsSec * 1000))
      const date = toDateStr(d)
      const m = str(model).trim()
      const messages = num(msgCount) || 1
      collector.addDaily(date, m, tokens, messages)
      collector.addHourly(date, d.getHours(), m, tokens, messages)
    }
  } catch {
    return emptyResult('hermes')
  }

  return collector.result()
}

export async function scanOpenclaw(): Promise<ScanResult> {
  const agentsDir = join(homedir(), '.openclaw', 'agents')
  try {
    await stat(agentsDir)
  } catch {
    return emptyResult('openclaw')
  }

  const sessionFiles: string[] = []
  try {
    const agentIds = await readdir(agentsDir, { withFileTypes: true })
    for (const entry of agentIds) {
      if (!entry.isDirectory()) continue
      const discovered = await findFiles(
        join(agentsDir, entry.name, 'sessions'),
        '.jsonl'
      )
      sessionFiles.push(...discovered)
    }
  } catch {
    return emptyResult('openclaw')
  }
  if (sessionFiles.length === 0) return emptyResult('openclaw')

  const collector = new TokenCollector('openclaw')

  for (const filePath of sessionFiles) {
    try {
      const content = await readFile(filePath, 'utf8')
      let fileFallbackDate: string | null = null
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          const usage =
            parsed.usage ??
            parsed.tokenUsage ??
            parsed.message?.usage ??
            parsed.response?.usage ??
            null
          if (!usage || typeof usage !== 'object') continue
          const tokens = (usage.total ??
            (usage.input ?? usage.inputTokens ?? 0) +
              (usage.output ?? usage.outputTokens ?? 0) +
              (usage.cacheRead ?? usage.cacheReadTokens ?? 0) +
              (usage.cacheWrite ?? usage.cacheWriteTokens ?? 0)) as number
          if (!tokens || tokens <= 0) continue

          let date: string
          let hour: number | null = null
          const ts = parsed.timestamp ?? parsed.t ?? parsed.time ?? null
          if (ts) {
            const tsMs =
              typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts
            const d = new Date(tsMs)
            if (!Number.isNaN(d.getTime())) {
              date = toDateStr(d)
              hour = d.getHours()
            } else {
              fileFallbackDate ??= toDateStr((await stat(filePath)).mtime)
              date = fileFallbackDate
            }
          } else {
            fileFallbackDate ??= toDateStr((await stat(filePath)).mtime)
            date = fileFallbackDate
          }

          const model: string = parsed.model ?? parsed.response?.model ?? ''
          collector.addDaily(date, model, tokens, 1)
          if (hour !== null) collector.addHourly(date, hour, model, tokens, 1)
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return collector.result()
}

export async function scanOpenCode(): Promise<ScanResult> {
  const baseDir = join(homedir(), '.local', 'share', 'opencode')
  try {
    await stat(baseDir)
  } catch {
    return emptyResult('opencode')
  }

  const collector = new TokenCollector('opencode')

  // Preferred: SQLite. Schema: message.data JSON with
  // { role, modelID, time: { created: ms }, tokens: { input, output, reasoning, cache: { read, write } } }
  const dbPath = join(baseDir, 'opencode.db')
  try {
    await stat(dbPath)
    const rows = await queryDb(
      dbPath,
      `SELECT json_extract(data,'$.time.created'), coalesce(json_extract(data,'$.modelID'),''), coalesce(json_extract(data,'$.tokens.input'),0), coalesce(json_extract(data,'$.tokens.output'),0), coalesce(json_extract(data,'$.tokens.cache.read'),0), coalesce(json_extract(data,'$.tokens.cache.write'),0), coalesce(json_extract(data,'$.tokens.reasoning'),0) FROM message WHERE json_extract(data,'$.role')='assistant'`
    )
    if (rows.length > 0) {
      for (const row of rows) {
        const [time, model, inp, out, cr, cw, reason] = row
        const tokens = num(inp) + num(out) + num(cr) + num(cw) + num(reason)
        if (tokens <= 0) continue
        const tsMs = num(time)
        if (!Number.isFinite(tsMs) || tsMs <= 0) continue
        const d = new Date(tsMs)
        const m = str(model).trim()
        collector.addDaily(toDateStr(d), m, tokens, 1)
        collector.addHourly(toDateStr(d), d.getHours(), m, tokens, 1)
      }
      const dbResult = collector.result()
      if (dbResult.daily.length > 0) return dbResult
    }
  } catch {
    // DB unavailable; fall through to JSON files
  }

  // Fallback: storage/message/{sessionID}/msg_*.json
  const messageDir = join(baseDir, 'storage', 'message')
  try {
    await stat(messageDir)
  } catch {
    return collector.result()
  }
  try {
    const sessionDirs = await readdir(messageDir, { withFileTypes: true })
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue
      const msgFiles = await findFiles(
        join(messageDir, sessionEntry.name),
        '.json'
      )
      for (const filePath of msgFiles) {
        try {
          const parsed = JSON.parse(await readFile(filePath, 'utf8'))
          if (parsed.role !== 'assistant') continue
          const t = parsed.tokens
          if (!t || typeof t !== 'object') continue
          const tokens =
            (t.input ?? 0) +
            (t.output ?? 0) +
            (t.cache?.read ?? 0) +
            (t.cache?.write ?? 0) +
            (t.reasoning ?? 0)
          if (tokens <= 0) continue
          const tsMs: number = parsed.time?.created ?? 0
          let date: string
          let hour: number | null = null
          if (tsMs > 0) {
            const d = new Date(tsMs)
            date = toDateStr(d)
            hour = d.getHours()
          } else {
            date = toDateStr((await stat(filePath)).mtime)
          }
          const model = String(parsed.modelID ?? '')
          collector.addDaily(date, model, tokens, 1)
          if (hour !== null) collector.addHourly(date, hour, model, tokens, 1)
        } catch {
          // skip malformed files
        }
      }
    }
  } catch {
    // skip
  }

  return collector.result()
}

const CURSOR_TRACKING_DB = join(
  homedir(),
  '.cursor',
  'ai-tracking',
  'ai-code-tracking.db'
)

/** Cursor's Electron state dir, per platform. Not where the tracking db lives. */
function cursorStateDirs(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Cursor')]
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA ? [join(process.env.APPDATA, 'Cursor')] : []
  }
  return [join(home, '.config', 'Cursor')]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function dirHasEntries(p: string): Promise<boolean> {
  try {
    return (await readdir(p)).length > 0
  } catch {
    return false
  }
}

/**
 * Does this machine look like a Cursor machine? `join` uses this to decide
 * whether asking for a Cursor API key is worth a prompt.
 *
 * A false positive costs a question the user has to skip, so this looks for
 * evidence Cursor has been *used* — the AI-tracking db, editor session state,
 * per-workspace storage, or local file history — rather than merely installed.
 * Every probe is a filesystem existence check, so it stays cheap enough to run
 * inline in the join flow.
 */
export async function detectCursorUsage(): Promise<boolean> {
  if (await pathExists(CURSOR_TRACKING_DB)) return true
  for (const dir of cursorStateDirs()) {
    if (await pathExists(join(dir, 'User', 'globalStorage', 'state.vscdb'))) {
      return true
    }
    if (await dirHasEntries(join(dir, 'User', 'workspaceStorage'))) return true
    if (await dirHasEntries(join(dir, 'User', 'History'))) return true
  }
  return false
}

export async function scanCursorLocal(): Promise<ScanResult> {
  const dbPath = CURSOR_TRACKING_DB
  try {
    await stat(dbPath)
  } catch {
    return { ...emptyResult('cursor'), cursorStats: null }
  }

  const collector = new TokenCollector('cursor')

  try {
    const rows = await queryDb(
      dbPath,
      `select commitHash, linesAdded, linesDeleted, composerLinesAdded, composerLinesDeleted, humanLinesAdded, humanLinesDeleted, v2AiPercentage from scored_commits;`
    )
    if (rows.length === 0)
      return { ...emptyResult('cursor'), cursorStats: null }

    let totalTokens = 0
    let totalAiLines = 0
    let totalHumanLines = 0
    let aiPctSum = 0
    for (const row of rows) {
      const composerAdded = num(row[3])
      const composerDeleted = num(row[4])
      const humanAdded = num(row[5])
      const aiLines = composerAdded + composerDeleted
      totalAiLines += composerAdded
      totalHumanLines += humanAdded
      aiPctSum += num(row[7])
      totalTokens += aiLines * 30
    }

    let models: Array<{ model: string; uses: number }> = []
    try {
      const modelRows = await queryDb(
        dbPath,
        `select model, count(*) from ai_code_hashes where model is not null and model != '' group by model order by count(*) desc;`
      )
      models = modelRows.map((row) => ({
        model: str(row[0]),
        uses: num(row[1]),
      }))
    } catch {
      // optional
    }

    if (totalTokens > 0)
      collector.addDaily(toDateStr(new Date()), '', totalTokens, 1)

    const stats: CursorStats = {
      totalCommits: rows.length,
      aiLinesAdded: totalAiLines,
      humanLinesAdded: totalHumanLines,
      avgAiPercent:
        rows.length > 0 ? Math.round((aiPctSum / rows.length) * 10) / 10 : 0,
      models,
    }
    return collector.result({ cursorStats: stats })
  } catch {
    return { ...emptyResult('cursor'), cursorStats: null }
  }
}

export async function scanCursorApi(): Promise<ScanResult> {
  const { apiKey, email } = await resolveCursorAuth()
  if (!apiKey) {
    return { ...emptyResult('cursor'), cursorScanStatus: { source: 'none' } }
  }

  const collector = new TokenCollector('cursor')
  const now = Date.now()
  const startDate = now - 5 * 365 * 24 * 60 * 60 * 1000
  const endDate = now

  let page = 1
  let hasMore = true
  let retries = 0
  const MAX_RETRIES = 3
  let eventsProcessed = 0
  let partialReason: string | null = null
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  while (hasMore) {
    const body: Record<string, unknown> = {
      startDate,
      endDate,
      page,
      pageSize: 100,
    }
    if (email) body.email = email

    let res: Response
    try {
      res = await fetch('https://api.cursor.com/teams/filtered-usage-events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      partialReason = `network: ${err instanceof Error ? err.message : 'unknown'}`
      break
    }

    if (!res.ok) {
      if (res.status === 429 && retries < MAX_RETRIES) {
        await sleep(2000 * 2 ** retries)
        retries++
        continue
      }
      if (res.status === 401 || res.status === 403) {
        if (eventsProcessed === 0) {
          return {
            ...emptyResult('cursor'),
            cursorScanStatus: {
              source: 'api-failed',
              reason: `Cursor rejected the API key (auth ${res.status})`,
            },
          }
        }
        partialReason = `auth ${res.status} mid-scan`
        break
      }
      partialReason = `HTTP ${res.status}`
      break
    }

    retries = 0
    let data: {
      usageEvents?: Array<Record<string, unknown>>
      pagination?: { hasNextPage?: boolean }
    }
    try {
      data = await res.json()
    } catch {
      partialReason = 'invalid json'
      break
    }

    for (const event of data.usageEvents ?? []) {
      if (!event.isTokenBasedCall) continue
      const tu =
        (event.tokenUsage as Record<string, number> | undefined) ??
        (event as unknown as Record<string, number>)
      const tokens =
        (tu.inputTokens ?? 0) +
        (tu.outputTokens ?? 0) +
        (tu.cacheWriteTokens ?? 0) +
        (tu.cacheReadTokens ?? 0)
      if (tokens > 0 && event.timestamp) {
        const rawTs = event.timestamp as string | number
        const tsMs =
          typeof rawTs === 'string' && /^\d+$/.test(rawTs)
            ? Number(rawTs)
            : rawTs
        const d = new Date(tsMs)
        const model = (event.model as string | undefined) ?? ''
        collector.addDaily(toDateStr(d), model, tokens, 1)
        collector.addHourly(toDateStr(d), d.getHours(), model, tokens, 1)
        eventsProcessed++
      }
    }

    hasMore = data.pagination?.hasNextPage ?? false
    page++
    if (page > 500) {
      partialReason = 'pagination cap (500 pages)'
      break
    }
  }

  const cursorScanStatus: CursorScanStatus = partialReason
    ? { source: 'api-partial', events: eventsProcessed, reason: partialReason }
    : { source: 'api', events: eventsProcessed }
  return collector.result({ cursorScanStatus })
}

export type AggregateScan = {
  toolTotals: Record<string, number>
  dailyTotals: DailyToolEntry[]
  hourlyTotals: HourlyEntry[]
  modelTotals: Record<string, number>
  grandTotal: number
  cursorStats: CursorStats | null
  cursorScanStatus: CursorScanStatus
}

/**
 * Choose between the two Cursor sources: the API scan when it produced data,
 * else the local `lines × 30` estimate.
 *
 * Either way the winner carries the local commit stats (the API has no notion of
 * commits, and the share card renders them) and the API's status. Propagating
 * the status onto the local fallback is what lets a rejected key surface as
 * `api-failed` — otherwise a bad key is indistinguishable from no key at all,
 * and the user silently gets the estimate while believing they get exact counts.
 */
function resolveCursor(api: ScanResult, local: ScanResult): ScanResult {
  if (api.daily.length > 0) {
    return { ...api, cursorStats: local.cursorStats ?? null }
  }
  return {
    ...local,
    cursorScanStatus: api.cursorScanStatus ?? { source: 'none' },
  }
}

/** Run every scanner in parallel, returning one resolved result per tool. */
export async function collectToolScans(): Promise<ScanResult[]> {
  const [claude, codex, cursorApi, cursorLocal, openclaw, hermes, opencode] =
    await Promise.all([
      scanClaudeCode(),
      scanCodex(),
      scanCursorApi(),
      scanCursorLocal(),
      scanOpenclaw(),
      scanHermes(),
      scanOpenCode(),
    ])

  const cursor = resolveCursor(cursorApi, cursorLocal)
  return [claude, codex, cursor, openclaw, hermes, opencode]
}

/**
 * Re-run only the Cursor API scanner and swap the result into an existing set of
 * scans. `join` calls this after the user supplies a key mid-flow, so the exact
 * API numbers replace the local estimate without re-walking every other tool's
 * logs (which for a heavy Claude Code user means re-parsing thousands of files).
 */
export async function rescanCursorWithApi(
  results: ScanResult[]
): Promise<ScanResult[]> {
  const api = await scanCursorApi()
  return results.map((r) => (r.tool === 'cursor' ? resolveCursor(api, r) : r))
}

/** Merge per-tool results into a single submit-ready payload. */
export function mergeToolScans(results: ScanResult[]): AggregateScan {
  const toolTotals: Record<string, number> = {}
  const dailyTotals: DailyToolEntry[] = []
  const hourlyTotals: HourlyEntry[] = []
  const modelTotals: Record<string, number> = {}
  let grandTotal = 0

  for (const r of results) {
    let toolSum = 0
    for (const d of r.daily) {
      dailyTotals.push(d)
      toolSum += d.tokens
    }
    toolTotals[r.tool] = (toolTotals[r.tool] ?? 0) + toolSum
    grandTotal += toolSum
    hourlyTotals.push(...r.hourly)
    for (const [model, tokens] of Object.entries(r.models)) {
      modelTotals[model] = (modelTotals[model] ?? 0) + tokens
    }
  }

  const cursor = results.find((r) => r.tool === 'cursor')
  return {
    toolTotals,
    dailyTotals,
    hourlyTotals,
    modelTotals,
    grandTotal,
    cursorStats: cursor?.cursorStats ?? null,
    cursorScanStatus: cursor?.cursorScanStatus ?? { source: 'none' },
  }
}

/**
 * Run every scanner and merge the results — the one-shot entry point for callers
 * that don't need to re-scan a single tool afterwards (`sync`, the daily job).
 */
export async function scanAllTools(): Promise<AggregateScan> {
  return mergeToolScans(await collectToolScans())
}
