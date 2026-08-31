import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  addPromptToActivity,
  emptyPromptActivity,
  type PromptActivityAggregate,
  type PromptLine,
  parsePromptLine,
} from '../prompt-stats.js'
import { getSessionPath } from '../session.js'
import {
  type AggregateScan,
  claudeCodeFiles,
  codexDateForFile,
  codexFiles,
  codexFileTotals,
  type DailyToolEntry,
  dateDaysAgo,
  grokLogFiles,
  hermesDbPath,
  openclawFiles,
  opencodeDbPath,
  PROMPT_ACTIVITY_DATE_CAP,
  PROMPT_ACTIVITY_SESSION_CAP,
  type PromptActivity,
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

export const SCAN_STATE_VERSION = 2

/** How long a session is kept in the state after its last prompt. */
export const PROMPT_SESSION_RETENTION_DAYS = 45
/** How long a per-day prompt tally is kept. Matches the wire's date cap. */
export const PROMPT_DAILY_RETENTION_DAYS = PROMPT_ACTIVITY_DATE_CAP

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
  /** model -> cumulative tokens */
  models: Record<string, number>
}

/**
 * The prompt half of the state: the same tail-read that counts tokens also
 * counts the user's own prompts, so `promptActivity` can ride out on the tick
 * instead of waiting a day.
 *
 * Unlike the token rows, prompt rows are upserted with GREATEST semantics per
 * (machine, session) and (machine, date), so a resend is free and a date never
 * has to go out "complete". That's why the dirty sets here are per-session and
 * per-date and can be drained a capped batch at a time.
 */
export type PromptState = PromptActivityAggregate & {
  /** Session ids changed since the last accepted upload. */
  dirtySessions: string[]
  /** Dates whose tally changed since the last accepted upload. */
  dirtyDates: string[]
  /**
   * Exactly what the last `tickPayload` put on the wire. `markUploaded` clears
   * this and nothing else, so anything a cap held back stays dirty.
   */
  sent?: { sessions: string[]; dates: string[] }
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
  /** Prompt sessions and per-day counts, plus what's outstanding. */
  prompts: PromptState
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
  return { files: {}, daily: {}, models: {} }
}

export function emptyPromptState(): PromptState {
  return { ...emptyPromptActivity(), dirtySessions: [], dirtyDates: [] }
}

export function emptyState(): ScanState {
  return {
    version: SCAN_STATE_VERSION,
    harnesses: {},
    dirty: [],
    prompts: emptyPromptState(),
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
    parsed.prompts ??= emptyPromptState()
    parsed.uploaded ??= { toolTotals: {}, modelTotals: {} }
    return parsed
  } catch {
    return null
  }
}

/**
 * Drop prompt rows that have aged out, dirty or not.
 *
 * Dropping a dirty row means it is never uploaded, which is the right trade at
 * this age: a session or a day that has sat unsent for its whole retention
 * window is not coming back, and the alternative is a dirty list that grows
 * forever on a machine that never consented (the tick still counts prompts at
 * the `none` tier — it just never sends them).
 */
function prunePrompts(prompts: PromptState): void {
  const sessionCutoff = dateDaysAgo(PROMPT_SESSION_RETENTION_DAYS)
  for (const [id, session] of Object.entries(prompts.sessions)) {
    if (session.lastActiveAt.slice(0, 10) < sessionCutoff) {
      delete prompts.sessions[id]
    }
  }
  const dateCutoff = dateDaysAgo(PROMPT_DAILY_RETENTION_DAYS)
  for (const date of Object.keys(prompts.daily)) {
    if (date < dateCutoff) delete prompts.daily[date]
  }
  prompts.dirtySessions = prompts.dirtySessions.filter(
    (id) => prompts.sessions[id] !== undefined
  )
  prompts.dirtyDates = prompts.dirtyDates.filter(
    (date) => prompts.daily[date] !== undefined
  )
}

/** Persist the state, pruning prompt rows that aged out of their retention
 * window (they'd otherwise accumulate forever). Best-effort. */
