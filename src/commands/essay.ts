import { readFile } from 'node:fs/promises'

import * as clack from '@clack/prompts'

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
// the agent already has (`--content`) or a file on disk (`--file`, or a bare
// path). `update` replaces the body at a stable URL. `view` reads one essay by
// id. `list` reads yours, a hacker's, or an org's. `delete` removes yours.

const SUBCOMMANDS = ['post', 'update', 'view', 'list', 'delete'] as const
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
  authorHandle?: string
  authorDisplayName?: string | null
}

type EssayListResponse = {
  kind: 'user' | 'org'
  author?: { handle: string; displayName: string | null }
  org?: { name: string; slug: string }
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
  | { kind: 'not-an-id'; token: string }
  | { kind: 'missing' }

/**
 * `view` takes an essay id only. Anything that can't be an id prefix is a
 * usage error pointing at `essay list <handle>` — a handle and a short hex id
 * are indistinguishable, so guessing between them silently reads the wrong
 * thing.
 */
export function parseViewTarget(token: string | undefined): EssayViewTarget {
  if (!token) return { kind: 'missing' }
  const raw = token.replace(/^@/, '')
  if (!raw) return { kind: 'missing' }
  if (ID_PREFIX_RE.test(raw.toLowerCase())) {
    return { kind: 'one', id: raw.toLowerCase() }
  }
  return { kind: 'not-an-id', token: raw }
}

/**
 * The `essay list` target grammar, decided by argument count so a user
 * literally named "org" still works as the bare one-arg form:
 *   (none)      → your essays
 *   <handle>    → that user's essays
 *   org <slug>  → that org's essays
 *   org/<slug>  → same, mirroring the web URL /org/<slug>
 */
export function parseListTarget(
  positionals: string[]
):
  | { kind: 'self' }
  | { kind: 'user'; handle: string }
  | { kind: 'org'; slug: string }
  | { kind: 'invalid' } {
  if (positionals.length === 0) return { kind: 'self' }
  if (positionals.length === 1) {
    const arg = positionals[0]!
    if (arg.startsWith('org/')) {
      const slug = arg.slice('org/'.length)
      return slug ? { kind: 'org', slug } : { kind: 'invalid' }
    }
    return { kind: 'user', handle: arg.replace(/^@/, '') }
  }
  if (positionals.length === 2 && positionals[0] === 'org') {
    return { kind: 'org', slug: positionals[1]! }
  }
  return { kind: 'invalid' }
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function printHelp() {
  console.log(`hacklab essay post --title <t> --content <md> [--json]`)
  console.log(dim('  or --file <path.md>, or a bare <path.md>'))
  console.log(`hacklab essay update <id> --content <md> [--json]`)
  console.log(dim('  same URL'))
  console.log('')
  console.log(`hacklab essay list [<handle> | org <slug>] [--page N] [--json]`)
  console.log(dim('  yours with no argument'))
  console.log(`hacklab essay view <id> [--json]`)
  console.log(dim('  one essay, full text'))
  console.log('')
  console.log(`hacklab essay delete <id> [--yes] [--json]`)
  console.log(dim('  yours only; --yes skips the confirm'))
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

// Flags that take a following value. Every arg-walker has to skip that value,
// or a legitimate `--content "- bullet"` reads as a flag of its own.
function unknownFlag(
  args: string[],
  allowed: Set<string>,
  valueFlags: Set<string>
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (!arg.startsWith('-')) continue
    const name = arg.split('=')[0]
    if (!name) continue
    if (!allowed.has(name)) return name
  }
  return undefined
}

/** Non-flag arguments, in order, skipping the values that belong to a flag. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
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
  return found
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

/**
 * The markdown body, from `--content`, `--file`, or the positional path the
 * pre-flag CLI took (`essay post note.md`). Exactly one source.
 */
async function resolveMarkdown(
  args: string[],
  json: boolean,
  file: string | undefined
): Promise<string> {
  const content = flagValue(args, '--content')
  const fileFlag = flagValue(args, '--file')
  const sources = [content, fileFlag, file].filter((v) => v !== undefined)
  if (sources.length > 1) {
    const message =
      content !== undefined && fileFlag !== undefined
        ? 'use either --content or --file, not both'
        : 'use one markdown source: --content, --file, or a <file.md> path'
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
  const path = fileFlag ?? file
  if (path) return readMarkdownFile(path, json)
  const message = 'an essay needs --content or --file'
  if (json) emitJsonError('missing_content', message)
  error(message)
  process.exit(1)
}

const BODY_FLAGS = new Set(['--title', '--content', '--file', '--json'])
const BODY_VALUE_FLAGS = new Set(['--title', '--content', '--file'])

async function essayPost(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, BODY_FLAGS, BODY_VALUE_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const rest = positionals(args, BODY_VALUE_FLAGS)
  if (rest.length > 1) {
    const message = 'usage: hacklab essay post --title <t> --content <md>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  if (!title) {
    const message = 'an essay needs a title: --title "Why I built this"'
    if (json) emitJsonError('missing_title', message)
    error(message)
    process.exit(1)
  }

  const markdown = await resolveMarkdown(args, json, rest[0])
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
  const unknown = unknownFlag(args, BODY_FLAGS, BODY_VALUE_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const rest = positionals(args, BODY_VALUE_FLAGS)
  const id = rest[0]
  if (!id || rest.length > 2) {
    const message = 'usage: hacklab essay update <id> --content <md>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  const markdown = await resolveMarkdown(args, json, rest[1])
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
  const unknown = unknownFlag(
    args,
    new Set(['--json', '--yes', '-y']),
    new Set()
  )
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const yes = args.includes('--yes') || args.includes('-y')
  const id = args.find((a) => !a.startsWith('-'))
  if (!id) {
    const message = 'usage: hacklab essay delete <id> [--yes]'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  const base = resolveAppUrl(session)

  // Deletion is irreversible and `essay d <id>` resolves here by prefix, so a
  // typo must not be enough on its own. The prompt names the essay, which
  // costs one read — skipped entirely on the --yes and agent paths.
  if (!yes) {
    if (json || !process.stdin.isTTY) {
      const message = 'refusing to delete without confirmation — pass --yes'
      if (json) emitJsonError('confirm', message)
      error(message)
      process.exit(1)
    }
    const preview = await fetch(
      `${base}${ESSAYS_BASE}/${encodeURIComponent(id)}`
    )
    if (!preview.ok) {
      error(await readError(preview, session))
      process.exit(1)
    }
    const { essay: found } = (await preview.json()) as { essay: EssayView }
    const ok = await clack.confirm({
      message: `delete ${bold(stripControl(found.title))}? this cannot be undone.`,
      initialValue: false,
    })
    if (clack.isCancel(ok) || !ok) {
      info('kept.')
      return
    }
  }

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

/** Meta line under a list entry: (by author ·) id · date · reading time (· synced). */
function metaLine(item: EssayListItem, withAuthor: boolean): string {
  const parts: string[] = []
  if (withAuthor && item.authorHandle) parts.push(`by ${item.authorHandle}`)
  parts.push(shortId(item.id))
  parts.push(formatEssayDate(item.publishedAt))
  if (item.readingTimeMinutes) parts.push(`${item.readingTimeMinutes} min`)
  if (item.source === 'sync') parts.push('synced')
  return dim(`  ${stripControl(parts.join(' · '))}`)
}

function renderList(
  data: EssayListResponse,
  subject: string,
  appUrl: string,
  self: boolean
) {
  const isOrg = data.kind === 'org'
  if (data.items.length === 0) {
    info(isOrg ? `no essays on ${subject}` : `no essays on @${subject}`)
    if (self) {
      info(
        `run ${dim('hacklab essay post --title "…" --content <md>')} to publish one`
      )
    }
    return
  }

  for (const item of data.items) {
    console.log(`  ${bold(stripControl(item.title))}`)
    console.log(metaLine(item, isOrg))
  }
  console.log('')
  if (data.page < data.totalPages) {
    const target = isOrg ? `org ${subject}` : subject
    console.log(
      dim(`  next → hacklab essay list ${target} --page ${data.page + 1}`)
    )
    console.log('')
  }
  info(link(`${appUrl}${isOrg ? `/org/${subject}` : `/${subject}`}`))
}

async function essayView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, new Set(['--json']), new Set())
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const rest = positionals(args, new Set())
  const target = parseViewTarget(rest.length === 1 ? rest[0] : undefined)
  if (target.kind === 'missing') {
    const message = 'usage: hacklab essay view <id>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }
  if (target.kind === 'not-an-id') {
    const message = `not an essay id: "${target.token}" — for a hacker's essays run: hacklab essay list ${target.token}`
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  // Viewing is public — a session only improves the base URL resolution.
  const session = await loadSession()
  const appUrl = resolveAppUrl(session)

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

  if (!res.ok) {
    if (res.status === 404) {
      const message = `no essay named "${target.id}"`
      if (json) emitJsonError('not_found', message)
      error(message)
      info(
        `if that's a handle, run ${dim(`hacklab essay list ${target.id}`)} instead`
      )
      process.exit(1)
    }
    const message = await readError(res)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const body = (await res.json()) as { essay: EssayView }
  const url = `${appUrl}${body.essay.path}`
  if (json) {
    printJson({ schemaVersion: 1, essay: { ...body.essay, url } })
    return
  }
  renderEssay(body.essay, url)
}

async function essayList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(
    args,
    new Set(['--json', '--page']),
    new Set(['--page'])
  )
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
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

  const target = parseListTarget(positionals(args, new Set(['--page'])))
  if (target.kind === 'invalid') {
    const message =
      'usage: hacklab essay list [<handle> | org <slug>] [--page N]'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  let session: Session | null
  let subject: string
  let query: { key: 'user' | 'org'; value: string }
  if (target.kind === 'self') {
    session = await requireSession(json)
    if (!session.handle) {
      const message = 'no username on this session'
      if (json) emitJsonError('unauthorized', message)
      error(message)
      info(`run ${dim('hacklab login')} (or pass a handle explicitly)`)
      process.exit(1)
    }
    subject = session.handle
    query = { key: 'user', value: session.handle }
  } else {
    session = await loadSession()
    subject = target.kind === 'user' ? target.handle : target.slug
    query = { key: target.kind === 'user' ? 'user' : 'org', value: subject }
  }

  const appUrl = resolveAppUrl(session)
  const url = new URL(`${appUrl}${ESSAYS_BASE}`)
  url.searchParams.set(query.key, query.value)
  if (page > 1) url.searchParams.set('page', String(page))

  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }
  if (!res.ok) {
    if (res.status === 404) {
      const message =
        query.key === 'org'
          ? `no org named "${subject}"`
          : `no hacker named "${subject}"`
      if (json) emitJsonError('not_found', message)
      error(message)
      process.exit(1)
    }
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const data = (await res.json()) as EssayListResponse
  if (json) {
    printJson({ schemaVersion: 1, ...data })
    return
  }
  renderList(
    data,
    data.kind === 'org'
      ? (data.org?.slug ?? subject)
      : (data.author?.handle ?? subject),
    appUrl,
    target.kind === 'self'
  )
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
  if (resolved.name === 'list') return essayList(subArgs)
  if (resolved.name === 'delete') return essayDelete(subArgs)
}
