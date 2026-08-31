import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Shared scanner types + helpers. Every tool scanner returns the same
// ScanResult shape so the aggregator (scanAllTools) can merge them uniformly —
// this is the single source of truth that replaces the old duplicated scanning
// across claim.ts and sync.ts.

export type Tool =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'openclaw'
  | 'hermes'
  | 'opencode'
  | 'grok'

export type DailyToolEntry = {
  date: string
  tool: string
  tokens: number
  messages?: number
  model?: string
}

/**
 * One coding session's prompt activity, as `promptActivity.sessions` carries it.
 * The server upserts these per (machine, sessionId) with GREATEST semantics, so
 * a resend after a failed POST is always safe.
 */
export type PromptSessionEntry = {
  sessionId: string
  startedAt: string
  lastActiveAt: string
  promptCount: number
}

/** One day's prompt counts, cumulative per (machine, date). */
export type PromptDayEntry = {
  date: string
  prompts: number
  words: number
}

/**
 * The prompt-metadata block of an upload. Present only under the `stats` or
 * `full` tier of `promptSync` — never at `none`, and never carrying prompt text
 * (that rides in `promptStats.conversationSample`, `full` only).
 */
export type PromptActivity = {
  sessions: PromptSessionEntry[]
  dailyPrompts: PromptDayEntry[]
}

/** The server's caps. Anything over stays dirty and goes out next tick. */
export const PROMPT_ACTIVITY_SESSION_CAP = 500
export const PROMPT_ACTIVITY_DATE_CAP = 400

export type CursorStats = {
  totalCommits: number
  aiLinesAdded: number
  humanLinesAdded: number
  avgAiPercent: number
  models: Array<{ model: string; uses: number }>
}

export type CursorScanStatus =
  | { source: 'none' }
  | { source: 'api'; events: number }
  | { source: 'api-partial'; events: number; reason: string }
  | { source: 'api-failed'; reason: string }

/**
 * Uniform result every scanner returns. No shared module state — each scanner
 * owns its own maps, so scanners are pure and safe to run concurrently.
 */
export type ScanResult = {
  tool: Tool
  daily: DailyToolEntry[]
  /** model name -> tokens, for the share card + modelTotals payload. */
  models: Record<string, number>
  /** Cursor-only: local commit stats (null for other tools). */
  cursorStats?: CursorStats | null
  /** Cursor-only: how the scan resolved (api/local/failed). */
  cursorScanStatus?: CursorScanStatus
}

export function emptyResult(tool: Tool): ScanResult {
  return { tool, daily: [], models: {} }
}

export type TokensMessages = { tokens: number; messages: number }

export function toDateStr(ts: string | number | Date): string {
  const v = typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts
  const d = new Date(v)
  return d.toISOString().slice(0, 10)
}

/** `n` days before today, as a YYYY-MM-DD cutoff. */
export function dateDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

/** Fold a raw model id into a short display label, keeping the version. */
export function shortModelName(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  const t = s.replace(/[-_]?\d{8}$/, '')
  const tier = t.includes('opus')
    ? 'opus'
    : t.includes('sonnet')
      ? 'sonnet'
      : t.includes('haiku')
        ? 'haiku'
        : null
  if (tier) {
    const ver = t
      .split(/[-_.\s]+/)
      .filter((p) => /^\d+$/.test(p))
      .slice(0, 2)
      .join('.')
    return (ver ? `${tier} ${ver}` : tier).toUpperCase()
  }
  return t.toUpperCase().slice(0, 16)
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)}GB`
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`
  if (n >= 1_024) return `${(n / 1_024).toFixed(0)}KB`
  return `${n}B`
}

/**
 * Current + longest activity-day streak from a set of activity dates
 * (YYYY-MM-DD, UTC). Mirrors the server's updateStreak so the share card shows
 * the same numbers the profile will after sync: the current streak only counts
 * if the most recent activity was today or yesterday.
 */
export function computeStreaks(dates: string[]): {
  current: number
  longest: number
} {
  const dateSet = new Set(dates)
  if (dateSet.size === 0) return { current: 0, longest: 0 }

  const sorted = [...dateSet].sort((a, b) => b.localeCompare(a)) // newest first
  const today = new Date().toISOString().slice(0, 10)
  const yest = new Date()
  yest.setUTCDate(yest.getUTCDate() - 1)
  const yesterday = yest.toISOString().slice(0, 10)

  let current = 0
  if (sorted[0] === today || sorted[0] === yesterday) {
    const cursor = new Date(`${sorted[0]}T00:00:00Z`)
    while (dateSet.has(cursor.toISOString().slice(0, 10))) {
      current++
      cursor.setUTCDate(cursor.getUTCDate() - 1)
    }
  }

  let longest = 0
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00Z`).getTime()
    const curr = new Date(`${sorted[i]}T00:00:00Z`).getTime()
    if (Math.round((prev - curr) / 86_400_000) === 1) {
      run++
    } else {
      longest = Math.max(longest, run)
      run = 1
    }
  }
  longest = Math.max(longest, run, current)

  return { current, longest }
}

/** Recursively collect files with a given extension; unreadable dirs are skipped. */
export async function findFiles(dir: string, ext: string): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string) {
    try {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.name.endsWith(ext)) {
          results.push(fullPath)
        }
      }
    } catch {
      // skip unreadable directories
    }
  }
  await walk(dir)
  return results
}

/**
 * Per-scanner accumulator. Replaces the old module-level modelAccumulator
 * globals — each scanner instantiates its own, so there is no cross-scan state
 * to clear and concurrent runs can't clobber each other.
 */
export class TokenCollector {
  private readonly dailyByModel = new Map<string, TokensMessages>()
  private readonly models = new Map<string, number>()

  constructor(private readonly tool: Tool) {}

  addDaily(date: string, model: string, tokens: number, messages = 1) {
    const key = `${date}|${model}`
    const existing = this.dailyByModel.get(key)
    if (existing) {
      existing.tokens += tokens
      existing.messages += messages
    } else {
      this.dailyByModel.set(key, { tokens, messages })
    }
    if (model) this.models.set(model, (this.models.get(model) ?? 0) + tokens)
  }

  result(extra?: Partial<ScanResult>): ScanResult {
    const daily: DailyToolEntry[] = Array.from(this.dailyByModel.entries()).map(
      ([key, { tokens, messages }]) => {
        const [date, model] = key.split('|')
        return {
          date: date ?? '',
          tool: this.tool,
          tokens,
          messages,
          model: model || undefined,
        }
      }
    )
    return {
      tool: this.tool,
      daily,
      models: Object.fromEntries(this.models),
      ...extra,
    }
  }
}
