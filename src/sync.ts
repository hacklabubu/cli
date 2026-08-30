import { getMachineIdentity } from './machine.js'
import type { PromptSyncTier } from './prompt-consent.js'
import {
  type PromptStats,
  promptStatsPayload,
  scanPromptStats,
} from './prompt-stats.js'
import { stageFullScan } from './scanners/incremental.js'
import {
  type AggregateScan,
  type CursorScanStatus,
  type CursorStats,
  collectToolScans,
  type DailyToolEntry,
  formatBytes,
  formatTokens,
  mergeToolScans,
} from './scanners/index.js'
import {
  getSessionExpiresAt,
  resolveAppUrl,
  type Session,
  saveSession,
} from './session.js'
import { dim } from './ui.js'

export type { CursorScanStatus, CursorStats, DailyToolEntry }
// Token scanning lives in one place — the scanners/ module (used by both `scan`
// and `sync`). This file is just the `sync` command's API layer: session
// checks, the claim upload, and error formatting. Re-export the shared scan
// helpers so existing importers don't have to reach into scanners/ directly.
export { formatBytes, formatTokens }

export type SyncResult = {
  claudeTotal: number
  codexTotal: number
  cursorTotal: number
  openclawTotal: number
  hermesTotal: number
  opencodeTotal: number
  grokTotal: number
  messagesTotal: number
  allEntries: DailyToolEntry[]
  cursorStats: CursorStats | null
  result: Record<string, unknown>
  models: Array<{ name: string; tokens: number }>
  cursorScanStatus: CursorScanStatus
  /** What was uploaded under the consent tier, or null when opted out. */
  promptStats: PromptStats | null
}

export const LOGIN_EXPIRED_MESSAGE = 'login expired. run hacklab login again'

/**
 * A rejected upload, carrying the HTTP status and Retry-After. The minutely
 * tick needs to tell a 429 (back off, the server said so) from a 500 (retry
 * next minute); every other caller only ever reads `.message`, which is
 * unchanged from the plain Error this replaced.
 */
export class SyncUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null = null
  ) {
    super(message)
    this.name = 'SyncUploadError'
  }
}

type SessionCheck =
  | { status: 'ok' }
  | { status: 'unauthorized' }
  | { status: 'failed'; message: string }

function buildApiUrl(session: Session, path: string): string {
  return `${resolveAppUrl(session)}${path}`
}

function isLoopbackAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    )
  } catch {
    return false
  }
}

function getCauseMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  const cause = err.cause
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message?: unknown }).message
    return typeof message === 'string' ? message : null
  }
  return err.message === 'fetch failed' ? null : err.message
}

function formatFetchFailure(session: Session, err: unknown): string {
  const app = resolveAppUrl(session)
  const cause = getCauseMessage(err)
  const details = cause ? ` (${cause})` : ''
  if (isLoopbackAppUrl(app)) {
    return `could not reach ${app}${details}. start the web app or point ${dim('HACKLAB_APP_URL')} at a running backend and run ${dim('hacklab login')}`
  }
  return `could not reach ${app}${details}. check ${dim('HACKLAB_APP_URL')} or run ${dim('hacklab login')} again`
}

export async function fetchApi(
  session: Session,
  path: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetch(buildApiUrl(session, path), init)
  } catch (err) {
    throw new Error(formatFetchFailure(session, err))
  }
}

