import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Session = {
  token: string
  email: string
  handle?: string
  /**
   * Whether the profile has completed the username claim. A handle can exist on
   * an auto-created but unclaimed profile. `login` claims the handle the
   * account came with so a finished session is the default. Absent on
   * sessions saved before this field existed — treated as unclaimed until the
   * next login refreshes it.
   */
  usernameClaimed?: boolean
  appUrl: string
  savedAt: string
  expiresAt?: string
}

const SESSION_PATH = join(homedir(), '.hacklab', 'session.json')
const LEGACY_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type LoadSessionState =
  | { status: 'ok'; session: Session }
  | { status: 'missing' | 'invalid' | 'expired'; session: null }

export function getSessionPath(): string {
  return process.env.HACKLAB_SESSION_PATH ?? SESSION_PATH
}

export async function saveSession(session: Session): Promise<void> {
  const path = getSessionPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function getSessionExpiresAt(
  session: Pick<Session, 'expiresAt' | 'savedAt'>
): Date | null {
  const explicit = parseDate(session.expiresAt)
  if (explicit) return explicit

  const savedAt = parseDate(session.savedAt)
  if (!savedAt) return null

  return new Date(savedAt.getTime() + LEGACY_SESSION_TTL_MS)
}

export function isSessionExpired(
  session: Pick<Session, 'expiresAt' | 'savedAt'>,
  now = new Date()
): boolean {
  const expiresAt = getSessionExpiresAt(session)
  return expiresAt ? expiresAt.getTime() <= now.getTime() : false
}

export async function loadSessionState(): Promise<LoadSessionState> {
  let raw: string
  try {
    raw = await readFile(getSessionPath(), 'utf8')
  } catch {
    return { status: 'missing', session: null }
  }

  let data: Partial<Session>
  try {
    data = JSON.parse(raw) as Partial<Session>
  } catch {
    return { status: 'invalid', session: null }
  }

  if (!data.token || !data.email || !data.appUrl) {
    return { status: 'invalid', session: null }
  }

  const session = data as Session
  if (isSessionExpired(session)) {
    return { status: 'expired', session: null }
  }

  return { status: 'ok', session }
}

export async function loadSession(): Promise<Session | null> {
  return (await loadSessionState()).session
}

/**
 * Delete the local session file. Returns true if a file was removed, false if
 * there was nothing to clear (no session). Local-only — it doesn't revoke the
 * token server-side, so the token stays valid until it expires.
 */
export async function clearSession(): Promise<boolean> {
  try {
    await rm(getSessionPath())
    return true
  } catch {
    return false
  }
}

/**
 * Named backends the CLI can target via `--env`. Any other backend (e.g. an
 * internal preview or self-hosted instance) can be targeted with
 * `HACKLAB_APP_URL`.
 */
export const HACKLAB_ENVIRONMENTS = {
  production: 'https://hacklab.so',
  development: 'http://localhost:3000',
} as const

export type HacklabEnv = keyof typeof HACKLAB_ENVIRONMENTS

export function isHacklabEnv(value: string): value is HacklabEnv {
  return Object.hasOwn(HACKLAB_ENVIRONMENTS, value)
}

// Natural words that aren't a prefix of a canonical name but mean the same env.
const ENV_ALIASES: Record<string, HacklabEnv> = {
  local: 'development',
  localhost: 'development',
}

/**
 * Resolve an `--env` value to a canonical backend name. Accepts the full name,
 * any unambiguous prefix (`dev`/`prod`, mirroring how command names resolve so
 * abbreviations work everywhere), and a couple of natural aliases
 * (`local`/`localhost`). Returns null if it matches none — the env names start
 * with distinct letters, so a prefix is never ambiguous.
 */
export function resolveHacklabEnv(value: string): HacklabEnv | null {
  if (isHacklabEnv(value)) return value
  if (Object.hasOwn(ENV_ALIASES, value)) return ENV_ALIASES[value]!
  const names = Object.keys(HACKLAB_ENVIRONMENTS) as HacklabEnv[]
  const matches = names.filter((n) => n.startsWith(value))
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Reverse of HACKLAB_ENVIRONMENTS: the canonical env name for a backend URL, or
 * null when it isn't one of the three known backends (e.g. a custom
 * HACKLAB_APP_URL). Used to suggest the right `hacklab login --env <name>` when
 * a per-backend token is rejected.
 */
export function envNameForUrl(url: string): HacklabEnv | null {
  const normalized = url.replace(/\/$/, '')
  for (const [name, backend] of Object.entries(HACKLAB_ENVIRONMENTS) as [
    HacklabEnv,
    string,
  ][]) {
    if (backend === normalized) return name
  }
  return null
}

/**
 * Which backend to talk to, by precedence:
 *   1. an explicit `HACKLAB_APP_URL` (also how `--env` is applied — see
 *      index.ts) so `--env development` always switches backends;
 *   2. the backend you logged into (`session.appUrl`), when a session is given;
 *   3. the production default, so a freshly-installed `hacklab` hits hacklab.so
 *      rather than a localhost server that isn't running.
 *
 * The single source of this precedence: `getAppUrl()` is the no-session form,
 * and the chat command's `baseUrl()` is the session-aware form. Note the token
 * is per-backend, so pointing `--env` at an env you haven't logged into will
 * 401 until you `hacklab login --env <that>`.
 */
export function resolveAppUrl(
  session?: Pick<Session, 'appUrl'> | null
): string {
  const url =
    process.env.HACKLAB_APP_URL ??
    session?.appUrl ??
    HACKLAB_ENVIRONMENTS.production
  // Normalize here so callers never re-strip the trailing slash themselves.
  return url.replace(/\/$/, '')
}

// Turn a 401 from any authenticated endpoint into something the user can act
// on. A bare "Unauthorized" is almost always a per-backend token mismatch: the
// saved session only authenticates against the backend you logged into, but
// this command targets a different one (via --env / HACKLAB_APP_URL), so its
// token isn't valid there. Point at the exact re-login command for the *target*
// backend instead of dead-ending.
export function unauthorizedHint(session: Session): string {
  const target = resolveAppUrl(session)
  const env = envNameForUrl(target)
  const loginCmd =
    env && env !== 'production' ? `hacklab login --env ${env}` : 'hacklab login'
  const sessionUrl = session.appUrl.replace(/\/$/, '')
  if (sessionUrl !== target) {
    return `unauthorized — your session is for ${sessionUrl}, but this targets ${target}. run \`${loginCmd}\` to sign in there.`
  }
  return `unauthorized — your session may have expired. run \`${loginCmd}\` to sign in again.`
}

export function getAppUrl(): string {
  return resolveAppUrl()
}
