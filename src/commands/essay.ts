import { readFile } from 'node:fs/promises'

import { emitJsonError, requireSession } from '../api-client.js'
import { captureEvent } from '../posthog.js'
import { resolveCommand } from '../resolve-command.js'
import {
  loadSession,
  resolveAppUrl,
  type Session,
  unauthorizedHint,
} from '../session.js'
import { bold, dim, error, info, link, stripControl, success } from '../ui.js'

// `hacklab essay` — agent help on the bare command. `post` publishes markdown
// the agent already has (`--content`) or a file on disk (`--file`). `update`
// replaces the body at a stable URL. `view` reads one essay or a handle's
// list. `delete` removes yours.

const SUBCOMMANDS = ['post', 'update', 'view', 'delete'] as const
const ESSAYS_BASE = '/api/essays'

// Same rule as the server: 4..36 chars of a lowercased uuid / prefix.
const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{3,35}$/

type EssayListItem = {
  id: string
  title: string
  excerpt: string | null
  readingTimeMinutes: number | null
  source: string
  publishedAt: string
  path: string
}

type EssayListResponse = {
  kind: 'user'
  author?: { handle: string; displayName: string | null }
  items: EssayListItem[]
  total: number
  page: number
  totalPages: number
}

type EssayView = {
  id: string
  title: string
  contentText: string | null
  readingTimeMinutes: number | null
  source: string
  publishedAt: string
  authorHandle: string
  authorDisplayName: string | null
  path: string
}

export type EssayViewTarget =
  | { kind: 'one'; id: string }
  | { kind: 'list'; handle: string }
  | { kind: 'missing' }

export function parseViewTarget(token: string | undefined): EssayViewTarget {
  if (!token) return { kind: 'missing' }
  const raw = token.replace(/^@/, '')
  if (!raw) return { kind: 'missing' }
  if (ID_PREFIX_RE.test(raw.toLowerCase())) {
    return { kind: 'one', id: raw.toLowerCase() }
  }
  return { kind: 'list', handle: raw }
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function printHelp() {
  console.log(`hacklab essay post --title <t> --content <md> [--json]`)
  console.log(dim('  or --file <path.md>'))
  console.log(`hacklab essay update <id> --content <md> [--json]`)
  console.log(dim('  same URL'))
  console.log(`hacklab essay view <id> [--json]`)
  console.log(dim('  one essay'))
  console.log(`hacklab essay view <handle> [--json]`)
  console.log(dim('  their list'))
  console.log(`hacklab essay delete <id> [--json]`)
  console.log(dim('  yours only'))
}

function usage(exitCode = 1): never {
  printHelp()
  process.exit(exitCode)
}

function flagValue(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = args.indexOf(name)
    if (i !== -1 && args[i + 1]) return args[i + 1]
    const eq = args.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1)
  }
  return undefined
}

function unknownFlag(args: string[], allowed: Set<string>): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue
    const name = arg.split('=')[0]
    if (!name) continue
    if (!allowed.has(name)) return name
  }
  return undefined
}

function positional(
  args: string[],
  valueFlags: Set<string>
): string | undefined {
  const found: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg || arg === '--json') continue
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if ([...valueFlags].some((name) => arg.startsWith(`${name}=`))) continue
    if (arg.startsWith('-')) continue
    found.push(arg)
  }
  return found.length === 1 ? found[0] : undefined
}