export async function checkSession(session: Session): Promise<SessionCheck> {
  let res: Response
  try {
    res = await fetchApi(session, '/api/xp', {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (res.status === 401) return { status: 'unauthorized' }

  if (res.status === 404) {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) return { status: 'ok' }
    return {
      status: 'failed',
      message: `Hacklab API not found at ${resolveAppUrl(session)}. check ${dim('HACKLAB_APP_URL')} or run ${dim('hacklab login')} again`,
    }
  }

  if (res.status >= 500) {
    return {
      status: 'failed',
      message: `Hacklab API failed at ${resolveAppUrl(session)} (${res.status}). try again later`,
    }
  }

  return { status: 'ok' }
}

/**
 * Ask the server to mirror the user's pinned GitHub repos into their projects
 * (and drop ones that are no longer pinned/public). Best-effort and non-fatal —
 * returns null on any failure so a GitHub hiccup never fails `sync`.
 */
export async function syncGithubRepos(
  session: Session
): Promise<{ synced: number; removed: number } | null> {
  try {
    const res = await fetchApi(session, '/api/cli/github-sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (!res.ok) return null
    return (await res.json()) as { synced: number; removed: number }
  } catch {
    return null
  }
}

/** The harnesses the backend tallies, with explicit zeros so the payload shape
 * is stable regardless of which tools the scan actually found. */
function toolTotalsRecord(scan: AggregateScan) {
  return {
    claude_code: scan.toolTotals.claude_code ?? 0,
    codex: scan.toolTotals.codex ?? 0,
    cursor: scan.toolTotals.cursor ?? 0,
    openclaw: scan.toolTotals.openclaw ?? 0,
    hermes: scan.toolTotals.hermes ?? 0,
    opencode: scan.toolTotals.opencode ?? 0,
    grok: scan.toolTotals.grok ?? 0,
  }
}

/**
 * Upload a scan's token totals to the backend (the `/api/claim/sync` capsule).
 * The single place the upload payload is built and the response is checked, so
 * the `sync` command and the daily background job all push the exact same
 * shape. Throws LOGIN_EXPIRED_MESSAGE on 401 so callers can tell an expired
 * session apart from a transient failure. Pass `timeoutMs` to hard-cap a slow
 * upload; omit it for an unbounded one-shot.
 *
 * Tags the upload with this machine's stable id so the backend can sum usage
 * across the user's machines while keeping each machine's re-sync idempotent.
 */
export async function uploadTokenScan(
  session: Session,
  scan: AggregateScan,
  opts: {
    timeoutMs?: number
    interactive?: boolean
    /** Consented prompt statistics. Omitted entirely unless the user opted in. */
    promptStats?: PromptStats | null
  } = {}
): Promise<Record<string, unknown>> {
  const { machineId, machineName } = await getMachineIdentity()
  const res = await fetchApi(session, '/api/claim/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
      // Manual `hacklab sync` counts as user activity; the automated daily job
      // (this same endpoint) does not. The
      // backend emits user_active only when this header is present, so the
      // shared payload stays identical otherwise.
      ...(opts.interactive ? { 'x-hacklab-interactive': '1' } : {}),
    },
    body: JSON.stringify({
      machineId,
      machineName,
      dailyTotals: scan.dailyTotals,
      toolTotals: toolTotalsRecord(scan),
      modelTotals: scan.modelTotals,
      // Both blocks are absent unless consented — the backend's fields are
      // optional, so an opted-out sync carries token counts and nothing else.
      // `promptStats` rides on full scans (histogram, projects, and under the
      // `full` tier the text sample); `promptActivity` rides on ticks (session
      // and per-day metadata, no text ever).
      ...(opts.promptStats
        ? { promptStats: promptStatsPayload(opts.promptStats) }
        : {}),
      ...(scan.promptActivity ? { promptActivity: scan.promptActivity } : {}),
    }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  })

  if (res.status === 401) {
    throw new SyncUploadError(LOGIN_EXPIRED_MESSAGE, 401)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new SyncUploadError(
      (data as { error?: string } | null)?.error ??
        `sync failed (${res.status})`,
      res.status,
      res.headers.get('retry-after')
    )
  }
  return (await res.json()) as Record<string, unknown>
}

// Refresh within the last week of the 30-day session window — frequent enough to
// never lapse on a daily job, rare enough to barely touch the endpoint.
const REFRESH_WHEN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Ask the backend to slide this session's expiry forward (token unchanged) and
 * persist the result. Returns the updated session, or null if the refresh failed
 * (e.g. the session already expired — that needs a fresh `hacklab login`).
 */
export async function refreshSession(
  session: Session
): Promise<Session | null> {
  let res: Response
  try {
    res = await fetchApi(session, '/api/cli/session/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as {
    token?: string
    expiresAt?: string
  } | null
  if (!data?.token || !data.expiresAt) return null

  const updated: Session = {
    ...session,
    token: data.token,
    expiresAt: data.expiresAt,
    savedAt: new Date().toISOString(),
  }
  await saveSession(updated)
  return updated
}

/**
 * Proactively refresh the session when it's nearing expiry, so a long-running
 * daily background sync never lapses. A no-op (returns the session unchanged)
 * when there's plenty of time left or the refresh fails.
 */
export async function ensureFreshSession(session: Session): Promise<Session> {
  const expiresAt = getSessionExpiresAt(session)
  if (!expiresAt) return session
  if (expiresAt.getTime() - Date.now() > REFRESH_WHEN_WITHIN_MS) return session
  return (await refreshSession(session)) ?? session
}

export async function runSync(
  session: Session,
  opts: { interactive?: boolean; promptSync?: PromptSyncTier } = {}
): Promise<SyncResult> {
  const results = await collectToolScans()
  const scan = mergeToolScans(results)
  // Scanning transcripts is skipped entirely at the 'none' tier — an opted-out
  // user's conversations are never even read.
  const promptStats = await scanConsentedPromptStats(opts.promptSync)
  // Re-base the tick's incremental state on this scan before uploading — same
  // repair the daily job does, so a manual `hacklab sync` also clears any drift
  // (and refreshes the Cursor totals the tick can only carry over). It has to
  // come first because the rebuild is what works out which prompt rows are
  // still outstanding, and those ride along on this very upload: a machine with
  // no daemon has no tick to drain them.
  const staged = await stageFullScan(results, {
    scanned: promptStats?.activity ?? null,
  })

  const result = await uploadTokenScan(
    session,
    staged.promptActivity
      ? { ...scan, promptActivity: staged.promptActivity }
      : scan,
    { interactive: opts.interactive, promptStats }
  )
  // Only now is any of it delivered. A throw above leaves the saved state
  // untouched, so the next run re-derives the same claim and resends it.
  await staged.commit()

  const totals = toolTotalsRecord(scan)
  const allEntries = scan.dailyTotals
  const messagesTotal = allEntries.reduce((s, e) => s + (e.messages ?? 0), 0)
  const models = Object.entries(scan.modelTotals)
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    claudeTotal: totals.claude_code,
    codexTotal: totals.codex,
    cursorTotal: totals.cursor,
    openclawTotal: totals.openclaw,
    hermesTotal: totals.hermes,
    opencodeTotal: totals.opencode,
    grokTotal: totals.grok,
    messagesTotal,
    allEntries,
    cursorStats: scan.cursorStats,
    result,
    models,
    cursorScanStatus: scan.cursorScanStatus,
    promptStats,
  }
}

/**
 * Scan the local transcripts for the given consent tier, or return null when
 * there's no consent (or nothing to find). Never throws: prompt stats are an
 * extra on top of the token sync, so a scan failure must not cost the user
 * their token upload.
 */
export async function scanConsentedPromptStats(
  tier: PromptSyncTier | undefined
): Promise<PromptStats | null> {
  if (!tier || tier === 'none') return null
  try {
    return await scanPromptStats({ includeSample: tier === 'full' })
  } catch {
    return null
  }
}
