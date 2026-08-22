import { envNameForUrl, loadSession, resolveAppUrl } from '../session.js'
import { dim, error, info, success } from '../ui.js'

/**
 * `HACKLAB_DEV` — an explicit developer opt-in, read at call time so a test (or
 * a `hacklab` invoked from a script) can set it per run. Unset, empty, `0` and
 * `false` are off; anything else (typically `1`) is on, so `HACKLAB_DEV=0`
 * never turns something on.
 *
 * It's an env var rather than a filesystem guess: a deployed copy of the repo
 * tree (nixpacks-style, `/app`) looks exactly like a source checkout on disk,
 * so no path heuristic can tell a developer apart from a deploy.
 */
function devMode(): boolean {
  const raw = process.env.HACKLAB_DEV
  if (!raw) return false
  return raw !== '0' && raw !== 'false'
}

export async function whoami() {
  const session = await loadSession()

  if (!session) {
    error('not logged in')
    info(`run ${dim('hacklab login')} to authenticate`)
    process.exit(1)
  }

  const server = resolveAppUrl(session)
  const loginServer = session.appUrl.replace(/\/$/, '')

  success(session.handle ? `@${session.handle}` : session.email)
  if (session.handle) info(session.email)
  // Production is the default — for users, naming it is noise, and only a
  // local/custom backend is worth calling out. Developers opt in with
  // HACKLAB_DEV=1 to always see which backend they're talking to, production
  // included.
  if (envNameForUrl(server) !== 'production' || devMode()) info(server)
  if (server !== loginServer) {
    info(dim(`logged in against ${loginServer}`))
  }
}
