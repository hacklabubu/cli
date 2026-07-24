import { loadSession, type Session, unauthorizedHint } from './session.js'
import { dim, error, info } from './ui.js'

// Shared plumbing for authenticated agent-friendly commands (profile, hacker):
// one login gate, one JSON error envelope, one reader for the server's
// {schemaVersion, error} shape — so the 401/429 copy can't drift per command.

/** Print the versioned JSON error envelope and exit 1 (agent mode). */
export function emitJsonError(code: string, message: string): never {
  console.log(JSON.stringify({ schemaVersion: 1, error: { code, message } }))
  process.exit(1)
}

/** Login gate: returns the session or exits with mode-appropriate copy. */
export async function requireSession(json: boolean): Promise<Session> {
  const session = await loadSession()
  if (!session) {
    if (json) emitJsonError('unauthorized', 'not logged in')
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }
  return session
}

/**
 * Human-readable message for a non-2xx envelope body. 401 gets the per-backend
 * re-login hint (an --env mismatch names the exact login command), 429 the
 * slow-down copy; anything else relays the server's message.
 */
export function apiErrorMessage(
  status: number,
  body: { error?: { message?: string } } | null,
  session: Session
): string {
  if (status === 401) return unauthorizedHint(session)
  if (status === 429) return 'slow down. try again in a minute.'
  return body?.error?.message ?? `request failed (${status})`
}

/** Read a failed Response's envelope and shape it via apiErrorMessage. */
export async function readApiError(
  res: Response,
  session: Session
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string }
  } | null
  return apiErrorMessage(res.status, body, session)
}
