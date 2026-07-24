import { emitJsonError, requireSession } from '../api-client.js'
import { captureEvent } from '../posthog.js'
import { referralMessage, referralUrl } from '../referral.js'
import { resolveAppUrl } from '../session.js'
import { bold, dim, error, hint, info, success } from '../ui.js'

// `hacklab referral` — surface the link a user sends to recruit their hacker
// friends. Same link the join ritual shows at the end of onboarding, retrievable
// any time. `--json` gives an agent the URL and a paste-ready message, so the
// "prompt you paste into your AI assistant" can hand over a real invite link.

/**
 * Print the caller's referral link. Requires a claimed handle — a referral is
 * keyed on the public handle, and an unclaimed session has none yet.
 */
export async function referral(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)

  const handle = session.handle
  if (!handle) {
    const message = 'claim a username first with `hacklab join`'
    if (json) emitJsonError('no_handle', message)
    error('no referral link yet — you have not claimed a username')
    hint('run `hacklab join` to finish setting up your profile')
    process.exit(1)
  }

  const base = resolveAppUrl(session)
  const url = referralUrl(handle, base)
  const message = referralMessage(handle, base)

  await captureEvent(handle, 'cli_referral_shown', {
    via: json ? 'json' : 'cli',
  })

  if (json) {
    console.log(
      JSON.stringify({ schemaVersion: 1, referral: { handle, url, message } })
    )
    return
  }

  success('your referral link')
  console.log('')
  console.log(`  ${bold(url)}`)
  console.log('')
  info('send it to your smartest hacker friends — copy this:')
  console.log('')
  for (const line of message.split('\n')) {
    console.log(`  ${dim(line)}`)
  }
}
