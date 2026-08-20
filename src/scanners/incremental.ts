import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { getSessionPath } from '../session.js'
import {
  type AggregateScan,
  claudeCodeFiles,
  codexDateForFile,
  codexFiles,
  codexFileTotals,
  type DailyToolEntry,
  grokLogFiles,
  type HourlyEntry,
  hermesDbPath,
  hourlyCutoff,
  openclawFiles,
  opencodeDbPath,
  parseClaudeCodeLine,
  parseGrokLine,
  parseOpenclawLine,
  type ScanResult,
  scanHermes,
  scanOpenCode,
  type TokensMessages,
  type Tool,
  toDateStr,
  type UsageLine,
} from './index.js'

// The incremental half of the scanners: what `hacklab sync --tick` runs every
// minute instead of the full stateless re-scan the daily job does.
//
// The idea is a tail-follow. Everything the last scan already accounted for is
// kept in scan-state.json — per-file read offsets plus the aggregates those
// bytes produced — so a tick only has to stat the log tree and parse the bytes
// that were appended since. Lines are parsed by the exact same functions the
// full scanners use (parseClaudeCodeLine / parseOpenclawLine / codexFileTotals),
// so the tail can be added to aggregates the full scan produced without drift.
//
// Anything that makes the tail-follow unsound (a file shrank, or one we were
// following disappeared) drops that harness back to a full re-read, because we
// don't track which file contributed which tokens. And the daily `sync --quiet`
// rebuilds the whole state from its full scan, so drift can never last a day.

export const SCAN_STATE_VERSION = 1

/** Where a file's tail-follow stands: what we saw, and how far we read. */
export type FileState = { size: number; mtimeMs: number; offset: number }

/** Codex only: the running total a session file has reported so far. */
export type CodexFileState = { maxTotal: number; model: string; date: string }

export type HarnessState = {
  /** JSONL harnesses: per-file read cursor, keyed by absolute path. */
  files: Record<string, FileState>
  /** Codex only: per-file running totals (see codexFileTotals). */
  codexTotals?: Record<string, CodexFileState>
  /** SQLite harnesses: fingerprints of the db and its -wal. */
  dbMtimeMs?: number
  walMtimeMs?: number
  /** "date|model" -> tokens/messages */
  daily: Record<string, TokensMessages>
  /** "date|hour|model" -> tokens/messages */
  hourly: Record<string, TokensMessages>
  /** model -> cumulative tokens */
  models: Record<string, number>
}

export type ScanState = {
  version: number
  harnesses: Record<string, HarnessState>
  /**
   * Dates whose rows changed since the last accepted upload. Dates, not
   * (harness, date) pairs, because the server reconciles a synced date by
   * deleting this machine's rows for that date that the payload didn't
   * mention — so a date we touch has to go out complete, with every harness's
   * rows for it. Cleared only on a 200, so a failed POST retries next tick.
   */
  dirty: string[]
  /** Cumulative totals as of the last accepted upload. */
  uploaded: {
    toolTotals: Record<string, number>
    modelTotals: Record<string, number>
  }
  /** 429 backoff: ticks before this epoch-ms do nothing. */
  nextAllowedAt?: number
  /** The last failure written to sync.log, so a stuck tick can't fill it. */
  lastError?: string
}

/** Lives next to the session file, so it honors HACKLAB_SESSION_PATH. */
export function scanStatePath(): string {
  return join(dirname(getSessionPath()), 'scan-state.json')
}

export function emptyHarness(): HarnessState {
  return { files: {}, daily: {}, hourly: {}, models: {} }
}

export function emptyState(): ScanState {
  return {
    version: SCAN_STATE_VERSION,
    harnesses: {},
    dirty: [],
    uploaded: { toolTotals: {}, modelTotals: {} },
  }
}

function harness(state: ScanState, tool: string): HarnessState {
  const existing = state.harnesses[tool]
  if (existing) return existing
  const fresh = emptyHarness()
  state.harnesses[tool] = fresh
  return fresh
}

/**
 * The saved state, or null when there isn't a usable one — missing, corrupt, or
 * written by an older layout. Null means "re-read everything from scratch";
 * callers must treat that rebuild as a baseline, not as new tokens.
 */
export async function loadScanState(): Promise<ScanState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(scanStatePath(), 'utf8')
    ) as ScanState
    if (parsed?.version !== SCAN_STATE_VERSION) return null
    if (!parsed.harnesses || typeof parsed.harnesses !== 'object') return null
    parsed.dirty ??= []
    parsed.uploaded ??= { toolTotals: {}, modelTotals: {} }
    return parsed
  } catch {
    return null
  }
}