export async function saveScanState(state: ScanState): Promise<void> {
  prunePrompts(state.prompts)
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

type Aggregates = {
  daily: Record<string, TokensMessages>
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
  return { daily, models: { ...result.models } }
}

function aggregatesOf(h: HarnessState): Aggregates {
  return { daily: structuredClone(h.daily), models: { ...h.models } }
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
}

/** Swap in freshly scanned aggregates, dirtying the dates that moved. */
function replaceAggregates(
  h: HarnessState,
  next: Aggregates,
  dirty: Set<string>
) {
  markMovedDates({ daily: h.daily, models: h.models }, next, dirty)
  h.daily = next.daily
  h.models = next.models
}

/**
 * Swap in a freshly scanned prompt aggregate, dirtying every session and date
 * whose numbers moved. Same idea as `markMovedDates`: a daily full scan mostly
 * reproduces what the ticks already sent, and only the difference is worth
 * putting back on the wire.
 */
function replacePromptActivity(
  prompts: PromptState,
  next: PromptActivityAggregate
): void {
  const dirtySessions = new Set(prompts.dirtySessions)
  for (const id of new Set([
    ...Object.keys(prompts.sessions),
    ...Object.keys(next.sessions),
  ])) {
    const before = prompts.sessions[id]
    const after = next.sessions[id]
    if (!after) continue
    if (
      !before ||
      before.promptCount !== after.promptCount ||
      before.startedAt !== after.startedAt ||
      before.lastActiveAt !== after.lastActiveAt
    ) {
      dirtySessions.add(id)
    }
  }

  const dirtyDates = new Set(prompts.dirtyDates)
  for (const date of new Set([
    ...Object.keys(prompts.daily),
    ...Object.keys(next.daily),
  ])) {
    const before = prompts.daily[date]
    const after = next.daily[date]
    if (!after) continue
    if (
      !before ||
      before.prompts !== after.prompts ||
      before.words !== after.words
    ) {
      dirtyDates.add(date)
    }
  }

  prompts.sessions = next.sessions
  prompts.daily = next.daily
  // A session or date the full scan can no longer see has nothing left to say.
  prompts.dirtySessions = [...dirtySessions].filter(
    (id) => next.sessions[id] !== undefined
  )
  prompts.dirtyDates = [...dirtyDates]
    .filter((date) => next.daily[date] !== undefined)
    .sort()
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
  /**
   * Claude Code only: the same line read as prompt activity. Set here rather
   * than branching on `tool` so the tail-read stays one pass and a test can
   * point a prompt-bearing harness at a tmp dir.
   */
  parsePrompt?: (line: string) => PromptLine | null
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
        parsePrompt: parsePromptLine,
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

  // Same story for prompts: a re-read has to rebuild the aggregate from
  // scratch, or every session in it would be counted twice.
  const rebuildPrompts = invalidated && src.parsePrompt !== undefined
  const prompts: PromptActivityAggregate = rebuildPrompts
    ? emptyPromptActivity()
    : state.prompts
  const dirtySessions = new Set(state.prompts.dirtySessions)
  const dirtyDates = new Set(state.prompts.dirtyDates)

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
      const prompt = src.parsePrompt?.(line)
      if (prompt) {
        const touched = addPromptToActivity(prompts, prompt)
        dirtySessions.add(touched.sessionId)
        dirtyDates.add(touched.date)
      }

      const usage = src.parse(line)
      if (!usage) continue
      let date = usage.date
      if (!date) {
        fallbackDate ??= toDateStr(file.mtime)
        date = fallbackDate
      }
      addDaily(h, date, usage.model, usage.tokens, 1, target)
    }
    h.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, offset }
    changed = true
  }

  if (before) markMovedDates(before, aggregatesOf(h), dirty)

  if (rebuildPrompts) {
    // The rebuilt aggregate replaces the old one, dirtying only what moved.
    replacePromptActivity(state.prompts, prompts)
  } else if (src.parsePrompt) {
    state.prompts.dirtySessions = [...dirtySessions]
    state.prompts.dirtyDates = [...dirtyDates].sort()
  }
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
 * for a cold start — in which case this reads everything and marks no *token*
 * date dirty: those tokens are already on the server (the daily job put them
 * there), and re-uploading every date would only invite the reconcile to prune
 * rows this scan can't see (Cursor's, above all).
 *
 * Prompt rows go the other way on a cold start: everything found is marked
 * dirty. They're idempotent GREATEST upserts, so a resend costs nothing, and a
 * cold start (fresh install, or a state file this version can't read) is
 * exactly the case where we have no evidence any of it ever reached the server.
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

  if (cold) {
    state.dirty = []
    state.prompts.dirtySessions = Object.keys(state.prompts.sessions)
    state.prompts.dirtyDates = Object.keys(state.prompts.daily).sort()
  } else {
    state.dirty = [...dirty].sort()
  }
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
 * Is there prompt activity waiting to go out?
 *
 * A dirty id whose row is gone (pruned between the mark and the send) doesn't
 * count: it would have the tick POST an empty block every minute forever, since
 * there'd be nothing for `markUploaded` to clear.
 */
export function hasPromptActivity(state: ScanState): boolean {
  const { prompts } = state
  return (
    prompts.dirtySessions.some((id) => prompts.sessions[id] !== undefined) ||
    prompts.dirtyDates.some((date) => prompts.daily[date] !== undefined)
  )
}

/**
 * Stake a claim on the outstanding prompt rows: the ones this payload carries
 * are recorded in `prompts.sent`, and `markUploaded` clears exactly those. Rows
 * a cap held back stay dirty and go out next tick.
 *
 * Most-recently-active first, so a machine with a long backlog syncs the work
 * the user actually cares about before the archaeology.
 */
function takePromptActivity(state: ScanState): PromptActivity | undefined {
  const { prompts } = state

  const sessions = prompts.dirtySessions
    .flatMap((sessionId) => {
      const session = prompts.sessions[sessionId]
      return session ? [{ sessionId, ...session }] : []
    })
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, PROMPT_ACTIVITY_SESSION_CAP)

  const dates = [...prompts.dirtyDates]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, PROMPT_ACTIVITY_DATE_CAP)
  const dailyPrompts = dates.flatMap((date) => {
    const day = prompts.daily[date]
    return day ? [{ date, ...day }] : []
  })

  prompts.sent = { sessions: sessions.map((s) => s.sessionId), dates }
  if (sessions.length === 0 && dailyPrompts.length === 0) return undefined
  return { sessions, dailyPrompts }
}

