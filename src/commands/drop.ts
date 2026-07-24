import { emitJsonError } from '../api-client.js'
import { captureEvent } from '../posthog.js'
import { loadSession, resolveAppUrl } from '../session.js'
import { dim, error, info, success } from '../ui.js'

/**
 * Parse `drop` args: free words become the message, `-u/--url <url>` attaches a
 * link. Each command owns its own
 * parsing. Exits with a usage error on an unknown flag or an empty message.
 */
export function parseDropArgs(args: string[]): {
  text: string
  url?: string
  json: boolean
} {
  let url: string | undefined
  let json = false
  const words: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if ((arg === '-u' || arg === '--url') && args[i + 1]) {
      url = args[i + 1]
      i++
    } else if (arg === '--json') {
      json = true
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`)
      process.exit(1)
    } else {
      words.push(arg)
    }
  }

  const text = words.join(' ')

  if (!text) {
    console.error('usage: hacklab drop your message here')
    process.exit(1)
  }

  return { text, url, json }
}

export async function drop(content: string, url?: string, json = false) {
  const session = await loadSession()

  if (!session) {
    if (json) emitJsonError('unauthorized', 'not logged in')
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }

  if (content.length > 1000) {
    if (json)
      emitJsonError('invalid_fields', `too long — ${content.length}/1000 chars`)
    error(`too long — ${content.length}/1000 chars`)
    process.exit(1)
  }

  let res: Response
  try {
    res = await fetch(`${resolveAppUrl(session)}/api/drops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ content, url }),
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

  const result = (await res.json().catch(() => null)) as {
    id?: string
    path?: string
    url?: string
  } | null
  if (!result?.id) {
    if (json)
      emitJsonError('bad_response', 'got a malformed response from hacklab')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  // Only `id` is load-bearing. Older servers respond without path/url —
  // during a CLI-publish/deploy skew the drop still succeeded, so degrade
  // gracefully instead of reporting a false failure (agents would retry and
  // post duplicates).
  const dropPath =
    result.path ?? `/${session.handle}?tab=drops#drop-${result.id}`
  const dropUrl =
    result.url ?? `${resolveAppUrl(session).replace(/\/$/, '')}${dropPath}`

  if (json) {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, id: result.id, path: dropPath, url: dropUrl },
        null,
        2
      )
    )
  } else {
    success('dropped.')
    info(dropUrl)
  }

  await captureEvent(session.handle, 'cli_drop_posted', {
    content_length: content.length,
    has_url: url !== undefined,
  })
}
