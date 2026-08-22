import { emitJsonError, requireSession } from '../api-client.js'
import { agentProfilePath } from '../dossier.js'
import { resolveAppUrl } from '../session.js'
import { dim, error, link, stripControl } from '../ui.js'

type DropItem = { text: string; createdAt: string }

/**
 * `hacklab drops` — the feed. Prints every drop on the caller's profile, then
 * the tab URL. `--json` is the list. Looking up someone else is not this
 * command (`hacklab hacker <user>` already includes recent drops).
 */
export async function drops(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)

  const handle = session.handle
  if (!handle) {
    const message = 'claim a username first with `hacklab login`'
    if (json) emitJsonError('no_handle', message)
    error('no drops yet — you have not claimed a username')
    process.exit(1)
  }

  const feedUrl = `${resolveAppUrl(session).replace(/\/$/, '')}/${handle}?tab=drops`

  let res: Response
  try {
    res = await fetch(`${resolveAppUrl(session)}${agentProfilePath(handle)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', `couldn't reach hacklab: ${message}`)
    error(`couldn't reach hacklab: ${message}`)
    process.exit(1)
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    if (json)
      emitJsonError('request_failed', data?.error ?? `failed (${res.status})`)
    error(data?.error ?? `failed (${res.status})`)
    process.exit(1)
  }

  const body = (await res.json().catch(() => null)) as {
    hacker?: {
      recent?: { drops?: { text?: unknown; createdAt?: unknown }[] }
    }
  } | null
  const items: DropItem[] = []
  for (const raw of body?.hacker?.recent?.drops ?? []) {
    if (typeof raw?.text === 'string' && typeof raw.createdAt === 'string') {
      items.push({ text: raw.text, createdAt: raw.createdAt })
    }
  }

  if (json) {
    console.log(
      JSON.stringify({ schemaVersion: 1, drops: items, url: feedUrl }, null, 2)
    )
    return
  }

  if (items.length === 0) {
    console.log('nothing yet')
    return
  }

  for (const item of items) {
    console.log(
      `${dim(item.createdAt.slice(0, 10))}  ${stripControl(item.text)}`
    )
  }
  console.log('')
  console.log(link(feedUrl))
}