/**
 * What a tick uploads: cumulative tool/model totals (the server diffs those
 * against its own per-machine snapshot) plus the daily rows for the dirty dates
 * only, and — under the `stats` or `full` tier — the outstanding prompt
 * activity.
 *
 * Every harness's rows go out for a dirty date, including Cursor's — which the
 * tick never scans, and carries over from the last full scan instead. The
 * server reconciles a date by deleting this machine's rows for it that the
 * payload didn't mention, so a date has to be reported complete or the harnesses
 * left out of it lose that day.
 */
export function tickPayload(
  state: ScanState,
  opts: { promptActivity?: boolean } = {}
): AggregateScan {
  const dirty = new Set(state.dirty)
  const dailyTotals: DailyToolEntry[] = []

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
  }

  // Claim the prompt rows this payload carries, or drop a claim a previous
  // payload left behind: a stale one would have `markUploaded` clear rows this
  // upload never mentioned (a tier turned down to `none` between two ticks).
  state.prompts.sent = undefined
  const promptActivity = opts.promptActivity
    ? takePromptActivity(state)
    : undefined

  const { toolTotals, modelTotals } = cumulativeTotals(state)
  return {
    toolTotals,
    dailyTotals,
    modelTotals,
    grandTotal: Object.values(toolTotals).reduce((a, b) => a + b, 0),
    cursorStats: null,
    cursorScanStatus: { source: 'none' },
    ...(promptActivity ? { promptActivity } : {}),
  }
}

