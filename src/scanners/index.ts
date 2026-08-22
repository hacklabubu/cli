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

// Where each harness keeps its logs. Resolved per call rather than at import
// time so a test (or a run with a different HOME) sees the right home dir.
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}
export function codexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions')
}
export function openclawAgentsDir(): string {
  return join(homedir(), '.openclaw', 'agents')
}
export function hermesDbPath(): string {
  return join(homedir(), '.hermes', 'state.db')
}
export function opencodeDir(): string {
  return join(homedir(), '.local', 'share', 'opencode')
}
export function opencodeDbPath(): string {
  return join(opencodeDir(), 'opencode.db')
}
/** Grok Build home. `GROK_HOME` wins so tests (and unusual installs) can point elsewhere. */
export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim()
  return override ? override : join(homedir(), '.grok')
}
export function grokLogsDir(): string {
  return join(grokHome(), 'logs')
}

/**
 * One usage-bearing line from a JSONL harness log, as the per-line parsers
 * return it. `date === null` means the line carried no usable timestamp — the
 * caller falls back to the file's mtime day, which it (unlike a pure parser)
 * can cheaply resolve and memoize per file.
 *
 * These parsers exist so the full scan and the incremental tick
 * (scanners/incremental.ts) read a line exactly the same way: the tick appends
 * to aggregates the full scan produced, so any divergence would show up as
 * drift in a user's numbers.
 */
export type UsageLine = {
  tokens: number
  model: string
  date: string | null
  hour: number | null
}

export function parseClaudeCodeLine(line: string): UsageLine | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line)
    const usage = parsed.message?.usage ?? parsed.usage ?? null
    if (!usage) return null
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    if (tokens <= 0) return null

    let date: string | null = null
    let hour: number | null = null
    if (parsed.timestamp) {
      const d = new Date(
        typeof parsed.timestamp === 'string' && /^\d+$/.test(parsed.timestamp)
          ? Number(parsed.timestamp)
          : parsed.timestamp
      )
      date = toDateStr(d)
      hour = d.getHours()
    }
    return { tokens, model: parsed.message?.model ?? '', date, hour }
  } catch {
    // malformed line (or an unparseable timestamp) — skip it
    return null
  }
}

/** Every Claude Code transcript on this machine. */
export async function claudeCodeFiles(): Promise<string[]> {
  return findFiles(claudeProjectsDir(), '.jsonl')
}

