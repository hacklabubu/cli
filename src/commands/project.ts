import * as clack from '@clack/prompts'

import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { captureEvent } from '../posthog.js'
import {
  isGithubRepoUrl,
  normalizeRepoUrl,
  probeRepoPrivate,
  slugFromName,
} from '../project-fields.js'
import { resolveCommand } from '../resolve-command.js'
import { resolveAppUrl, type Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info, link, stripControl, success } from '../ui.js'

// `hacklab project` — agent help on the bare command; `add` publishes a
// project from flags the agent already has (no cwd, no git, no files).
// `list`/`view`/`edit`/`delete` work on your own projects. Re-running `add`
// with the same title refreshes the same slug.

const SUBCOMMANDS = ['add', 'list', 'view', 'edit', 'delete'] as const

const PROJECTS_PATH = '/api/projects'

type RemoteProject = {
  slug: string
  title: string
  description: string | null
  content: string | null
  tags: string[]
  repoUrl: string | null
  liveUrl: string | null
  private?: boolean
  source?: string
  screenshots?: { url: string; caption: string }[]
  sourceYaml?: string | null
  publishedAt: string | null
  path: string
}

type OwnList = { handle: string; projects: RemoteProject[] }

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function printHelp() {
  console.log(
    `hacklab project add --title <t> [--repo <url>] [--url <url>] [--desc <d>] [--json]`
  )
  console.log(dim('  publish one; same title again updates'))
  console.log(dim('  --repo is the source, --url the live site; one is enough'))
  console.log(dim('  --private/--public override the repo visibility probe'))
  console.log('')
  console.log(`hacklab project list [--json]`)
  console.log(dim('  your projects'))
  console.log(`hacklab project view <slug> [--json]`)
  console.log(dim('  one of yours, full page'))
  console.log('')
  console.log(
    `hacklab project edit <slug> [--title <t>] [--desc <d>] [--repo <url>] [--url <url>] [--yes] [--json]`
  )
  console.log(dim('  change fields, keep the slug; --private/--public too'))
  console.log(dim('  --yes to edit a github-synced project (ends the sync)'))
  console.log(`hacklab project delete <slug> [--yes] [--json]`)
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
// or a legitimate `--title "-30 days"` reads as a flag of its own.
const VALUE_FLAGS = new Set([
  '--title',
  '--repo',
  '--url',
  '--desc',
  '--description',
])

const ADD_FLAGS = new Set([...VALUE_FLAGS, '--private', '--public', '--json'])

const EDIT_FLAGS = new Set([...ADD_FLAGS, '--yes', '-y'])

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

/** The single non-flag argument, skipping the values that belong to a flag. */
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

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return value.trim()
  } catch {
    return null
  }
}

async function readError(res: Response, session: Session): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string } | string
  } | null
  const message =
    typeof body?.error === 'string' ? body.error : body?.error?.message
  return apiErrorMessage(res.status, { error: { message } }, session)
}

