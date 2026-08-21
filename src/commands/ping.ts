import { loadSession, resolveAppUrl, unauthorizedHint } from '../session.js'
import { dim, error, info, success } from '../ui.js'

// `hacklab ping` — one round-trip to the backend. Without a saved session it
// only answers "is the server reachable". With one, it sends the session token
// so the server can record that *this* user's CLI checked in — the signal the
// app uses to show "your agent is setting up your profile" the moment an agent
// starts working, instead of making the user wait for full setup. The session
// token is the proof of identity: it's the per-user secret minted at login, so
// a ping can't be forged from just someone's username.
//
// Server contract (POST /api/cli/ping):
//   - no Authorization header → 2xx, nothing recorded (pure reachability).
//   - `Authorization: Bearer <token>` → 2xx and the ping is recorded for that
//     user; 401 when the token doesn't verify.

const PING_TIMEOUT_MS = 8000

export async function ping(): Promise<void> {
  const session = await loadSession()
  const server = resolveAppUrl(session)

  let res: Response
  const started = performance.now()
  try {
    res = await fetch(`${server}/api/cli/ping`, {
      method: 'POST',
      headers: session
        ? { Authorization: `Bearer ${session.token}` }
        : undefined,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
  } catch {
    error(`could not reach ${server}`)
    process.exit(1)
  }
  const ms = Math.round(performance.now() - started)

  // Any HTTP response proves the server is up; the status only matters for
  // whether the authenticated ping was recorded.
  success(`server reached — ${server} ${dim(`(${ms}ms)`)}`)

  if (!session) return

  if (res.ok) {
    info(`authenticated as ${session.handle ?? session.email} — ping recorded`)
  } else if (res.status === 401) {
    info(unauthorizedHint(session))
  } else {
    info(`server error (${res.status}) — ping not recorded`)
  }
}
