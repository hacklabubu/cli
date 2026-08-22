import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PostHog } from 'posthog-node'
import { envNameForUrl, getSessionPath, resolveAppUrl } from './session.js'
import { dim } from './ui.js'

// Single source of the published version (one level up from this module in both
// `dist/` and `src/`), tagged onto every event so we can slice by CLI version.
const require = createRequire(import.meta.url)
const { version: CLI_VERSION } = require('../package.json') as {
  version: string
}

// The PostHog *project* API key for the CLI's own project (id 226792, separate
// from the web app's project 226288). It's a publishable client key (phc_…,
// write-only) that ships inside the published npm package regardless, so
// committing it here is fine. `POSTHOG_API_KEY` overrides it for dev/testing.
// The CLI never reads Vercel env (it runs on users' machines), so its key lives
// here, not in Vercel.
const PROJECT_API_KEY =
  process.env.POSTHOG_API_KEY ??
  'phc_oCCCCjjTXkmknHh5gjEhsqJNuJ77BqsZUU96MRtAHoYQ'
const HOST = process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com'

type TelemetryState = { anonymousId?: string; noticeShownAt?: string }

// Telemetry state (anon id + one-time-notice flag) lives next to the session
// file, so it honors HACKLAB_SESSION_PATH exactly like the update-check cache.
function telemetryPath(): string {
  return join(dirname(getSessionPath()), 'telemetry.json')
}

/**
 * Telemetry is opt-OUT. It's off when the user sets `HACKLAB_NO_TELEMETRY`
 * (mirrors `HACKLAB_NO_UPDATE_CHECK`) or the cross-tool `DO_NOT_TRACK` standard
 * (https://consoledonottrack.com). Checked at every entry point, so a disabled
 * CLI never constructs a client, phones home, or installs exception handlers.
 */
export function isTelemetryDisabled(): boolean {
  if (process.env.HACKLAB_NO_TELEMETRY) return true
  const dnt = process.env.DO_NOT_TRACK
  return dnt === '1' || dnt === 'true'
}

async function readState(): Promise<TelemetryState> {
  try {
    return JSON.parse(
      await fs.readFile(telemetryPath(), 'utf8')
    ) as TelemetryState
  } catch {
    return {}
  }
}

async function writeState(state: TelemetryState): Promise<void> {
  try {
    await fs.mkdir(dirname(telemetryPath()), { recursive: true })
    await fs.writeFile(
      telemetryPath(),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8'
    )
  } catch {
    // Best-effort: a failed write just means a fresh anon id / re-shown notice.
  }
}

/**
 * A stable anonymous device id for events that fire before (or without) login.
 * Generated once and persisted; on login we `alias` it to the real handle so
 * PostHog stitches the anonymous history onto the identified user.
 */
async function getAnonymousId(): Promise<string> {
  const state = await readState()
  if (state.anonymousId) return state.anonymousId
  const anonymousId = `anon_${randomUUID()}`
  await writeState({ ...state, anonymousId })
  return anonymousId
}

let client: PostHog | null = null
function getClient(): PostHog {
  if (!client) {
    client = new PostHog(PROJECT_API_KEY, {
      host: HOST,
      // We flush explicitly after every capture (and on shutdown), so disable
      // both of posthog-node's background-flush triggers: the count trigger
      // (flushAt — set high enough that a single CLI run never hits it) and the
      // timer (flushInterval: 0). This matters because a background flush routes
      // its failure to a hardcoded console.error we can't intercept — it would
      // dump a network stack trace into the user's terminal on a flaky
      // connection. Our explicit flush rejects into our own try/catch instead,
      // so a telemetry failure stays silent.
      flushAt: 1000,
      flushInterval: 0,
      // Best-effort telemetry: don't retry a failed send. The default is 3
      // retries with a 3s backoff, and that backoff timer is what keeps a
      // one-shot CLI alive for ~10s after the command visibly finished when the
      // network is down. No retries → fail fast → the process exits promptly.
      fetchRetryCount: 0,
      // Tighter than the 10s default so a black-holed connection gives up fast.
      requestTimeout: 3000,
      enableExceptionAutocapture: true,
    })
  }
  return client
}

