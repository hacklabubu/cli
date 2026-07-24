import { loadSession, resolveAppUrl } from '../session.js'
import { dim, error, info, success } from '../ui.js'

export async function whoami() {
  const session = await loadSession()

  if (!session) {
    error('not logged in')
    info(`run ${dim('hacklab login')} to authenticate`)
    process.exit(1)
  }

  // The backend commands will actually hit, honoring --env / HACKLAB_APP_URL.
  const server = resolveAppUrl(session)
  const loginServer = session.appUrl.replace(/\/$/, '')

  success(session.handle ?? session.email)
  info(`email: ${session.email}`)
  if (session.handle) {
    info(`handle: ${session.handle}`)
  }
  info(`server: ${server}`)
  // An --env override can point requests somewhere this session's token isn't
  // valid (tokens are per-backend) — flag where you actually logged in.
  if (server !== loginServer) {
    info(dim(`(logged in against ${loginServer} — token may not work here)`))
  }
}
