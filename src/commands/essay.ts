import { readFile } from 'node:fs/promises'

import * as clack from '@clack/prompts'

import { captureEvent } from '../posthog.js'
import {
  loadSession,
  resolveAppUrl,
  type Session,
  unauthorizedHint,
} from '../session.js'
import { bold, dim, error, info, linkBlue, success } from '../ui.js'
import { openBrowser } from '../utils/openBrowser.js'

// `hacklab essay` — post and manage the essays on your profile. Thin wrappers
// over the /api/essays routes: the markdown file is read locally but all real
// validation (title, size, rendering, sanitization) happens on the backend.
// Every subcommand takes --json so agents can drive it programmatically.

const ESSAYS_BASE = '/api/essays'

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

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
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

// A 401 here is nearly always a per-backend token mismatch rather than a real
// auth failure, and the server's bare "Unauthorized" can't say so — only the
// client knows which backend the session was minted against. Swap in the hint
// that names the fix. Public reads pass no session and keep the server's text.
export async function readError(
  res: Response,
  session?: Session | null
): Promise<string> {
  if (res.status === 401 && session) return unauthorizedHint(session)
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error ?? `request failed (${res.status})`
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

/** Drop a flag and (when it isn't `--flag=value`) its value from args. */
function stripFlag(args: string[], withValue: boolean, ...names: string[]) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (names.includes(arg)) {
      if (withValue) i++
      continue
    }
    if (names.some((name) => arg.startsWith(`${name}=`))) continue
    out.push(arg)
  }
  return out
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

// Essays get absolute dates ("jul 12 2026"), not chat's relative prefixes —
// a list of long-lived posts reads like an archive, not a conversation.
export function formatEssayDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`
}

/** The short id shown in human output. Full ids stay in --json. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

async function readMarkdownFile(path: string): Promise<string> {
  if (!/\.(md|markdown)$/i.test(path)) {
    error(`expected a markdown file (.md), got: ${path}`)
    process.exit(1)
  }
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    error(
      code === 'ENOENT' ? `file not found: ${path}` : `could not read ${path}`
    )
    process.exit(1)
  }
}

/** Meta line under a list entry: id · date · reading time (· synced) (· by author). */
function metaLine(item: EssayListItem, withAuthor: boolean): string {
  const parts: string[] = []
  if (withAuthor && item.authorHandle) parts.push(`by ${item.authorHandle}`)
  parts.push(shortId(item.id))
  parts.push(formatEssayDate(item.publishedAt))
  if (item.readingTimeMinutes) parts.push(`${item.readingTimeMinutes} min`)
  if (item.source === 'sync') parts.push('synced')
  return dim(`  ${parts.join(' · ')}`)
}

// ── post / update ───────────────────────────────────────────────────────────

async function essayPost(args: string[], json: boolean) {
  const title = flagValue(args, '--title', '-t')
  const positionals = stripFlag(args, true, '--title', '-t').filter(
    (a) => !a.startsWith('-')
  )
  const file = positionals[0]
  if (!file || positionals.length > 1) {
    error('usage: hacklab essay post <file.md> [--title "..."]')
    process.exit(1)
  }

  const session = await requireSession()
  const markdown = await readMarkdownFile(file)

  const res = await fetch(`${resolveAppUrl(session)}${ESSAYS_BASE}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ markdown, ...(title ? { title } : {}) }),
  })
  if (!res.ok) {
    error(await readError(res, session))
    process.exit(1)
  }

  const data = (await res.json()) as {
    id: string
    title: string
    path: string
  }
  const url = `${resolveAppUrl(session)}${data.path}`

  if (json) {
    printJson({ ...data, url })
    return
  }
  success(`published ${bold(`"${data.title}"`)}`)
  info(`id  ${bold(shortId(data.id))}`)
  info(linkBlue(url))
  console.log(
    dim(
      `\n  update it later: hacklab essay update ${shortId(data.id)} <file.md>`
    )
  )

  const publishSession = await loadSession()
  await captureEvent(publishSession?.handle, 'cli_essay_published', {
    essay_id: data.id,
    has_custom_title: title !== undefined,
  })
}