/** Persist the state, pruning hourly buckets that fell out of the 90-day window
 * the server keeps (they'd otherwise accumulate forever). Best-effort. */
export async function saveScanState(state: ScanState): Promise<void> {
  const cutoff = hourlyCutoff()
  for (const h of Object.values(state.harnesses)) {
    for (const key of Object.keys(h.hourly)) {
      if ((key.split('|')[0] ?? '') < cutoff) delete h.hourly[key]
    }
  }
  try {
    await mkdir(dirname(scanStatePath()), { recursive: true })
    await writeFile(scanStatePath(), `${JSON.stringify(state)}\n`, 'utf8')
  } catch {
    // a state we can't persist just means the next tick re-reads everything
  }
}

// ---- aggregate bookkeeping -------------------------------------------------

function addDaily(
  h: HarnessState,
  date: string,
  model: string,
  tokens: number,
  messages: number,
  dirty: Set<string>
) {
  const key = `${date}|${model}`
  const existing = h.daily[key]
  if (existing) {
    existing.tokens += tokens
    existing.messages += messages
  } else {
    h.daily[key] = { tokens, messages }
  }
  if (model) h.models[model] = (h.models[model] ?? 0) + tokens
  dirty.add(date)
}

function addHourly(
  h: HarnessState,
  date: string,
  hour: number,
  model: string,
  tokens: number,
  messages: number,
  dirty: Set<string>
) {
  if (date < hourlyCutoff()) return
  const key = `${date}|${hour}|${model}`
  const existing = h.hourly[key]
  if (existing) {
    existing.tokens += tokens
    existing.messages += messages
  } else {
    h.hourly[key] = { tokens, messages }
  }
  dirty.add(date)
}

type Aggregates = {
  daily: Record<string, TokensMessages>
  hourly: Record<string, TokensMessages>
  models: Record<string, number>
}

/** A full scanner's result as the maps the state stores. */
export function aggregatesOfResult(result: ScanResult): Aggregates {
  const daily: Record<string, TokensMessages> = {}
  for (const entry of result.daily) {
    daily[`${entry.date}|${entry.model ?? ''}`] = {
      tokens: entry.tokens,
      messages: entry.messages ?? 0,
    }
  }
  const hourly: Record<string, TokensMessages> = {}
  for (const entry of result.hourly) {
    hourly[`${entry.date}|${entry.hour}|${entry.model ?? ''}`] = {
      tokens: entry.tokens,
      messages: entry.messages ?? 0,
    }
  }
  return { daily, hourly, models: { ...result.models } }
}

function aggregatesOf(h: HarnessState): Aggregates {
  return {
    daily: structuredClone(h.daily),
    hourly: structuredClone(h.hourly),
    models: { ...h.models },
  }
}

/**
 * Mark every date whose rows moved between two versions of a harness's
 * aggregates. Used whenever a harness is re-read rather than tailed (a SQLite
 * requery, or a JSONL harness whose tail-follow was invalidated): most dates
 * come back identical, so diffing keeps the upload down to what actually
 * changed instead of re-sending the user's whole history.
 */
function markMovedDates(
  before: Aggregates,
  after: Aggregates,
  dirty: Set<string>
) {
  const compare = (
    a: Record<string, TokensMessages>,
    b: Record<string, TokensMessages>
  ) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[key]
      const y = b[key]
      if (!x || !y || x.tokens !== y.tokens || x.messages !== y.messages) {
        dirty.add(key.split('|')[0] ?? '')
      }
    }
  }
  compare(before.daily, after.daily)
  compare(before.hourly, after.hourly)
}

/** Swap in freshly scanned aggregates, dirtying the dates that moved. */
function replaceAggregates(
  h: HarnessState,
  next: Aggregates,
  dirty: Set<string>
) {
  markMovedDates(
    { daily: h.daily, hourly: h.hourly, models: h.models },
    next,
    dirty
  )
  h.daily = next.daily
  h.hourly = next.hourly
  h.models = next.models
}

// ---- reading the tail ------------------------------------------------------

async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Read `[from, to)` and hand back only whole lines. A harness may be mid-append
 * when we look, so the trailing partial line is left for the next tick — that's
 * what the returned offset points at.
 */
