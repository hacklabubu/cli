import { clearSyncPaused } from '../daily-sync.js'
import { captureEvent, identifyUser } from '../posthog.js'
import {
  getAppUrl,
  resolveAppUrl,
  type Session,
  saveSession,
} from '../session.js'
import { bold, dim, link } from '../ui.js'
import { openBrowser } from '../utils/openBrowser.js'
import { waitForEnter } from '../utils/waitForEnter.js'

type Credentials = {
  token: string
  email: string
  handle?: string
  usernameClaimed?: boolean
  expiresAt?: string
}

export type LoginOutcome = {
  /** The session as it now stands (already persisted by `performLogin`). */
  session: Session
  /**
   * True when the account had a handle that still needed claiming and
   * `POST /api/cli/claim` never succeeded. `login` shrugs this off; `setup`
   * surfaces it, because the web onboarding UI polls `username_claimed` and
   * waits forever when the claim is silently lost.
   */
  claimFailed: boolean
}

/**
 * Authenticate via GitHub's device flow and persist the session. Unknown GitHub
 * identities get an account. An unclaimed GitHub-derived handle is claimed as-is.
 *
 * The shared implementation behind both `hacklab login` and `hacklab setup` —
 * there is exactly one device flow (the code/URL beat with the parallel
 * Enter-wait ↔ poll race), and both front doors go through it. `claimAttempts`
 * is how hard the handle claim tries before giving up.
 */
export async function performLogin(
  opts: { claimAttempts?: number } = {}
): Promise<LoginOutcome> {
  const appUrl = getAppUrl()
  const creds = await loginViaDevice(appUrl)

  const outcome = await ensureHandleClaimed(
    {
      token: creds.token,
      email: creds.email,
      handle: creds.handle,
      usernameClaimed: creds.usernameClaimed,
      appUrl,
      savedAt: new Date().toISOString(),
      expiresAt: creds.expiresAt,
    },
    opts.claimAttempts
  )

  await saveSession(outcome.session)
  await clearSyncPaused()
  return outcome
}

/**
 * Make sure the session's handle is actually claimed, resolving it from the
 * profile first when the device poll didn't send one. Pure: it returns the
 * updated session (the same object when nothing changed) and leaves persistence
 * to the caller, so it works both on a session that was just minted and on one
 * already sitting on disk from a half-finished signup.
 */
export async function ensureHandleClaimed(
  session: Session,
  attempts = 1
): Promise<LoginOutcome> {
  if (session.handle && session.usernameClaimed) {
    return { session, claimFailed: false }
  }

  const appUrl = resolveAppUrl(session)
  let handle = session.handle
  let usernameClaimed = session.usernameClaimed
  if (!handle) {
    const me = await fetchMe(appUrl, session.token)
    handle = me?.handle ?? me?.githubUsername ?? undefined
    if (me?.claimed != null) usernameClaimed = me.claimed
  }

  if (!handle || usernameClaimed) {
    return {
      session: { ...session, handle, usernameClaimed },
      claimFailed: false,
    }
  }

  const claimed = await claimHandle(appUrl, session.token, handle, attempts)
  return {
    session: {
      ...session,
      handle: claimed ?? handle,
      usernameClaimed: claimed ? true : usernameClaimed,
    },
    claimFailed: claimed === null,
  }
}

/**
 * `hacklab login` — the standalone re-authenticate command. A lost handle claim
 * stays quiet here (the account still works; the next login retries it); the
 * guided `setup` flow is the one that has to complain.
 */
export async function login(): Promise<void> {
  const { session } = await performLogin()
  const { handle, email, appUrl, usernameClaimed } = session

  console.log('')
  console.log(handle ? `signed in as @${handle}` : `signed in as ${email}`)

  if (handle) {
    await identifyUser(handle, {
      $set: { email, handle, app_url: appUrl },
    })
    await captureEvent(handle, 'cli_login_completed', {
      login_method: 'device_flow',
      username_claimed: usernameClaimed ?? false,
    })
  }
}

async function loginViaDevice(appUrl: string): Promise<Credentials> {
  let startRes: Response
  try {
    startRes = await fetch(`${appUrl}/api/cli/device/start`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error(`could not reach ${appUrl} — is the server running?`)
  }
  if (startRes.status === 404) {
    throw new Error(`device login is not available on ${appUrl}`)
  }
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

  // Show the code and URL first. Poll starts immediately so clicking the
  // link (instead of Enter) still finishes login. Enter only opens a browser.
  const openUrl = start.verificationUriComplete ?? start.verificationUri
  console.log(dim('copy code'))
  console.log(bold(start.userCode))
  console.log('')
  console.log(link(start.verificationUri))

  const abort = new AbortController()
  if (!process.stdin.isTTY) void openBrowser(openUrl)
  const enter = waitForEnter('(press enter) ', abort.signal).then((pressed) => {
    if (pressed) void openBrowser(openUrl)
  })

  try {
    return await pollDevice(
      appUrl,
      start.deviceCode,
      start.expiresIn,
      start.interval
    )
  } finally {
    abort.abort()
    await enter
  }
}

async function pollDevice(
  appUrl: string,
  deviceCode: string,
  expiresIn: number,
  interval: number
): Promise<Credentials> {
  const intervalMs = Math.max(1000, (Number(interval) || 5) * 1000)
  const deadline = Date.now() + (Number(expiresIn) || 900) * 1000

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
        body: JSON.stringify({
          deviceCode,
          allowSignup: true,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status !== 429) data = await res.json().catch(() => null)
    } catch {
      // keep polling
    }

    const status = data?.status
    if (status === 'approved' && data?.token && data.email) {
      return {
        token: data.token,
        email: data.email,
        handle: data.handle ?? data.login,
        usernameClaimed: data.usernameClaimed,
        expiresAt: data.expiresAt,
      }
    }
    if (status === 'denied') {
      throw new Error('authorization was denied on GitHub.')
    }
    if (status === 'expired') {
      throw new Error('the code expired — run `hacklab login` again.')
    }
    if (status === 'no_account') {
      const who = typeof data?.login === 'string' ? ` (@${data.login})` : ''
      throw new Error(
        `no hacklab account is linked to that GitHub${who}. run \`hacklab login\` again.`
      )
    }

    await sleep(intervalMs)
  }

  throw new Error('login timed out — run `hacklab login` again.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchMe(
  appUrl: string,
  token: string
): Promise<{
  handle?: string
  githubUsername?: string | null
  claimed?: boolean
} | null> {
  try {
    const res = await fetch(`${appUrl}/api/hackers/me?src=cli`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return (await res.json()) as {
      handle?: string
      githubUsername?: string | null
      claimed?: boolean
    }
  } catch {
    return null
  }
}

/**
 * Claim `username` for this account, returning the claimed handle or null if
 * every attempt failed. `attempts > 1` retries — the claim is idempotent for the
 * owner, and a lost one leaves an account the web onboarding never sees finish.
 */
async function claimHandle(
  appUrl: string,
  token: string,
  username: string,
  attempts = 1
): Promise<string | null> {
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      const res = await fetch(`${appUrl}/api/cli/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username }),
      })
      if (res.ok) {
        const data = (await res.json()) as { handle?: string }
        return data.handle ?? username
      }
    } catch {
      // fall through to the next attempt
    }
  }
  return null
}
