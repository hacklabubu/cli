import { createServer } from 'node:http'
import * as clack from '@clack/prompts'
import { clearSyncPaused } from '../daily-sync.js'
import { captureEvent, identifyUser } from '../posthog.js'
import { getAppUrl, saveSession } from '../session.js'
import { bold, dim, info, linkBlue, success, white } from '../ui.js'
import { openBrowser } from '../utils/openBrowser.js'

// What every login path resolves to before we persist a session.
type Credentials = {
  token: string
  email: string
  handle?: string
  /** True only for a finished account; false/undefined for an unclaimed one. */
  usernameClaimed?: boolean
  expiresAt?: string
}

/**
 * Authenticate and save a session. Two paths to the same result:
 *  - device-code flow (the default): GitHub's device flow — authorize on
 *    github.com/login/device (signed into GitHub, not Hacklab), and the backend
 *    maps your GitHub identity to the linked Hacklab account. No local server,
 *    no port forwarding, no localhost/app URL. Works the same everywhere.
 *  - localhost-callback flow (only with `--browser`): opens the browser and
 *    catches the OAuth redirect on a local server.
 *
 * `allowSignup` (set by `join`) lets the device flow *create* an account when
 * the GitHub identity has none yet; `login` leaves it off, so an unknown GitHub
 * is told to run `join`. The callback flow always creates-or-logs-in via real
 * OAuth, so it's signup-capable regardless.
 */
export async function login(
  opts: { browser?: boolean; allowSignup?: boolean } = {}
): Promise<void> {
  clack.intro('hacklab login')

  const appUrl = getAppUrl()

  let creds: Credentials | null = null
  if (!opts.browser) {
    // Device flow is the default. null = this backend has no device routes yet
    // (e.g. not deployed) — the only case we fall back to the browser flow,
    // since there's no device flow to use there.
    creds = await loginViaDevice(appUrl, opts.allowSignup ?? false)
    if (!creds) {
      info(
        dim('device login unavailable on this server — using browser sign-in.')
      )
    }
  }
  if (!creds) {
    creds = await loginViaCallback(appUrl)
  }

  await saveSession({
    token: creds.token,
    email: creds.email,
    handle: creds.handle,
    usernameClaimed: creds.usernameClaimed,
    appUrl,
    savedAt: new Date().toISOString(),
    expiresAt: creds.expiresAt,
  })
  // The session is fresh again — drop any "background sync paused" marker so a
  // stale notice doesn't fire after the user just fixed it.
  await clearSyncPaused()

  const label = creds.handle ? `${creds.email} (${creds.handle})` : creds.email
  success(`logged in as ${label}`)
  clack.outro(dim('hack the planet.'))

  if (creds.handle) {
    await identifyUser(creds.handle, {
      $set: { email: creds.email, handle: creds.handle, app_url: appUrl },
    })
    await captureEvent(creds.handle, 'cli_login_completed', {
      login_method: opts.browser ? 'browser_callback' : 'device_flow',
      username_claimed: creds.usernameClaimed ?? false,
    })
  }
}

/**
 * Device-code flow. Returns the credentials on approval, or null if the backend
 * doesn't support it (so the caller can fall back). Throws on an explicit
 * denial, expiry, or timeout.
 */