/**
 * Properties attached to every CLI event. CLI and web now live in separate
 * PostHog projects, but we still tag `source: 'cli'` as a cheap, explicit
 * discriminator — handy if the two datasets are ever combined, and it costs
 * nothing to keep.
 */
function defaultProperties(): Record<string, unknown> {
  return {
    source: 'cli',
    cli_version: CLI_VERSION,
    os: process.platform,
    arch: process.arch,
    node_version: process.versions.node,
    environment: envNameForUrl(resolveAppUrl()) ?? 'unknown',
  }
}

// Never let a stuck network hold up the CLI: cap any send at a couple seconds
// and move on. The timer is unref'd so it can't by itself keep the process
// alive after the real work is done.
async function withTimeout(p: Promise<unknown>, ms = 2000): Promise<void> {
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
    }),
  ])
}

/**
 * Capture an event and flush it. Falls back to the anonymous device id when no
 * handle is given, so pre-auth usage is still counted (and later stitched onto
 * the user via `identifyUser`). Fire-and-forget: gated on opt-out, wrapped so it
 * can never slow down or break the command that called it.
 */
export async function captureEvent(
  distinctId: string | undefined,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  if (isTelemetryDisabled()) return
  try {
    const id = distinctId ?? (await getAnonymousId())
    const ph = getClient()
    ph.capture({
      distinctId: id,
      event,
      properties: { ...defaultProperties(), ...properties },
    })
    await withTimeout(ph.flush())
  } catch {
    // Telemetry must never break a command. Swallow everything.
  }
}

/**
 * Identify the logged-in user and merge any anonymous pre-login history onto
 * them. `properties` is passed straight through (callers set `$set` /
 * `$set_once`). Opt-out gated and fully wrapped.
 */
export async function identifyUser(
  handle: string,
  properties: Record<string, unknown>
): Promise<void> {
  if (isTelemetryDisabled()) return
  try {
    const ph = getClient()
    const { anonymousId } = await readState()
    if (anonymousId && anonymousId !== handle) {
      ph.alias({ distinctId: handle, alias: anonymousId })
    }
    ph.identify({ distinctId: handle, properties })
    await withTimeout(ph.flush())
  } catch {
    // Identification is best-effort — never break login over it.
  }
}

/** Report an unhandled error to PostHog. Opt-out gated and wrapped. */
export async function captureException(
  error: unknown,
  distinctId?: string
): Promise<void> {
  if (isTelemetryDisabled()) return
  try {
    const ph = getClient()
    const id = distinctId ?? (await getAnonymousId())
    ph.captureException(error, id, defaultProperties())
    await withTimeout(ph.flush())
  } catch {
    // Swallow — a telemetry failure must not mask the original error.
  }
}

/**
 * Final drain before the process exits. No-op if telemetry never initialized.
 * Uses flush(), not shutdown(): shutdown() routes a failed flush to a hardcoded
 * console.error (a network stack trace in the user's terminal), whereas flush()
 * rejects into our own catch and stays silent. There are no background timers to
 * clear (flushInterval is 0), so flush() is a complete drain here.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!client) return
  try {
    await withTimeout(client.flush())
  } catch {
    // Best-effort final flush.
  }
}

/**
 * One-time, one-line notice that the CLI collects anonymous usage, with the
 * opt-out. Interactive only (never in pipes / CI / the quiet daily run), shown
 * once per machine (flagged in telemetry.json). Mirrors the update-check nudge:
 * stderr, TTY-gated, and wrapped so it can never break or delay a command.
 */
export async function maybePrintTelemetryNotice(): Promise<void> {
  try {
    if (isTelemetryDisabled()) return
    if (!process.stdout.isTTY) return
    const state = await readState()
    if (state.noticeShownAt) return
    await writeState({
      ...state,
      anonymousId: state.anonymousId ?? `anon_${randomUUID()}`,
      noticeShownAt: new Date().toISOString(),
    })
    process.stderr.write(
      `${dim(
        'hacklab collects anonymous usage analytics to improve the CLI — opt out with HACKLAB_NO_TELEMETRY=1 (or DO_NOT_TRACK=1).'
      )}\n`
    )
  } catch {
    // A notice must never break or delay the actual command.
  }
}
