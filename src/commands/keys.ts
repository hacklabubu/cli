import { resolveCommand } from '../resolve-command.js'
import { loadSession, type Session } from '../session.js'
import { fetchApi, LOGIN_EXPIRED_MESSAGE } from '../sync.js'
import { bold, dim, error, info, mint, success } from '../ui.js'

// `hacklab keys` — manage personal API keys that authenticate the agent-friendly
// profile endpoint (GET /api/v1/me). Subcommands resolve by shortest
// unambiguous prefix (`k c "name"` == create).

const SUBCOMMANDS = ['create', 'list', 'revoke'] as const

type ApiKeySummary = {
  id: string
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

function usage(): never {
  error('usage: hacklab keys <create|list|revoke> [args]')
  info(`  ${dim('hacklab keys create "my agent"')}   mint a new key`)
  info(`  ${dim('hacklab keys list')}                list your keys`)
  info(`  ${dim('hacklab keys revoke <id>')}         delete a key`)
  process.exit(1)
}

export async function keys(args: string[]): Promise<void> {
  const [subToken, ...rest] = args
  if (!subToken) usage()

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: keys ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: keys ${subToken}`)
    usage()
  }

  const session = await requireSession()

  if (resolved.name === 'create') return createKey(session, rest)
  if (resolved.name === 'list') return listKeys(session)
  if (resolved.name === 'revoke') return revokeKey(session, rest)
}

async function requireSession(): Promise<Session> {
  const session = await loadSession()
  if (!session) {
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }
  return session
}

async function createKey(session: Session, args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith('-'))

  let res: Response
  try {
    res = await fetchApi(session, '/api/keys', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: name ?? '' }),
    })
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (!res.ok) return handleError(res)

  const body = (await res.json().catch(() => null)) as {
    key?: ApiKeySummary & { key: string }
  } | null
  if (!body?.key?.key) {
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  success(`created key ${bold(body.key.name)}`)
  console.log(`\n  ${mint(body.key.key)}\n`)
  info(
    `${dim("copy it now — you won't see it again.")} use it as ${dim('Authorization: Bearer <key>')}.`
  )
}

async function listKeys(session: Session): Promise<void> {
  let res: Response
  try {
    res = await fetchApi(session, '/api/keys', {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (!res.ok) return handleError(res)

  const body = (await res.json().catch(() => null)) as {
    keys?: ApiKeySummary[]
  } | null
  const list = body?.keys ?? []

  if (list.length === 0) {
    info(`no API keys yet. create one with ${dim('hacklab keys create')}.`)
    return
  }

  for (const k of list) {
    const used = k.lastUsedAt
      ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
      : 'never used'
    console.log(
      `  ${mint(k.keyPrefix)}${dim('…')}  ${bold(k.name)}  ${dim(`${k.id.slice(0, 8)} · ${used}`)}`
    )
  }
  info(`\nrevoke with ${dim('hacklab keys revoke <id>')} (id shown above).`)
}

async function revokeKey(session: Session, args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('-'))
  if (!id) {
    error('usage: hacklab keys revoke <id>')
    info(`find ids with ${dim('hacklab keys list')}`)
    process.exit(1)
  }

  let res: Response
  try {
    res = await fetchApi(session, `/api/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (res.status === 404) {
    error(`no key with id "${id}"`)
    info(`run ${dim('hacklab keys list')} to see your keys`)
    process.exit(1)
  }
  if (!res.ok) return handleError(res)

  success('key revoked')
}

async function handleError(res: Response): Promise<never> {
  if (res.status === 401) {
    error(LOGIN_EXPIRED_MESSAGE)
    info(`run ${dim('hacklab login')} again`)
    process.exit(1)
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string }
  } | null
  error(body?.error?.message ?? `failed (${res.status})`)
  process.exit(1)
}