export async function readCompleteLines(
  path: string,
  from: number,
  to: number
): Promise<{ text: string; offset: number }> {
  if (to <= from) return { text: '', offset: from }
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(buf, 0, buf.length, from)
    const chunk = buf.subarray(0, bytesRead)
    // Byte-wise, not string-wise: the chunk can end mid-codepoint.
    const lastNewline = chunk.lastIndexOf(0x0a)
    if (lastNewline < 0) return { text: '', offset: from }
    return {
      text: chunk.subarray(0, lastNewline).toString('utf8'),
      offset: from + lastNewline + 1,
    }
  } finally {
    await handle.close()
  }
}

// ---- per-harness ticks -----------------------------------------------------

export type JsonlSource = {
  tool: Tool
  files: () => Promise<string[]>
  parse: (line: string) => UsageLine | null
}

export type CodexSource = {
  files: () => Promise<string[]>
  /** Session date from the path layout, or null to fall back to the mtime day. */
  dateFor: (path: string) => string | null
}

export type SqliteSource = {
  tool: Tool
  dbPath: () => string
  scan: () => Promise<ScanResult>
}

export type TickSources = {
  jsonl: JsonlSource[]
  codex: CodexSource
  sqlite: SqliteSource[]
}

/** The real harnesses. Injectable so the tick can be tested against a tmp dir. */
export function defaultSources(): TickSources {
  return {
    jsonl: [
      {
        tool: 'claude_code',
        files: claudeCodeFiles,
        parse: parseClaudeCodeLine,
      },
      { tool: 'openclaw', files: openclawFiles, parse: parseOpenclawLine },
      { tool: 'grok', files: grokLogFiles, parse: parseGrokLine },
    ],
    codex: { files: codexFiles, dateFor: codexDateForFile },
    sqlite: [
      { tool: 'hermes', dbPath: hermesDbPath, scan: scanHermes },
      { tool: 'opencode', dbPath: opencodeDbPath, scan: scanOpenCode },
    ],
  }
}

type FileScan = { path: string; size: number; mtimeMs: number; mtime: Date }

async function statFiles(paths: string[]): Promise<FileScan[]> {
  const out: FileScan[] = []
  for (const path of paths) {
    const s = await statOrNull(path)
    if (s) out.push({ path, size: s.size, mtimeMs: s.mtimeMs, mtime: s.mtime })
  }
  return out
}

/**
 * Can we still trust this harness's aggregates? Not if a file we were following
 * lost bytes or vanished: we know what those files contributed in total but not
 * per file, so there's nothing to subtract and the only repair is a re-read.
 */
function tailInvalidated(h: HarnessState, files: FileScan[]): boolean {
  const present = new Map(files.map((f) => [f.path, f]))
  for (const [path, state] of Object.entries(h.files)) {
    const now = present.get(path)
    if (!now || now.size < state.offset) return true
  }
  return false
}

function resetHarness(h: HarnessState) {
  h.files = {}
  if (h.codexTotals) h.codexTotals = {}
  h.daily = {}
  h.hourly = {}
  h.models = {}
}

async function tickJsonl(
  state: ScanState,
  src: JsonlSource,
  dirty: Set<string>
): Promise<boolean> {
  const h = harness(state, src.tool)
  const files = await statFiles(await src.files())
  const invalidated = tailInvalidated(h, files)
  // On a re-read, collect into a throwaway set and diff at the end: most of the
  // rebuilt aggregate is identical to what we had, and only the difference is
  // worth re-uploading.
  const before = invalidated ? aggregatesOf(h) : null
  const target = invalidated ? new Set<string>() : dirty
  if (invalidated) resetHarness(h)

  let changed = invalidated
  for (const file of files) {
    const prev = h.files[file.path]
    if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
      continue
    }
    const from = prev?.offset ?? 0
    const { text, offset } = await readCompleteLines(
      file.path,
      from,
      file.size
    ).catch(() => ({ text: '', offset: from }))
    let fallbackDate: string | null = null
    for (const line of text.split('\n')) {
      const usage = src.parse(line)
      if (!usage) continue
      let date = usage.date
      if (!date) {
        fallbackDate ??= toDateStr(file.mtime)
        date = fallbackDate
      }
      addDaily(h, date, usage.model, usage.tokens, 1, target)
      if (usage.hour !== null) {
        addHourly(h, date, usage.hour, usage.model, usage.tokens, 1, target)
      }
    }
    h.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, offset }
    changed = true
  }

  if (before) markMovedDates(before, aggregatesOf(h), dirty)
  return changed
}

