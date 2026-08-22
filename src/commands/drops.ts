import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { agentProfilePath } from '../dossier.js'
import { resolveAppUrl } from '../session.js'
import { dim, error, link, stripControl } from '../ui.js'

type DropItem = { text: string; createdAt: string }

/**
 * `hacklab drops` — the feed. The profile endpoint returns a recency-capped
 * preview, so this prints the latest drops plus the real total and the tab URL
 * that has the rest. `--json` is that list with its `total`, which is omitted
 * when the server sends no count. Looking up someone else is not this command
 * (`hacklab hacker <user>` already includes recent drops).
 */
export async function drops(args: string[]): Promise<void> {
  const json = args.includes('--json')
  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '--json') {
      if (json) emitJsonError('unknown_flag', `unknown flag: ${arg}`)
      console.error(`unknown flag: ${arg}`)
      process.exit(1)
    }
  }

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
    const failure = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    const message = apiErrorMessage(res.status, failure, session)
    if (json) emitJsonError(failure?.error?.code ?? 'request_failed', message)
    error(message)
    process.exit(1)
  }

  const body = (await res.json().catch(() => null)) as {
    hacker?: {
      stats?: { drops?: unknown }
      counts?: { drops?: unknown }
      recent?: { drops?: { text?: unknown; createdAt?: unknown }[] }
    }
  } | null
  const items: DropItem[] = []
  for (const raw of body?.hacker?.recent?.drops ?? []) {
    if (typeof raw?.text === 'string' && typeof raw.createdAt === 'string') {
      items.push({ text: raw.text, createdAt: raw.createdAt })
    }
  }
  // `counts` is where pre-v2 backends carry it. With neither, the total is
  // unknown — the preview length is not it, so say nothing rather than pass a
  // capped number off as the feed size.
  const counted = body?.hacker?.stats?.drops ?? body?.hacker?.counts?.drops
  const total =
    typeof counted === 'number' ? Math.max(counted, items.length) : undefined

  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          drops: items,
          ...(total !== undefined ? { total } : {}),
          url: feedUrl,
        },
        null,
        2
      )
    )
    return
  }

  if (items.length === 0) {
    console.log('nothing yet')
    console.log('')
    console.log(link(feedUrl))
    return
  }

  if (total !== undefined) console.log(`${dim('drops')} ${total}`)
  for (const item of items) {
    console.log(
      `${dim(item.createdAt.slice(0, 10))}  ${stripControl(item.text)}`
    )
  }
  console.log('')
  if (total === undefined) {
    console.log(`${dim('full list at')} ${link(feedUrl)}`)
  } else if (items.length < total) {
    console.log(
      `${dim(`showing latest ${items.length} of ${total} — full list at`)} ${link(feedUrl)}`
    )
  } else {
    console.log(link(feedUrl))
  }
}
