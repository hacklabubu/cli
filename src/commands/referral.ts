import { emitJsonError, requireSession } from '../api-client.js'
import { captureEvent } from '../posthog.js'
import { referralMessage, referralUrl } from '../referral.js'
import { resolveAppUrl, type Session } from '../session.js'
import { bold, dim, error, hint, info, success } from '../ui.js'

// `hacklab referral` — surface the link a user sends to recruit their hacker
// friends, plus how many have joined through them. Retrievable any time.
// `--json` gives an agent
// the URL, a paste-ready message, and the stats.

type ReferralRecent = { handle: string; displayName: string | null }
type ReferralStats = { count: number; recent: ReferralRecent[] }

/**
 * Best-effort fetch of referral stats from the backend. Returns null on any
 * failure (offline, non-2xx, malformed) so the command can still show the link,
 * which is derivable locally and never needs the network.
 */
async function fetchReferralStats(
  session: Session,
  timeoutMs = 8000
): Promise<ReferralStats | null> {
  try {
    const res = await fetch(`${resolveAppUrl(session)}/api/cli/referral`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      referral?: { count?: unknown; recent?: unknown }
    }
    const count = data.referral?.count
    if (typeof count !== 'number') return null
    const recent = Array.isArray(data.referral?.recent)
      ? (data.referral.recent as ReferralRecent[])
      : []
    return { count, recent }
  } catch {
    return null
  }
}

/**
 * Print the caller's referral link and join stats. Requires a claimed handle —
 * a referral is keyed on the public handle, and an unclaimed session has none.
 */
export async function referral(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)

  const handle = session.handle
  if (!handle) {
    const message = 'claim a username first with `hacklab login`'
    if (json) emitJsonError('no_handle', message)
    error('no referral link yet — you have not claimed a username')
    hint('run `hacklab login` to finish setting up your profile')
    process.exit(1)
  }

  const base = resolveAppUrl(session)
  const url = referralUrl(handle, base)
  const message = referralMessage(handle, base)
  const stats = await fetchReferralStats(session)

  await captureEvent(handle, 'cli_referral_shown', {
    via: json ? 'json' : 'cli',
    count: stats?.count ?? null,
  })

  if (json) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        referral: {
          handle,
          url,
          message,
          // null (not 0) when the backend was unreachable, so an agent can tell
          // "no referrals yet" apart from "stats unavailable".
          count: stats?.count ?? null,
          recent: stats?.recent ?? [],
        },
      })
    )
    return
  }

  success('your referral link')
  console.log('')
  console.log(`  ${bold(url)}`)
  console.log('')

  if (stats) {
    if (stats.count > 0) {
      info(
        `${bold(String(stats.count))} hacker${stats.count === 1 ? '' : 's'} joined through you`
      )
      if (stats.recent.length > 0) {
        console.log(
          `  ${dim(stats.recent.map((r) => `@${r.handle}`).join(', '))}`
        )
      }
    } else {
      info(dim('no one has joined through you yet'))
    }
    console.log('')
  }

  info('send it to your smartest hacker friends — copy this:')
  console.log('')
  for (const line of message.split('\n')) {
    console.log(`  ${dim(line)}`)
  }
}
