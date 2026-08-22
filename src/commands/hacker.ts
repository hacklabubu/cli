import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { type HackerCardData, renderCard } from '../card.js'
import type { Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { dim, error, info } from '../ui.js'

// `hacklab hacker <username>` — an auth-gated terminal card for humans and a
// rich agent profile in JSON. Viewing is the whole command; managing your own
// profile is `hacklab profile`'s job — this command is the window, that one is
// the mirror.

function usage(): never {
  error('usage: hacklab hacker <username>')
  info(`  hacklab hacker ${dim('<username> [--json]')}`)
  process.exit(1)
}

export async function hacker(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const handle = args.find((a) => !a.startsWith('-'))
  if (!handle) {
    if (json) return emitJsonError('invalid_fields', 'pass a username')
    usage()
  }

  const session = await requireSession(json)

  let res: Response
  try {
    const format = json ? '&format=agent' : ''
    res = await fetchApi(
      session,
      `/api/hackers/${encodeURIComponent(handle)}?src=cli${format}`,
      { headers: { Authorization: `Bearer ${session.token}` } }
    )
  } catch (err) {
    // fetchApi rethrows a friendly "couldn't reach hacklab" message.
    const message = err instanceof Error ? err.message : String(err)
    if (json) return emitJsonError('network', message)
    error(message)
    process.exit(1)
  }

  if (!res.ok) return handleError(res, handle, json, session)

  const body = (await res.json().catch(() => null)) as {
    hacker: HackerCardData
  } | null
  if (!body?.hacker) {
    if (json) return emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  if (json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }

  console.log(
    renderCard(body.hacker, { columns: process.stdout.columns }).join('\n')
  )
  if (session.handle && session.handle.toLowerCase() === handle.toLowerCase()) {
    info(dim(`this is you — edit with hacklab profile`))
  }
}

/** Non-200 handling. In --json mode, relay the server's error envelope verbatim. */
async function handleError(
  res: Response,
  handle: string,
  json: boolean,
  session: Session
): Promise<void> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string }
  } | null

  if (json) {
    // The server already returns {schemaVersion, error:{code,message}}; relay it.
    console.log(
      JSON.stringify(
        body ?? {
          schemaVersion: 1,
          error: { code: 'error', message: `failed (${res.status})` },
        },
        null,
        2
      )
    )
    process.exit(1)
  }

  if (res.status === 404) {
    error(`no hacker named "${handle}"`)
    const near = await nearestHandle(session, handle)
    if (near) info(`did you mean ${dim(`hacklab hacker ${near}`)}?`)
    process.exit(1)
  }
  error(apiErrorMessage(res.status, body, session))
  process.exit(1)
}

/** Best-effort near-match from the public search endpoint. Never throws. */
async function nearestHandle(
  session: Session,
  handle: string
): Promise<string | null> {
  try {
    const res = await fetchApi(
      session,
      `/api/hackers/search?q=${encodeURIComponent(handle)}`
    )
    if (!res.ok) return null
    const data = (await res.json()) as { hackers?: { handle: string }[] }
    const first = data.hackers?.[0]?.handle
    return first && first !== handle ? first : null
  } catch {
    return null
  }
}