async function tickCodex(
  state: ScanState,
  src: CodexSource,
  dirty: Set<string>
): Promise<boolean> {
  const h = harness(state, 'codex')
  h.codexTotals ??= {}
  const files = await statFiles(await src.files())
  const invalidated = tailInvalidated(h, files)
  const before = invalidated ? aggregatesOf(h) : null
  const target = invalidated ? new Set<string>() : dirty
  if (invalidated) {
    resetHarness(h)
    h.codexTotals = {}
  }

  let changed = invalidated
  for (const file of files) {
    const prev = h.files[file.path]
    if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
      continue
    }
    const from = prev?.offset ?? 0
    const { text, offset } = await readCompleteLines(
      file.path,
      from,
      file.size
    ).catch(() => ({ text: '', offset: from }))
    const { maxTotal, model } = codexFileTotals(text)
    const stored = h.codexTotals[file.path]
    const date = stored?.date ?? src.dateFor(file.path) ?? toDateStr(file.mtime)
    const storedMax = stored?.maxTotal ?? 0
    const nextMax = Math.max(storedMax, maxTotal)
    // A session that switches model mid-file leaves the earlier tokens under the
    // old model — the full scan credits them all to the last model seen. The
    // daily repair pass reconciles that.
    const nextModel = model || stored?.model || ''
    if (nextMax > storedMax) {
      // Running totals: only the growth is new. `messages` counts the session
      // once, the way the full scan does (one addDaily per file).
      addDaily(
        h,
        date,
        nextModel,
        nextMax - storedMax,
        storedMax === 0 ? 1 : 0,
        target
      )
    }
    h.codexTotals[file.path] = { maxTotal: nextMax, model: nextModel, date }
    h.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, offset }
    changed = true
  }

  if (before) markMovedDates(before, aggregatesOf(h), dirty)
  return changed
}

/**
 * SQLite-backed harnesses can't be tailed — a write lands anywhere in the file —
 * but their DBs are small, so the incremental strategy is to fingerprint the db
 * and its -wal and re-run the harness's normal query only when one moved.
 */
async function tickSqlite(
  state: ScanState,
  src: SqliteSource,
  dirty: Set<string>
): Promise<boolean> {
  const h = harness(state, src.tool)
  const path = src.dbPath()
  const db = await statOrNull(path)
  const wal = await statOrNull(`${path}-wal`)
  const dbMtimeMs = db?.mtimeMs ?? 0
  const walMtimeMs = wal?.mtimeMs ?? 0
  if (h.dbMtimeMs === dbMtimeMs && h.walMtimeMs === walMtimeMs) return false

  replaceAggregates(h, aggregatesOfResult(await src.scan()), dirty)
  h.dbMtimeMs = dbMtimeMs
  h.walMtimeMs = walMtimeMs
  return true
}

export type TickOutcome = {
  state: ScanState
  /** Did anything on disk move? (If not, the state file isn't worth rewriting.) */
  changed: boolean
}

/**
 * One incremental pass over every harness. `prev` is the saved state, or null
 * for a cold start — in which case this reads everything and marks nothing
 * dirty: those tokens are already on the server (the daily job put them there),
 * and re-uploading every date would only invite the reconcile to prune rows
 * this scan can't see (Cursor's, above all).
 */
export async function runTick(
  prev: ScanState | null,
  sources: TickSources = defaultSources()
): Promise<TickOutcome> {
  const cold = prev === null
  const state = prev ?? emptyState()
  const dirty = new Set(state.dirty)
  let changed = cold

  for (const src of sources.jsonl) {
    if (await tickJsonl(state, src, dirty)) changed = true
  }
  if (await tickCodex(state, sources.codex, dirty)) changed = true
  for (const src of sources.sqlite) {
    if (await tickSqlite(state, src, dirty)) changed = true
  }

  state.dirty = cold ? [] : [...dirty].sort()
  return { state, changed }
}

// ---- payload ---------------------------------------------------------------

/** Cumulative per-tool and per-model totals for this machine. */
export function cumulativeTotals(state: ScanState): {
  toolTotals: Record<string, number>
  modelTotals: Record<string, number>
} {
  const toolTotals: Record<string, number> = {}
  const modelTotals: Record<string, number> = {}
  for (const [tool, h] of Object.entries(state.harnesses)) {
    let sum = 0
    for (const value of Object.values(h.daily)) sum += value.tokens
    toolTotals[tool] = sum
    for (const [model, tokens] of Object.entries(h.models)) {
      modelTotals[model] = (modelTotals[model] ?? 0) + tokens
    }
  }
  return { toolTotals, modelTotals }
}

export function sameTotals(
  a: Record<string, number>,
  b: Record<string, number>
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false
  return true
}