export async function readError(
  res: Response,
  session?: Session | null
): Promise<string> {
  if (res.status === 401 && session) return unauthorizedHint(session)
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error ?? `request failed (${res.status})`
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

export function formatEssayDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

async function readMarkdownFile(path: string, json: boolean): Promise<string> {
  if (!/\.(md|markdown)$/i.test(path)) {
    const message = `expected a markdown file (.md), got: ${path}`
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message =
      code === 'ENOENT' ? `file not found: ${path}` : `could not read ${path}`
    if (json) emitJsonError('read_failed', message)
    error(message)
    process.exit(1)
  }
}

async function resolveMarkdown(args: string[], json: boolean): Promise<string> {
  const content = flagValue(args, '--content')
  const file = flagValue(args, '--file')
  if (content !== undefined && file !== undefined) {
    const message = 'use either --content or --file, not both'
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }
  if (content !== undefined) {
    if (!content.trim()) {
      const message = 'an essay needs --content or --file'
      if (json) emitJsonError('missing_content', message)
      error(message)
      process.exit(1)
    }
    return content
  }
  if (file) return readMarkdownFile(file, json)
  const message = 'an essay needs --content or --file'
  if (json) emitJsonError('missing_content', message)
  error(message)
  process.exit(1)
}

const BODY_FLAGS = new Set(['--title', '--content', '--file', '--json'])

async function essayPost(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, BODY_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  if (!title) {
    const message = 'an essay needs a title: --title "Why I built this"'
    if (json) emitJsonError('missing_title', message)
    error(message)
    process.exit(1)
  }

  const markdown = await resolveMarkdown(args, json)
  const session = await requireSession(json)

  let res: Response
  try {
    res = await fetch(`${resolveAppUrl(session)}${ESSAYS_BASE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ markdown, title }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }
  if (!res.ok) {
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const data = (await res.json()) as {
    id: string
    title: string
    path: string
  }
  const url = `${resolveAppUrl(session)}${data.path}`

  await captureEvent(session.handle, 'cli_essay_published', {
    essay_id: data.id,
    has_custom_title: true,
  })

  if (json) {
    printJson({ schemaVersion: 1, ...data, url })
    return
  }
  success(`published ${bold(stripControl(data.title))}`)
  info(`${dim('id')}  ${bold(shortId(data.id))}`)
  info(link(url))
}

async function essayUpdate(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, BODY_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const id = positional(args, new Set(['--title', '--content', '--file']))
  if (!id) {
    const message = 'usage: hacklab essay update <id> --content <md>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  const markdown = await resolveMarkdown(args, json)
  const session = await requireSession(json)

  let res: Response
  try {
    res = await fetch(
      `${resolveAppUrl(session)}${ESSAYS_BASE}/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ markdown, ...(title ? { title } : {}) }),
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }
  if (!res.ok) {
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const data = (await res.json()) as {
    id: string
    title: string
    path: string
  }
  const url = `${resolveAppUrl(session)}${data.path}`

  await captureEvent(session.handle, 'cli_essay_updated', {
    essay_id: data.id,
    has_custom_title: title !== undefined,
  })

  if (json) {
    printJson({ schemaVersion: 1, ...data, url })
    return
  }
  success(`updated ${bold(stripControl(data.title))}`)
  info(link(url))
}

async function essayDelete(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, new Set(['--json']))
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const id = args.find((a) => !a.startsWith('-'))
  if (!id) {
    const message = 'usage: hacklab essay delete <id>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  const base = resolveAppUrl(session)

  let res: Response
  try {
    res = await fetch(`${base}${ESSAYS_BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }
  if (!res.ok) {
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const data = (await res.json()) as { id: string; title: string }
  await captureEvent(session.handle, 'cli_essay_deleted', {
    essay_id: data.id,
  })

  if (json) {
    printJson({ schemaVersion: 1, deleted: true, id: data.id })
    return
  }
  success(`deleted ${bold(stripControl(data.title))}`)
}

function renderEssay(essay: EssayView, url: string) {
  const byline = [
    essay.authorDisplayName ?? essay.authorHandle,
    formatEssayDate(essay.publishedAt),
    essay.readingTimeMinutes ? `${essay.readingTimeMinutes} min` : null,
  ].filter(Boolean)

  console.log(`  ${bold(stripControl(essay.title))}`)
  console.log(dim(`  ${byline.join(' · ')}`))
  if (essay.contentText) {
    console.log('')
    console.log(stripControl(essay.contentText).trimEnd())
  }
  console.log('')
  info(link(url))
}

function renderList(handle: string, items: EssayListItem[], appUrl: string) {
  if (items.length === 0) {
    info(`no essays on @${handle}`)
    return
  }
  for (const item of items) {
    console.log(`  ${bold(stripControl(item.title))}`)
    console.log(
      dim(
        `  ${shortId(item.id)} · ${formatEssayDate(item.publishedAt)}${
          item.readingTimeMinutes ? ` · ${item.readingTimeMinutes} min` : ''
        }`
      )
    )
  }
  console.log('')
  info(link(`${appUrl}/${handle}`))
}

async function fetchList(
  handle: string,
  page: number,
  appUrl: string
): Promise<Response> {
  const url = new URL(`${appUrl}${ESSAYS_BASE}`)
  url.searchParams.set('user', handle)
  if (page > 1) url.searchParams.set('page', String(page))
  return fetch(url)
}

async function essayView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, new Set(['--json', '--page']))
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const token = positional(args, new Set(['--page']))
  const target = parseViewTarget(token)
  if (target.kind === 'missing') {
    const message = 'usage: hacklab essay view <id> or <handle>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const rawPage = flagValue(args, '--page')
  const page = rawPage ? Number.parseInt(rawPage, 10) : 1
  if (rawPage !== undefined && (!Number.isInteger(page) || page < 1)) {
    const message = `--page must be a positive integer, got: ${rawPage}`
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }

  const session = await loadSession()
  const appUrl = resolveAppUrl(session)

  if (target.kind === 'one') {
    let res: Response
    try {
      res = await fetch(
        `${appUrl}${ESSAYS_BASE}/${encodeURIComponent(target.id)}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (json) emitJsonError('network', message)
      error(message)
      process.exit(1)
    }

    if (res.ok) {
      const body = (await res.json()) as { essay: EssayView }
      const url = `${appUrl}${body.essay.path}`
      if (json) {
        printJson({ schemaVersion: 1, essay: { ...body.essay, url } })
        return
      }
      renderEssay(body.essay, url)
      return
    }

    if (res.status !== 404) {
      const message = await readError(res)
      if (json) emitJsonError('error', message)
      error(message)
      process.exit(1)
    }
  }

  const handle = target.kind === 'list' ? target.handle : target.id
  let listed: Response
  try {
    listed = await fetchList(handle, page, appUrl)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }

  if (!listed.ok) {
    const fallback =
      target.kind === 'one'
        ? `no essay named "${target.id}"`
        : `no hacker named "${handle}"`
    const message = listed.status === 404 ? fallback : await readError(listed)
    if (json) emitJsonError('not_found', message)
    error(message)
    process.exit(1)
  }

  const data = (await listed.json()) as EssayListResponse
  if (json) {
    printJson({ schemaVersion: 1, ...data })
    return
  }
  renderList(data.author?.handle ?? handle, data.items, appUrl)
}

export async function essay(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')
  const [subToken, ...subArgs] = rest
  if (json) subArgs.push('--json')

  if (
    !subToken ||
    subToken === '--help' ||
    subToken === '-h' ||
    subToken === 'help'
  ) {
    usage(0)
  }
  if (subToken.startsWith('-')) usage()

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: essay ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: essay ${subToken}`)
    usage()
  }

  if (resolved.name === 'post') return essayPost(subArgs)
  if (resolved.name === 'update') return essayUpdate(subArgs)
  if (resolved.name === 'view') return essayView(subArgs)
  if (resolved.name === 'delete') return essayDelete(subArgs)
}