async function essayUpdate(args: string[], json: boolean) {
  const title = flagValue(args, '--title', '-t')
  const positionals = stripFlag(args, true, '--title', '-t').filter(
    (a) => !a.startsWith('-')
  )
  const [id, file] = positionals
  if (!id || !file || positionals.length > 2) {
    error('usage: hacklab essay update <id> <file.md> [--title "..."]')
    process.exit(1)
  }

  const session = await requireSession()
  const markdown = await readMarkdownFile(file)

  const res = await fetch(
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
  if (!res.ok) {
    error(await readError(res, session))
    process.exit(1)
  }

  const data = (await res.json()) as {
    id: string
    title: string
    path: string
  }
  const url = `${resolveAppUrl(session)}${data.path}`

  if (json) {
    printJson({ ...data, url })
    return
  }
  success(`updated ${bold(`"${data.title}"`)}`)
  info(linkBlue(url))

  await captureEvent(session.handle, 'cli_essay_updated', {
    essay_id: data.id,
    has_custom_title: title !== undefined,
  })
}

// ── delete ──────────────────────────────────────────────────────────────────

async function essayDelete(args: string[], json: boolean) {
  const yes = args.includes('--yes') || args.includes('-y')
  const positionals = stripFlag(args, false, '--yes', '-y').filter(
    (a) => !a.startsWith('-')
  )
  const id = positionals[0]
  if (!id || positionals.length > 1) {
    error('usage: hacklab essay delete <id> [--yes]')
    process.exit(1)
  }

  const session = await requireSession()
  const base = resolveAppUrl(session)

  // Fetch first so the confirmation names the essay, not just an id.
  const viewRes = await fetch(`${base}${ESSAYS_BASE}/${encodeURIComponent(id)}`)
  if (!viewRes.ok) {
    error(await readError(viewRes))
    process.exit(1)
  }
  const { essay } = (await viewRes.json()) as { essay: EssayView }

  if (!yes) {
    if (!process.stdin.isTTY) {
      error('refusing to delete without confirmation — pass --yes')
      process.exit(1)
    }
    const confirmed = await clack.confirm({
      message: `delete "${essay.title}"? this cannot be undone.`,
      initialValue: false,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      info('kept.')
      return
    }
  }

  const res = await fetch(`${base}${ESSAYS_BASE}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) {
    error(await readError(res, session))
    process.exit(1)
  }

  const data = (await res.json()) as { id: string; title: string }
  if (json) {
    printJson(data)
    return
  }
  success(`deleted ${bold(`"${data.title}"`)}`)

  await captureEvent(session.handle, 'cli_essay_deleted', {
    essay_id: data.id,
  })
}

// ── view ────────────────────────────────────────────────────────────────────

async function essayView(args: string[], json: boolean) {
  const web = args.includes('--web') || args.includes('-w')
  const positionals = stripFlag(args, false, '--web', '-w').filter(
    (a) => !a.startsWith('-')
  )
  const id = positionals[0]
  if (!id || positionals.length > 1) {
    error('usage: hacklab essay view <id> [--web]')
    process.exit(1)
  }

  // Viewing is public — a session only improves the base URL resolution.
  const session = await loadSession()
  const base = resolveAppUrl(session)

  const res = await fetch(`${base}${ESSAYS_BASE}/${encodeURIComponent(id)}`)
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const { essay } = (await res.json()) as { essay: EssayView }
  const url = `${base}${essay.path}`

  if (json) {
    printJson({ essay: { ...essay, url } })
    return
  }
  if (web) {
    const opened = await openBrowser(url)
    if (opened) {
      info(`opened ${linkBlue(url)}`)
      return
    }
    info(`could not open a browser — ${linkBlue(url)}`)
    return
  }

  const byline = [
    essay.authorDisplayName ?? essay.authorHandle,
    formatEssayDate(essay.publishedAt),
    essay.readingTimeMinutes ? `${essay.readingTimeMinutes} min` : null,
  ].filter(Boolean)

  console.log('')
  console.log(`  ${bold(essay.title)}`)
  console.log(dim(`  ${byline.join(' · ')}`))
  console.log('')
  if (essay.contentText) {
    for (const line of essay.contentText.split('\n')) {
      console.log(`  ${line}`)
    }
    console.log('')
  }
  console.log(`  ${linkBlue(url)}`)
}

// ── list ────────────────────────────────────────────────────────────────────

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
    return { kind: 'user', handle: arg }
  }
  if (positionals.length === 2 && positionals[0] === 'org') {
    return { kind: 'org', slug: positionals[1]! }
  }
  return { kind: 'invalid' }
}

async function essayList(args: string[], json: boolean) {
  const rawPage = flagValue(args, '--page', '-p')
  const page = rawPage ? Number.parseInt(rawPage, 10) : 1
  if (!Number.isInteger(page) || page < 1) {
    error(`--page must be a positive integer, got: ${rawPage}`)
    process.exit(1)
  }

  const positionals = stripFlag(args, true, '--page', '-p').filter(
    (a) => !a.startsWith('-')
  )

  const target = parseListTarget(positionals)
  if (target.kind === 'invalid') {
    error('usage: hacklab essay list [<handle> | org <slug>] [--page N]')
    process.exit(1)
  }

  let query: { user: string } | { org: string }
  let subject: string
  if (target.kind === 'self') {
    const session = await requireSession()
    if (!session.handle) {
      error('no username on this session')
      info(`run ${dim('hacklab login')} (or pass a username explicitly)`)
      process.exit(1)
    }
    query = { user: session.handle }
    subject = session.handle
  } else if (target.kind === 'user') {
    query = { user: target.handle }
    subject = target.handle
  } else {
    query = { org: target.slug }
    subject = target.slug
  }

  const session = await loadSession()
  const url = new URL(`${resolveAppUrl(session)}${ESSAYS_BASE}`)
  if ('user' in query) url.searchParams.set('user', query.user)
  else url.searchParams.set('org', query.org)
  if (page > 1) url.searchParams.set('page', String(page))

  const res = await fetch(url)
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = (await res.json()) as EssayListResponse

  if (json) {
    printJson(data)
    return
  }

  const isOrg = data.kind === 'org'
  const heading = isOrg
    ? `essays from ${bold(data.org!.name)} (${data.total})`
    : `essays by ${bold(data.author!.handle)} (${data.total})`
  const pageSuffix =
    data.totalPages > 1 ? dim(` — page ${data.page}/${data.totalPages}`) : ''

  console.log('')
  console.log(`  ${heading}${pageSuffix}`)

  if (data.items.length === 0) {
    console.log('')
    info('no essays yet.')
    if (!isOrg && session?.handle === data.author?.handle) {
      info(`post one: ${dim('hacklab essay post <file.md>')}`)
    }
    return
  }

  for (const item of data.items) {
    console.log('')
    console.log(`  ${bold(item.title)}`)
    console.log(metaLine(item, isOrg))
  }

  if (data.page < data.totalPages) {
    const target = isOrg ? `org ${subject}` : subject
    console.log('')
    console.log(
      dim(`  next → hacklab essay list ${target} --page ${data.page + 1}`)
    )
  }
  console.log('')
}

// ── dispatch ────────────────────────────────────────────────────────────────

function printEssayHelp() {
  console.log(`
${bold('hacklab essay')} — essays on your profile

  ${bold('post')} <file.md> [--title "..."]     publish a markdown file as an essay
  ${bold('update')} <id> <file.md>              replace an essay's content (URL stays stable)
  ${bold('delete')} <id> [--yes]                delete your essay
  ${bold('view')} <id> [--web]                  read an essay (--web opens the browser)
  ${bold('list')} [<handle> | org <slug>]       your essays, a user's, or an org's
       [--page N]                     12 per page

  all subcommands take ${bold('--json')} for machine-readable output.
  ids are shown by post/list — any unique prefix works (e.g. 3f9c).
`)
}

export async function essay(args: string[]) {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')
  const sub = rest[0]
  const subArgs = rest.slice(1)

  switch (sub) {
    case 'post':
      return essayPost(subArgs, json)
    case 'update':
      return essayUpdate(subArgs, json)
    case 'delete':
      return essayDelete(subArgs, json)
    case 'view':
      return essayView(subArgs, json)
    case 'list':
      return essayList(subArgs, json)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printEssayHelp()
      return
    default:
      error(`unknown subcommand: ${sub}`)
      printEssayHelp()
      process.exit(1)
  }
}
