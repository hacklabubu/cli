import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { type HackerCardData, renderCard } from '../card.js'
import { resolveCommand } from '../resolve-command.js'
import type { Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info } from '../ui.js'

// `hacklab hacker view [handle]` — an auth-gated terminal card for humans and
// a rich agent profile in JSON. `list --newest` provides bounded discovery.
// With no handle it views your own profile (the authenticated user);
// managing that profile is `hacklab profile`'s job — this command is the
// window, that one is the mirror. Noun-verb so an identifier never sits in a
// verb slot (a handle can be any word). Subcommands resolve by shortest
// unambiguous prefix, so `hacklab h v isomiki` works via resolveCommand.

const SUBCOMMANDS = ['view', 'list'] as const

function usage(): never {
  error('usage: hacklab hacker [view|list]')
  info(`  hacklab hacker ${dim('view [handle] [--json]')}`)
  info(`  hacklab hacker ${dim('list --newest [--limit 20] [--json]')}`)
  process.exit(1)
}

export async function hacker(args: string[]): Promise<void> {
  const [subToken, ...rest] = args
  if (!subToken) usage()

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: hacker ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: hacker ${subToken}`)
    usage()
  }

  if (resolved.name === 'view') return hackerView(rest)
  if (resolved.name === 'list') return hackerList(rest)
}

type NewestHacker = {
  handle: string
  displayName: string | null
  bio: string | null
  claimedAt: string | null
  openToWork: boolean
  path: string
  url: string
}

async function hackerList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  if (!args.includes('--newest')) {
    if (json) return emitJsonError('invalid_fields', 'pass --newest')
    error('pass --newest')
    usage()
  }

  const limitIndex = args.indexOf('--limit')
  const rawLimit = limitIndex === -1 ? undefined : args[limitIndex + 1]
  const limit = rawLimit === undefined ? 20 : Number(rawLimit)
  if (
    (limitIndex !== -1 && rawLimit === undefined) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    if (json) return emitJsonError('invalid_fields', '--limit must be 1-50')
    error('--limit must be 1-50')
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await fetchApi(
      session,
      `/api/hackers/newest?src=cli&limit=${limit}`,
      { headers: { Authorization: `Bearer ${session.token}` } }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) return emitJsonError('network', message)
    error(message)
    process.exit(1)
  }

  if (!res.ok) return handleError(res, 'newest hackers', json, session)
  const body = (await res.json().catch(() => null)) as {
    schemaVersion: number
    hackers: NewestHacker[]
  } | null
  if (!body?.hackers) {
    if (json) return emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  if (json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  if (!body.hackers.length) {
    info('no new hackers yet')
    return
  }
  for (const hacker of body.hackers) {
    const name = hacker.displayName ? `  ${hacker.displayName}` : ''
    console.log(`  ${bold(hacker.handle)}${dim(name)}`)
    if (hacker.bio) console.log(`    ${dim(hacker.bio)}`)
  }
}

async function hackerView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const explicitHandle = args.find((a) => !a.startsWith('-'))

  const session = await requireSession(json)

  // No handle → view your own profile. Needs a claimed username; an
  // authenticated-but-unclaimed session has no handle to resolve.
  const handle = explicitHandle ?? session.handle
  if (!handle) {
    if (json) {
      return emitJsonError(
        'no_handle',
        'you have not claimed a username yet — run `hacklab join` first'
      )
    }
    error("you haven't claimed a username yet")
    info(`run ${dim('hacklab join')} to claim one, or pass a handle`)
    process.exit(1)
  }

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
    if (near) info(`did you mean ${dim(`hacklab hacker view ${near}`)}?`)
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