export async function scanClaudeCode(): Promise<ScanResult> {
  const collector = new TokenCollector('claude_code')

  for (const filePath of await claudeCodeFiles()) {
    try {
      const content = await readFile(filePath, 'utf8')
      let fallbackDate: string | null = null
      for (const line of content.split('\n')) {
        const usage = parseClaudeCodeLine(line)
        if (!usage) continue
        let date = usage.date
        if (!date) {
          fallbackDate ??= toDateStr((await stat(filePath)).mtime)
          date = fallbackDate
        }
        collector.addDaily(date, usage.model, usage.tokens, 1)
        if (usage.hour !== null) {
          collector.addHourly(date, usage.hour, usage.model, usage.tokens, 1)
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

/** Session date for a Codex log path (.codex/sessions/YYYY/MM/DD/file.jsonl). */
export function codexDateForFile(filePath: string): string | null {
  return codexDateFromRelPath(filePath.slice(codexSessionsDir().length + 1))
}

/** Every Codex session log on this machine. */
export async function codexFiles(): Promise<string[]> {
  return findFiles(codexSessionsDir(), '.jsonl')
}

/**
 * The running token total (and last model) a chunk of a Codex session log
 * reports. Codex writes cumulative totals rather than per-message deltas, so a
 * file's contribution is the max it ever reports — which also means an appended
 * chunk can only ever raise that max, and the incremental tick can take the
 * difference without re-reading the whole file.
 */
export function codexFileTotals(content: string): {
  maxTotal: number
  model: string
} {
  let maxTotal = 0
  let model = ''
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed.payload?.model) model = parsed.payload.model as string
      const usage = parsed.payload?.info?.total_token_usage
      if (usage) {
        const t = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        if (t > maxTotal) maxTotal = t
      }
    } catch {
      // skip malformed lines
    }
  }
  return { maxTotal, model }
}

export async function scanCodex(): Promise<ScanResult> {
  const collector = new TokenCollector('codex')

  for (const filePath of await codexFiles()) {
    try {
      const { maxTotal, model } = codexFileTotals(
        await readFile(filePath, 'utf8')
      )
      if (maxTotal <= 0) continue
      const date =
        codexDateForFile(filePath) ?? toDateStr((await stat(filePath)).mtime)
      collector.addDaily(date, model, maxTotal, 1)
    } catch {
      // skip unreadable files
    }
  }

  return collector.result()
}

export async function scanHermes(): Promise<ScanResult> {
  const dbPath = hermesDbPath()
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

export function parseOpenclawLine(line: string): UsageLine | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line)
    const usage =
      parsed.usage ??
      parsed.tokenUsage ??
      parsed.message?.usage ??
      parsed.response?.usage ??
      null
    if (!usage || typeof usage !== 'object') return null
    const tokens = (usage.total ??
      (usage.input ?? usage.inputTokens ?? 0) +
        (usage.output ?? usage.outputTokens ?? 0) +
        (usage.cacheRead ?? usage.cacheReadTokens ?? 0) +
        (usage.cacheWrite ?? usage.cacheWriteTokens ?? 0)) as number
    if (!tokens || tokens <= 0) return null

    let date: string | null = null
    let hour: number | null = null
    const ts = parsed.timestamp ?? parsed.t ?? parsed.time ?? null
    if (ts) {
      const tsMs = typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts
      const d = new Date(tsMs)
      if (!Number.isNaN(d.getTime())) {
        date = toDateStr(d)
        hour = d.getHours()
      }
    }

    const model: string = parsed.model ?? parsed.response?.model ?? ''
    return { tokens, model, date, hour }
  } catch {
    // skip malformed lines
    return null
  }
}

/** Every OpenClaw session log, across all of its agents. */
export async function openclawFiles(): Promise<string[]> {
  const agentsDir = openclawAgentsDir()
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
    // no OpenClaw on this machine
  }
  return sessionFiles
}

