import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSessionPath } from '../session.js'
import { dim } from '../ui.js'

// A globally-installed `hacklab` (what the installer now does) is convenient but
// can silently rot — the user who hit the 0.5.0 bug proved how confusing a stale
// CLI is. This nudge turns "silently old" into one visible line, checked at most
// once a day so it never slows the CLI down or hammers the registry.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Tight bound: this runs before command output once a day on an interactive run,
// so cap the worst-case stall on a slow network. The npm registry answers in
// well under this; a miss just defers the nudge to the next run.
const FETCH_TIMEOUT_MS = 800
const PACKAGE = 'hacklab'

// Cache lives next to the session file (~/.hacklab/), honoring HACKLAB_SESSION_PATH.
function cachePath(): string {
  return join(dirname(getSessionPath()), 'update-check.json')
}

/** Numeric-dotted compare: is published version `a` newer than running `b`? */
export function isNewerVersion(a: string, b: string): boolean {
  // Strict Number (not parseInt): "3-beta" -> NaN, so a prerelease segment trips
  // the guard below instead of being read as 3.
  const pa = a.split('.').map((n) => Number(n))
  const pb = b.split('.').map((n) => Number(n))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    // Non-numeric segment (prerelease tag, etc.) — don't guess, treat as not-newer.
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x > y
  }
  return false
}

async function readCache(): Promise<{ latest: string; fresh: boolean } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(cachePath(), 'utf8')) as {
      latest?: unknown
      checkedAt?: unknown
    }
    if (typeof raw.latest === 'string' && typeof raw.checkedAt === 'number') {
      return {
        latest: raw.latest,
        fresh: Date.now() - raw.checkedAt < CACHE_TTL_MS,
      }
    }
  } catch {
    // No cache yet / unreadable — treat as a miss.
  }
  return null
}

/**
 * Ask the npm registry for hacklab's latest published version. Timeout-guarded
 * and never throws — a failed/slow lookup resolves to undefined so callers (the
 * daily nag, `hacklab update`) can degrade gracefully rather than block.
 */
export async function fetchLatest(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Abbreviated metadata: a few hundred bytes instead of the full packument.
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { version?: unknown }
    return typeof data.version === 'string' ? data.version : undefined
  } catch {
    return undefined
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    await fs.mkdir(dirname(cachePath()), { recursive: true })
    await fs.writeFile(
      cachePath(),
      JSON.stringify({ latest, checkedAt: Date.now() })
    )
  } catch {
    // Best-effort: a failed write just means we re-check next run.
  }
}

/**
 * Print a one-line "newer version available" nudge to stderr. No-ops (instantly,
 * no network) when stdout isn't a TTY (piped / CI / `--json` consumers) or when
 * HACKLAB_NO_UPDATE_CHECK is set. Wrapped so it can never throw or wedge the CLI;
 * the registry lookup is timeout-guarded and runs at most once per day.
 */
export async function notifyIfOutdated(current: string): Promise<void> {
  try {
    if (process.env.HACKLAB_NO_UPDATE_CHECK) return
    if (!process.stdout.isTTY) return

    const cached = await readCache()
    let latest = cached?.latest
    if (!cached || !cached.fresh) {
      const fetched = await fetchLatest()
      if (fetched) {
        latest = fetched
        await writeCache(fetched)
      }
    }

    if (latest && isNewerVersion(latest, current)) {
      console.error(
        dim(
          `↑ hacklab ${latest} is available (you have ${current}) · update: hacklab update`
        )
      )
    }
  } catch {
    // An update check must never break or delay the actual command.
  }
}