/** Called on a 200: whatever that payload carried is on the server now. */
export function markUploaded(state: ScanState): void {
  state.dirty = []

  const sent = state.prompts.sent
  if (sent) {
    const sessions = new Set(sent.sessions)
    const dates = new Set(sent.dates)
    state.prompts.dirtySessions = state.prompts.dirtySessions.filter(
      (id) => !sessions.has(id)
    )
    state.prompts.dirtyDates = state.prompts.dirtyDates.filter(
      (date) => !dates.has(date)
    )
    state.prompts.sent = undefined
  }

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
 * What a full scan knows about prompts, and may therefore rewrite.
 *
 * The three cases are genuinely different, and collapsing any two of them
 * loses data: a command that never looked at prompts must not be read as a
 * command that found none.
 */
export type StagedPrompts =
  /** A prompt scan ran — re-base the prompt state on its aggregate. */
  | { scanned: PromptActivityAggregate }
  /** The user is at the `none` tier — drop the prompt state entirely. */
  | { scanned: null }
  /** This command never reads prompts (`hacklab scan`) — leave them alone. */
  | 'untouched'

/**
 * A full scan, re-based and ready to upload: the prompt rows this upload should
 * carry, and the `commit` that records the whole thing as delivered.
 */
export type StagedFullScan = {
  /**
   * Outstanding prompt activity to put on this upload, or undefined when there
   * is none (or the user is at the `none` tier).
   */
  promptActivity?: PromptActivity
  /**
   * Call once the server took the payload. Persists the re-based state, clears
   * the prompt rows this upload claimed, and leaves anything a cap held back
   * dirty for the next run. Best-effort and never throws.
   */
  commit: () => Promise<void>
}

/**
 * Rebuild the whole state from a full scan's results — the self-healing half of
 * the design. Whatever the tick's tail-follow got wrong (a rotated log, a
 * mid-file model switch, a Codex date guessed from an mtime) is corrected here,
 * so incremental drift can never outlive a day. Best-effort: a state we failed
 * to rebuild costs a tick, never the sync that called us.
 *
 * Staged rather than persisted outright, because the full-scan paths carry
 * prompt activity too — a machine with no daemon has no tick to drain it. The
 * rebuild diffs the scan's aggregate against what was already sent, claims the
 * difference for this upload, and only `commit` (on a 200) clears it. A failed
 * POST therefore leaves every row dirty for the next run, which the server's
 * GREATEST upserts make free to resend.
 *
 * `prompts` says whether this caller has any authority over the prompt state —
 * see `StagedPrompts`. Only a caller that actually resolved the consent tier
 * gets to rewrite it, and only such a caller claims prompt rows for the upload.
 */
export async function stageFullScan(
  results: ScanResult[],
  prompts: StagedPrompts = 'untouched',
  sources: TickSources = defaultSources()
): Promise<StagedFullScan> {
  const nothingStaged: StagedFullScan = {
    commit: async () => {
      // Nothing was staged, so there is nothing to record as delivered.
    },
  }
  try {
    const previous = await loadScanState()
    const state = emptyState()
    state.prompts = previous?.prompts ?? emptyPromptState()
    // Nothing is claimed as in-flight any more: whatever the last upload sent
    // was either acked (and cleared) or lost. A caller with authority re-derives
    // the claim below; one without leaves the rows dirty for the tick.
    state.prompts.sent = undefined
    if (prompts !== 'untouched') {
      replacePromptActivity(
        state.prompts,
        prompts.scanned ?? emptyPromptActivity()
      )
    }

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

    // Only a caller that knows the tier may put prompt rows on the wire. For
    // anyone else `sent` stays empty, so `commit` clears no prompt rows either.
    const claimed =
      prompts === 'untouched' ? undefined : takePromptActivity(state)
    return {
      ...(claimed ? { promptActivity: claimed } : {}),
      commit: async () => {
        try {
          // The full token payload just went out, and the server took the
          // prompt rows this upload claimed — markUploaded records both.
          markUploaded(state)
          await saveScanState(state)
        } catch {
          // never fail the sync that called us
        }
      },
    }
  } catch {
    // never fail the sync that called us
    return nothingStaged
  }
}