export async function scanOpenclaw(): Promise<ScanResult> {
  const collector = new TokenCollector('openclaw')

  for (const filePath of await openclawFiles()) {
    try {
      const content = await readFile(filePath, 'utf8')
      let fileFallbackDate: string | null = null
      for (const line of content.split('\n')) {
        const usage = parseOpenclawLine(line)
        if (!usage) continue
        let date = usage.date
        if (!date) {
          fileFallbackDate ??= toDateStr((await stat(filePath)).mtime)
          date = fileFallbackDate
        }
        collector.addDaily(date, usage.model, usage.tokens, 1)
        if (usage.hour !== null) {
          collector.addHourly(date, usage.hour, usage.model, usage.tokens, 1)
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return collector.result()
}

export async function scanOpenCode(): Promise<ScanResult> {
  const baseDir = opencodeDir()
  try {
    await stat(baseDir)
  } catch {
    return emptyResult('opencode')
  }

  const collector = new TokenCollector('opencode')

  // Preferred: SQLite. Schema: message.data JSON with
  // { role, modelID, time: { created: ms }, tokens: { input, output, reasoning, cache: { read, write } } }
  const dbPath = opencodeDbPath()
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

/**
 * Grok Build writes one `shell.turn.inference_done` line per model round to
 * `~/.grok/logs/unified.jsonl`. `prompt_tokens` is the full prompt (cache hits
 * included); `cached_prompt_tokens` and `reasoning_tokens` are subsets, so the
 * billed total is prompt + completion — same shape as counting Claude's
 * input+output+cache as one number.
 */
export function parseGrokLine(line: string): UsageLine | null {
  if (!line.includes('shell.turn.inference_done')) return null
  try {
    const parsed = JSON.parse(line) as {
      msg?: string
      ts?: string
      ctx?: Record<string, unknown>
      model?: string
    }
    if (parsed.msg !== 'shell.turn.inference_done') return null
    const ctx = parsed.ctx ?? {}
    const tokens =
      Number(ctx.prompt_tokens ?? 0) + Number(ctx.completion_tokens ?? 0)
    if (!Number.isFinite(tokens) || tokens <= 0) return null

    let date: string | null = null
    let hour: number | null = null
    if (parsed.ts) {
      const d = new Date(parsed.ts)
      if (!Number.isNaN(d.getTime())) {
        date = toDateStr(d)
        hour = d.getHours()
      }
    }
    const model =
      String(ctx.model_id ?? ctx.model ?? parsed.model ?? '').trim() || 'grok'
    return { tokens, model, date, hour }
  } catch {
    return null
  }
}

/** Grok Build's local usage log (and any rotated `unified*.jsonl` siblings). */
export async function grokLogFiles(): Promise<string[]> {
  return findFiles(grokLogsDir(), '.jsonl')
}

export async function scanGrok(): Promise<ScanResult> {
  const collector = new TokenCollector('grok')

  for (const filePath of await grokLogFiles()) {
    try {
      const content = await readFile(filePath, 'utf8')
      let fallbackDate: string | null = null
      for (const line of content.split('\n')) {
        const usage = parseGrokLine(line)
        if (!usage) continue
        let date = usage.date
        if (!date) {
          fallbackDate ??= toDateStr((await stat(filePath)).mtime)
          date = fallbackDate
        }
        collector.addDaily(date, usage.model, usage.tokens, 1)
        if (usage.hour !== null) {
          collector.addHourly(date, usage.hour, usage.model, usage.tokens, 1)
        }
      }
    } catch {
      // skip unreadable files
    }
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
 * Does this machine look like a Cursor machine? `scan` uses this to decide
 * whether asking for a Cursor API key is worth a prompt.
 *
 * A false positive costs a question the user has to skip, so this looks for
 * evidence Cursor has been *used* — the AI-tracking db, editor session state,
 * per-workspace storage, or local file history — rather than merely installed.
 * Every probe is a filesystem existence check, so it stays cheap enough to run
 * inline in the scan flow.
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
  /** Per-tool model breakdown. Optional on older incremental payloads. */
  modelsByTool?: Record<string, Record<string, number>>
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
  const [
    claude,
    codex,
    cursorApi,
    cursorLocal,
    openclaw,
    hermes,
    opencode,
    grok,
  ] = await Promise.all([
    scanClaudeCode(),
    scanCodex(),
    scanCursorApi(),
    scanCursorLocal(),
    scanOpenclaw(),
    scanHermes(),
    scanOpenCode(),
    scanGrok(),
  ])

  const cursor = resolveCursor(cursorApi, cursorLocal)
  return [claude, codex, cursor, openclaw, hermes, opencode, grok]
}

/**
 * Re-run only the Cursor API scanner and swap the result into an existing set of
 * scans. `scan` calls this after the user supplies a key mid-flow, so the exact
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
  const modelsByTool: Record<string, Record<string, number>> = {}
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
    let byTool = modelsByTool[r.tool]
    if (!byTool) {
      byTool = {}
      modelsByTool[r.tool] = byTool
    }
    for (const [model, tokens] of Object.entries(r.models)) {
      modelTotals[model] = (modelTotals[model] ?? 0) + tokens
      byTool[model] = (byTool[model] ?? 0) + tokens
    }
  }

  const cursor = results.find((r) => r.tool === 'cursor')
  return {
    toolTotals,
    dailyTotals,
    hourlyTotals,
    modelTotals,
    modelsByTool,
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