async function loginViaDevice(
  appUrl: string,
  allowSignup: boolean
): Promise<Credentials | null> {
  let startRes: Response
  try {
    startRes = await fetch(`${appUrl}/api/cli/device/start`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // Connection refused / DNS / timeout — the server isn't reachable. Name the
    // URL so the cause (e.g. local dev app not running) is obvious.
    throw new Error(`could not reach ${appUrl} — is the server running?`)
  }
  // Older backend without the device routes — let login fall back to callback.
  if (startRes.status === 404) return null
  if (!startRes.ok) {
    throw new Error(`could not start device login (${startRes.status})`)
  }
  const start = (await startRes.json()) as {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string | null
    expiresIn: number
    interval: number
  }

  // GitHub's device flow: the user authorizes on github.com, signed into GitHub
  // (not Hacklab). We map the resulting GitHub identity to their linked account.
  // `format` overrides clack's default dim styling: body text white, URL blue.
  clack.note(
    `open GitHub and authorize Hacklab:\n  ${start.verificationUri}\n\nthen enter this code:\n  ${bold(start.userCode)}`,
    'sign in with github',
    {
      format: (line) =>
        line.includes(start.verificationUri) ? linkBlue(line) : white(line),
    }
  )
  info(dim('opening your browser to GitHub (or open the link above yourself).'))
  void openBrowser(start.verificationUriComplete ?? start.verificationUri)

  const intervalMs = Math.max(1000, (Number(start.interval) || 5) * 1000)
  const deadline = Date.now() + (Number(start.expiresIn) || 900) * 1000

  const spin = clack.spinner()
  spin.start('waiting for you to authorize on GitHub')

  while (Date.now() < deadline) {
    let data: {
      status?: string
      token?: string
      email?: string
      handle?: string
      usernameClaimed?: boolean
      expiresAt?: string
      login?: string
    } | null = null
    try {
      const res = await fetch(`${appUrl}/api/cli/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: start.deviceCode, allowSignup }),
        signal: AbortSignal.timeout(10_000),
      })
      // Back off naturally on a rate-limit; otherwise read the status.
      if (res.status !== 429) data = await res.json().catch(() => null)
    } catch {
      // Transient network error — keep polling until the deadline.
    }

    const status = data?.status
    if (status === 'approved' && data?.token && data.email) {
      spin.stop('approved')
      return {
        token: data.token,
        email: data.email,
        handle: data.handle,
        usernameClaimed: data.usernameClaimed,
        expiresAt: data.expiresAt,
      }
    }
    if (status === 'denied') {
      spin.stop('denied')
      throw new Error('authorization was denied on GitHub.')
    }
    if (status === 'expired') {
      spin.stop('code expired')
      throw new Error('the code expired — run `hacklab login` again.')
    }
    if (status === 'no_account') {
      spin.stop('no linked account')
      const who = typeof data?.login === 'string' ? ` (@${data.login})` : ''
      throw new Error(
        `no hacklab account is linked to that GitHub${who}. run \`hacklab join\` to register.`
      )
    }

    await sleep(intervalMs)
  }

  spin.stop('timed out')
  throw new Error('login timed out — run `hacklab login` again.')
}

/** Localhost-callback flow: open the browser, catch the OAuth redirect locally. */
async function loginViaCallback(appUrl: string): Promise<Credentials> {
  return await new Promise<Credentials>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`)
      const token = url.searchParams.get('token')
      const email = url.searchParams.get('email')
      const handle = url.searchParams.get('handle')
      const usernameClaimed = url.searchParams.get('usernameClaimed') === '1'
      const expiresAt = normalizeDateParam(url.searchParams.get('expiresAt'))

      if (!token || !email) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h1>login failed</h1><p>missing token. try again.</p>')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<h1>logged in!</h1><p>you can close this tab and go back to your terminal.</p>'
      )

      stopServer()
      resolve({
        token,
        email,
        handle: handle ?? undefined,
        usernameClaimed,
        expiresAt,
      })
    })

    // Bind 0 = a random free port. On a headless host you can't open the
    // browser locally, so the user opens the URL elsewhere and the OAuth
    // redirect must reach this callback server — which means forwarding the
    // port (e.g. `ssh -L`). Pin it with HACKLAB_CALLBACK_PORT so the forward is
    // deterministic across runs. (Headless usually uses the device flow above,
    // so this hint is a fallback for a misdetected display.)
    const callbackPort = Number(process.env.HACKLAB_CALLBACK_PORT) || 0
    server.listen(callbackPort, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        stopServer()
        reject(new Error('failed to start callback server'))
        return
      }

      const callbackUrl = `http://127.0.0.1:${addr.port}`
      const loginUrl = `${appUrl}/cli/auth?callback=${encodeURIComponent(callbackUrl)}`

      info('to sign in, open this URL in a browser:')
      info(`  ${loginUrl}`)
      if (isLikelyHeadless()) {
        info(
          dim(
            'headless? drop --browser to use the device code, or forward the port:'
          )
        )
        info(dim(`  ssh -L ${addr.port}:localhost:${addr.port} <this-host>`))
        info(dim('  (pin it with HACKLAB_CALLBACK_PORT to reuse one forward)'))
      }
      // Best-effort auto-open — crash-safe, and a harmless no-op on headless.
      void openBrowser(loginUrl)
    })

    // Timeout after 2 minutes
    timeout = setTimeout(() => {
      stopServer()
      reject(new Error('login timed out. try again.'))
    }, 120_000)

    function stopServer() {
      if (timeout) clearTimeout(timeout)
      server.close()
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeDateParam(value: string | null): string | undefined {
  if (!value) return undefined

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Heuristic for "this host probably can't pop a browser": a Linux/Unix box with
 * no display server. macOS and Windows always have a usable GUI opener. Only
 * used inside the `--browser` flow to decide whether to print the port-forward
 * hint — it no longer gates device-vs-browser (device is always the default).
 */
function isLikelyHeadless(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return false
  }
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}