/**
 * What a tick uploads: cumulative tool/model totals (the server diffs those
 * against its own per-machine snapshot) plus the daily and hourly rows for the
 * dirty dates only.
 *
 * Every harness's rows go out for a dirty date, including Cursor's — which the
 * tick never scans, and carries over from the last full scan instead. The
 * server reconciles a date by deleting this machine's rows for it that the
 * payload didn't mention, so a date has to be reported complete or the harnesses
 * left out of it lose that day.
 */
export function tickPayload(state: ScanState): AggregateScan {
  const dirty = new Set(state.dirty)
  const dailyTotals: DailyToolEntry[] = []
  const hourlyTotals: HourlyEntry[] = []

  for (const [tool, h] of Object.entries(state.harnesses)) {
    for (const [key, value] of Object.entries(h.daily)) {
      const [date = '', model = ''] = key.split('|')
      if (!dirty.has(date) || value.tokens <= 0) continue
      dailyTotals.push({
        date,
        tool,
        tokens: value.tokens,
        messages: value.messages,
        model: model || undefined,
      })
    }
    for (const [key, value] of Object.entries(h.hourly)) {
      const [date = '', hour = '0', model = ''] = key.split('|')
      if (!dirty.has(date) || value.tokens <= 0) continue
      hourlyTotals.push({
        date,
        hour: Number(hour),
        tool,
        model: model || undefined,
        tokens: value.tokens,
        messages: value.messages,
      })
    }
  }

  const { toolTotals, modelTotals } = cumulativeTotals(state)
  return {
    toolTotals,
    dailyTotals,
    hourlyTotals,
    modelTotals,
    grandTotal: Object.values(toolTotals).reduce((a, b) => a + b, 0),
    cursorStats: null,
    cursorScanStatus: { source: 'none' },
  }
}

/** Called on a 200: the dirty dates are on the server now. */
export function markUploaded(state: ScanState): void {
  state.dirty = []
  state.uploaded = cumulativeTotals(state)
  state.lastError = undefined
  state.nextAllowedAt = undefined
}

// ---- the daily repair pass -------------------------------------------------

async function snapshotFileCursors(h: HarnessState, paths: string[]) {
  for (const file of await statFiles(paths)) {
    // Offsets are set to EOF *after* the full scan read the file, so a file that
    // grew mid-scan is re-read from the end rather than double-counted — the
    // next repair picks up whatever slipped through.
    h.files[file.path] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      offset: file.size,
    }
  }
}

/**
 * Rebuild the whole state from a full scan's results — the self-healing half of
 * the design. Whatever the tick's tail-follow got wrong (a rotated log, a
 * mid-file model switch, a Codex date guessed from an mtime) is corrected here,
 * so incremental drift can never outlive a day. Best-effort: a state we failed
 * to rebuild costs a tick, never the sync that just succeeded.
 */
export async function rebuildScanState(
  results: ScanResult[],
  sources: TickSources = defaultSources()
): Promise<void> {
  try {
    const state = emptyState()
    for (const result of results) {
      replaceAggregates(
        harness(state, result.tool),
        aggregatesOfResult(result),
        new Set()
      )
    }

    for (const src of sources.jsonl) {
      await snapshotFileCursors(harness(state, src.tool), await src.files())
    }

    // Codex has to be re-read: its per-file running totals aren't recoverable
    // from the aggregate, and without them the next tick would count each file's
    // whole total a second time.
    const codex = harness(state, 'codex')
    codex.codexTotals = {}
    const codexPaths = await sources.codex.files()
    await snapshotFileCursors(codex, codexPaths)
    for (const path of codexPaths) {
      const cursor = codex.files[path]
      if (!cursor) continue
      const content = await readFile(path, 'utf8').catch(() => '')
      const { maxTotal, model } = codexFileTotals(content)
      if (maxTotal <= 0) continue
      codex.codexTotals[path] = {
        maxTotal,
        model,
        date:
          sources.codex.dateFor(path) ?? toDateStr(new Date(cursor.mtimeMs)),
      }
    }

    for (const src of sources.sqlite) {
      const h = harness(state, src.tool)
      const path = src.dbPath()
      h.dbMtimeMs = (await statOrNull(path))?.mtimeMs ?? 0
      h.walMtimeMs = (await statOrNull(`${path}-wal`))?.mtimeMs ?? 0
    }

    // The full payload just went out, so nothing is outstanding.
    state.uploaded = cumulativeTotals(state)
    await saveScanState(state)
  } catch {
    // never fail the sync that called us
  }
}
