import { envNameForUrl, loadSession, resolveAppUrl } from '../session.js'
import { dim, error, info, success } from '../ui.js'

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
  // Production is the default — naming it is noise. Local/custom backends
  // are the case where you need to see which one you're talking to.
  if (envNameForUrl(server) !== 'production') info(server)
  if (server !== loginServer) {
    info(dim(`logged in against ${loginServer}`))
  }
}
