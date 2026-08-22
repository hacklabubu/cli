import { clearSyncPaused } from '../daily-sync.js'
import { captureEvent, identifyUser } from '../posthog.js'
import { getAppUrl, saveSession } from '../session.js'
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

/**
 * Authenticate via GitHub's device flow. Unknown GitHub identities get an
 * account. An unclaimed GitHub-derived handle is claimed as-is.
 */
export async function login(): Promise<void> {
  const appUrl = getAppUrl()
  const creds = await loginViaDevice(appUrl)

  let handle = creds.handle
  let usernameClaimed = creds.usernameClaimed
  if (!handle) {
    const me = await fetchMe(appUrl, creds.token)
    handle = me?.handle ?? me?.githubUsername ?? undefined
    if (me?.claimed != null) usernameClaimed = me.claimed
  }
  if (handle && !usernameClaimed) {
    const claimed = await claimHandle(appUrl, creds.token, handle)
    if (claimed) {
      handle = claimed
      usernameClaimed = true
    }
  }

  await saveSession({
    token: creds.token,
    email: creds.email,
    handle,
    usernameClaimed,
    appUrl,
    savedAt: new Date().toISOString(),
    expiresAt: creds.expiresAt,
  })
  await clearSyncPaused()

  console.log('')
  console.log(
    handle ? `signed in as @${handle}` : `signed in as ${creds.email}`
  )

  if (handle) {
    await identifyUser(handle, {
      $set: { email: creds.email, handle, app_url: appUrl },
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

  // Code first, then Enter, then the browser — they have to have read the
  // code before a new window steals focus. The URL is printed in full so it
  // is copyable if Enter doesn't open a browser; OSC-8 makes it clickable.
  console.log(dim('copy code'))
  console.log('')
  console.log(bold(start.userCode))
  console.log('')
  console.log(link(start.verificationUri))
  await waitForEnter('(press enter) ')
  void openBrowser(start.verificationUriComplete ?? start.verificationUri)

  const intervalMs = Math.max(1000, (Number(start.interval) || 5) * 1000)
  const deadline = Date.now() + (Number(start.expiresIn) || 900) * 1000

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
          deviceCode: start.deviceCode,
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

async function claimHandle(
  appUrl: string,
  token: string,
  username: string
): Promise<string | null> {
  try {
    const res = await fetch(`${appUrl}/api/cli/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ username }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { handle?: string }
    return data.handle ?? username
  } catch {
    return null
  }
}