function summarize(value: string | null, max = 72): string {
  if (!value) return ''
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

async function fetchOwnProjects(session: Session): Promise<OwnList> {
  const res = await fetchApi(session, PROJECTS_PATH, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) throw new Error(await readError(res, session))
  const data = (await res.json().catch(() => null)) as OwnList | null
  if (!data?.projects) throw new Error('got a malformed response from hacklab')
  return data
}

/** Fetch your projects or exit with the mode-appropriate error. */
async function ownProjectsOrExit(
  session: Session,
  json: boolean
): Promise<OwnList> {
  try {
    return await fetchOwnProjects(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }
}

/** Nearest slug for a "did you mean" hint: prefix/substring match, else null. */
function nearestSlug(projects: RemoteProject[], slug: string): string | null {
  const q = slug.toLowerCase()
  const hit =
    projects.find((p) => p.slug.startsWith(q)) ??
    projects.find((p) => p.slug.includes(q))
  return hit?.slug ?? null
}

/**
 * An explicit `--private`/`--public`, or undefined to fall back to the probe.
 * A private repo's link 404s for visitors and it's absent from the public
 * pinned-repo snapshot, so the web hides its repo link, button, and stats.
 */
function explicitPrivacy(args: string[]): boolean | undefined {
  if (args.includes('--private')) return true
  if (args.includes('--public')) return false
  return undefined
}

/**
 * Split the two link flags. `--repo` takes any git host; `--url` is the live
 * site, except that a github.com `--url` with no `--repo` routes to the repo —
 * the one flag a "just give it a URL" project needs.
 */
function resolveLinks(
  args: string[],
  json: boolean
): { repoUrl: string | null; liveUrl: string | null; touchedRepo: boolean } {
  const repoFlag = flagValue(args, '--repo')
  const urlFlag = flagValue(args, '--url')
  const urlIsRepo =
    repoFlag === undefined && urlFlag !== undefined && isGithubRepoUrl(urlFlag)

  const rawRepo = repoFlag ?? (urlIsRepo ? urlFlag : undefined)
  let repoUrl: string | null = null
  if (rawRepo !== undefined) {
    const repo = normalizeRepoUrl(rawRepo)
    if (!repo) {
      const message = `${repoFlag !== undefined ? '--repo' : '--url'} is not a valid git URL`
      if (json) emitJsonError('invalid_fields', message)
      error(message)
      process.exit(1)
    }
    repoUrl = repo.url
  }

  let liveUrl: string | null = null
  if (urlFlag !== undefined && !urlIsRepo) {
    liveUrl = parseHttpUrl(urlFlag)
    if (!liveUrl) {
      const message = '--url must be an http(s) URL'
      if (json) emitJsonError('invalid_fields', message)
      error(message)
      process.exit(1)
    }
  }

  return { repoUrl, liveUrl, touchedRepo: rawRepo !== undefined }
}

async function projectAdd(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, ADD_FLAGS, VALUE_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  const description = flagValue(args, '--description', '--desc')

  if (!title) {
    const message = 'a project needs a title: --title "My Project"'
    if (json) emitJsonError('missing_title', message)
    error(message)
    process.exit(1)
  }
  if (!flagValue(args, '--repo') && !flagValue(args, '--url')) {
    const message =
      'a project needs a link: --repo <git url> or --url https://…'
    if (json) emitJsonError('missing_url', message)
    error(message)
    process.exit(1)
  }

  const links = resolveLinks(args, json)
  const slug = slugFromName(title)
  const session = await requireSession(json)

  const existing = (await ownProjectsOrExit(session, json)).projects.find(
    (p) => p.slug === slug
  )

  const repoUrl = links.repoUrl ?? existing?.repoUrl ?? null
  const liveUrl = links.liveUrl ?? existing?.liveUrl ?? null
  const isPrivate = explicitPrivacy(args) ?? (await probeRepoPrivate(repoUrl))

  const payload = {
    title,
    slug,
    description: description ?? existing?.description ?? undefined,
    tags: existing?.tags ?? [],
    repoUrl: repoUrl ?? undefined,
    liveUrl: liveUrl ?? undefined,
    private: isPrivate,
    screenshots: existing?.screenshots ?? [],
    content: existing?.content ?? undefined,
    sourceYaml: existing?.sourceYaml ?? undefined,
    publishedAt: existing?.publishedAt ?? new Date().toISOString(),
  }

  let res: Response
  try {
    res = await fetchApi(session, PROJECTS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify(payload),
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

  await captureEvent(session.handle, 'cli_project_added', {
    slug,
    refreshed: Boolean(existing),
    has_repo: Boolean(repoUrl),
    has_live_url: Boolean(liveUrl),
    private: isPrivate,
  })

  const path = `/${session.handle}/${slug}`
  if (json) {
    printJson({
      schemaVersion: 1,
      [existing ? 'refreshed' : 'published']: true,
      slug,
      path,
    })
    return
  }
  success(`${existing ? 'refreshed' : 'published'} ${bold(title)}`)
  info(link(`${resolveAppUrl(session)}${path}`))
}

function renderList(handle: string, projects: RemoteProject[], appUrl: string) {
  if (projects.length === 0) {
    info('no projects yet')
    info(
      `run ${dim('hacklab project add --title "…" --repo <url>')} to publish one`
    )
    return
  }
  const width = Math.max(...projects.map((p) => p.slug.length))
  for (const p of projects) {
    const desc = summarize(p.description, 56)
    console.log(
      `  ${bold(stripControl(p.slug).padEnd(width))}${desc ? `  ${stripControl(desc)}` : ''}`
    )
  }
  console.log('')
  info(link(`${appUrl}/${handle}`))
}

function renderProject(project: RemoteProject, appUrl: string) {
  console.log(`  ${bold(stripControl(project.title))}`)
  if (project.description) console.log(`  ${stripControl(project.description)}`)
  if (project.liveUrl) console.log(`  ${link(project.liveUrl)}`)
  else if (project.repoUrl) console.log(`  ${link(project.repoUrl)}`)
  if (project.content) {
    console.log('')
    console.log(stripControl(project.content).trimEnd())
  }
  console.log('')
  info(link(`${appUrl}${project.path}`))
}

async function projectList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, new Set(['--json']), new Set())
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const session = await requireSession(json)
  const list = await ownProjectsOrExit(session, json)

  if (json) {
    printJson({ schemaVersion: 1, ...list })
    return
  }
  renderList(list.handle, list.projects, resolveAppUrl(session))
}

async function projectView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const slug = positional(args, VALUE_FLAGS)
  if (!slug || slug.includes('/')) {
    const message = 'usage: hacklab project view <slug> (one of your own)'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  const list = await ownProjectsOrExit(session, json)

  const found = list.projects.find((p) => p.slug === slug)
  if (!found) {
    const message = `no project named "${slug}"`
    if (json) emitJsonError('not_found', message)
    error(message)
    const near = nearestSlug(list.projects, slug)
    if (near) info(`did you mean ${dim(`hacklab project view ${near}`)}?`)
    process.exit(1)
  }

  if (json) {
    printJson({ schemaVersion: 1, project: found })
    return
  }
  renderProject(found, resolveAppUrl(session))
}

async function projectEdit(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownFlag(args, EDIT_FLAGS, VALUE_FLAGS)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const yes = args.includes('--yes') || args.includes('-y')
  const slug = positional(args, VALUE_FLAGS)
  if (!slug) {
    const message = 'usage: hacklab project edit <slug> [--title …]'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const titleFlag = flagValue(args, '--title')
  const descFlag = flagValue(args, '--description', '--desc')
  const repoFlag = flagValue(args, '--repo')
  const urlFlag = flagValue(args, '--url')
  const explicit = explicitPrivacy(args)
  if (
    [titleFlag, descFlag, repoFlag, urlFlag].every((v) => v === undefined) &&
    explicit === undefined
  ) {
    const message =
      'nothing to edit — pass --title, --desc, --repo, --url, --private or --public'
    if (json) emitJsonError('no_change', message)
    error(message)
    process.exit(1)
  }

  const links = resolveLinks(args, json)
  const session = await requireSession(json)
  const list = await ownProjectsOrExit(session, json)

  const existing = list.projects.find((p) => p.slug === slug)
  if (!existing) {
    const message = `no project named "${slug}"`
    if (json) emitJsonError('not_found', message)
    error(message)
    const near = nearestSlug(list.projects, slug)
    if (near) info(`did you mean ${dim(`hacklab project edit ${near}`)}?`)
    process.exit(1)
  }

  // The POST route relabels an edited project `cli`, so editing one that
  // GitHub syncs silently ends that sync. Make the trade explicit.
  if (existing.source === 'github' && !yes) {
    const message = `${slug} is synced from GitHub — re-run with --yes to edit it anyway`
    if (json) emitJsonError('synced', message)
    error(message)
    process.exit(1)
  }

  // Only the passed fields change; everything else round-trips unchanged, so
  // editing one field never wipes the rest.
  const repoUrl = links.touchedRepo ? links.repoUrl : existing.repoUrl
  const liveUrl = links.liveUrl ?? existing.liveUrl

  // Re-probe only when the repo URL itself moved; otherwise the stored
  // visibility stands.
  let isPrivate = existing.private ?? false
  if (explicit !== undefined) isPrivate = explicit
  else if (links.touchedRepo) isPrivate = await probeRepoPrivate(repoUrl)

  const payload = {
    title: titleFlag ?? existing.title,
    slug: existing.slug,
    description:
      descFlag !== undefined ? descFlag : (existing.description ?? undefined),
    tags: existing.tags,
    repoUrl: repoUrl ?? undefined,
    liveUrl: liveUrl ?? undefined,
    private: isPrivate,
    screenshots: existing.screenshots ?? [],
    content: existing.content ?? undefined,
    sourceYaml: existing.sourceYaml ?? undefined,
    publishedAt: existing.publishedAt ?? new Date().toISOString(),
  }

  let res: Response
  try {
    res = await fetchApi(session, PROJECTS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify(payload),
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

  await captureEvent(session.handle, 'cli_project_edited', {
    slug,
    changed_title: titleFlag !== undefined,
    changed_repo: links.touchedRepo,
    private: isPrivate,
  })

  if (json) {
    printJson({ schemaVersion: 1, edited: true, slug, path: existing.path })
    return
  }
  success(`edited ${bold(stripControl(payload.title))}`)
  info(link(`${resolveAppUrl(session)}${existing.path}`))
}

async function projectDelete(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const yes = args.includes('--yes') || args.includes('-y')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    const message = 'usage: hacklab project delete <slug> [--yes]'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)

  // Deletion is irreversible and `project d <slug>` resolves here by prefix, so
  // a typo must not be enough on its own.
  if (!yes) {
    if (json || !process.stdin.isTTY) {
      const message = 'refusing to delete without confirmation — pass --yes'
      if (json) emitJsonError('confirm', message)
      error(message)
      process.exit(1)
    }
    const ok = await clack.confirm({
      message: `delete ${bold(slug)} from your profile? this cannot be undone.`,
      initialValue: false,
    })
    if (clack.isCancel(ok) || !ok) {
      info('kept.')
      return
    }
  }

  let res: Response
  try {
    res = await fetchApi(
      session,
      `${PROJECTS_PATH}/${encodeURIComponent(slug)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.token}` },
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }
  if (!res.ok) {
    if (res.status === 404) {
      const message = `no project named "${slug}"`
      if (json) emitJsonError('not_found', message)
      error(message)
      process.exit(1)
    }
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const data = (await res.json().catch(() => null)) as {
    deleted?: RemoteProject
  } | null

  await captureEvent(session.handle, 'cli_project_deleted', {
    slug,
    source: data?.deleted?.source,
  })

  if (json) {
    printJson({ schemaVersion: 1, deleted: true, slug })
    return
  }
  success(`deleted ${bold(slug)}`)
  if (data?.deleted?.source === 'github') {
    info(
      `it's synced from a pinned GitHub repo — unpin it or the next ${dim('hacklab sync')} brings it back`
    )
  }
}

export async function project(args: string[]): Promise<void> {
  const [subToken, ...rest] = args

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
    error(`ambiguous: project ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: project ${subToken}`)
    usage()
  }

  if (resolved.name === 'add') return projectAdd(rest)
  if (resolved.name === 'list') return projectList(rest)
  if (resolved.name === 'view') return projectView(rest)
  if (resolved.name === 'edit') return projectEdit(rest)
  if (resolved.name === 'delete') return projectDelete(rest)
}
