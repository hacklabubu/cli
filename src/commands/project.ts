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
// `view` reads anyone's work. `delete` removes yours. Re-running `add` with
// the same title refreshes the same slug.

const SUBCOMMANDS = ['add', 'view', 'delete'] as const

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

export type ViewTarget =
  | { kind: 'list'; handle: string }
  | { kind: 'one'; handle: string; slug: string }
  | { kind: 'missing' }

export function parseViewTarget(token: string | undefined): ViewTarget {
  if (!token) return { kind: 'missing' }
  const raw = token.replace(/^@/, '')
  const slash = raw.indexOf('/')
  if (slash === -1) return { kind: 'list', handle: raw }
  const handle = raw.slice(0, slash)
  const slug = raw.slice(slash + 1)
  if (!handle || !slug) return { kind: 'missing' }
  return { kind: 'one', handle, slug }
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function printHelp() {
  console.log(
    `hacklab project add --title <t> --url <url> [--desc <d>] [--json]`
  )
  console.log(dim('  publish one; same title again updates'))
  console.log('')
  console.log(`hacklab project view <handle>/<slug> [--json]`)
  console.log(dim('  one project, full page'))
  console.log(`hacklab project view <handle> [--json]`)
  console.log(dim('  their list'))
  console.log('')
  console.log(`hacklab project delete <slug> [--json]`)
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

const ADD_FLAGS = new Set([
  '--title',
  '--url',
  '--desc',
  '--description',
  '--json',
])

function unknownAddFlag(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue
    const name = arg.split('=')[0]
    if (!name) continue
    if (!ADD_FLAGS.has(name)) return name
  }
  return undefined
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

async function fail(
  json: boolean,
  code: string,
  message: string,
  res?: Response
): Promise<never> {
  if (json && res) {
    const body = await res
      .clone()
      .json()
      .catch(() => null)
    if (body && typeof body === 'object') {
      console.log(JSON.stringify(body, null, 2))
      process.exit(1)
    }
  }
  if (json) emitJsonError(code, message)
  error(message)
  process.exit(1)
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

async function projectAdd(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const unknown = unknownAddFlag(args)
  if (unknown) {
    if (json) emitJsonError('invalid_fields', `unknown flag: ${unknown}`)
    error(`unknown flag: ${unknown}`)
    process.exit(1)
  }

  const title = flagValue(args, '--title')
  const url = flagValue(args, '--url')
  const description = flagValue(args, '--description', '--desc')

  if (!title) {
    const message = 'a project needs a title: --title "My Project"'
    if (json) emitJsonError('missing_title', message)
    error(message)
    process.exit(1)
  }
  if (!url) {
    const message = 'a project needs a url: --url https://…'
    if (json) emitJsonError('missing_url', message)
    error(message)
    process.exit(1)
  }

  const github = isGithubRepoUrl(url)
  const repo = github ? normalizeRepoUrl(url) : null
  const live = github ? null : parseHttpUrl(url)
  if (github && !repo) {
    const message = '--url is not a valid git URL'
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }
  if (!github && !live) {
    const message = '--url must be an http(s) URL'
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }

  const slug = slugFromName(title)
  const session = await requireSession(json)

  let existing: RemoteProject | undefined
  try {
    existing = (await fetchOwnProjects(session)).projects.find(
      (p) => p.slug === slug
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const repoUrl = repo?.url ?? existing?.repoUrl ?? null
  const liveUrl = live ?? existing?.liveUrl ?? null
  const isPrivate = await probeRepoPrivate(repoUrl)

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
    info(`no projects on @${handle}`)
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

async function projectView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const token = args.find((a) => !a.startsWith('-'))
  const target = parseViewTarget(token)
  if (target.kind === 'missing') {
    const message = 'usage: hacklab project view <handle> or <handle>/<slug>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  const path =
    target.kind === 'list'
      ? `/api/hackers/${encodeURIComponent(target.handle)}/projects`
      : `/api/hackers/${encodeURIComponent(target.handle)}/projects/${encodeURIComponent(target.slug)}`

  let res: Response
  try {
    res = await fetchApi(session, path, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('network', message)
    error(message)
    process.exit(1)
  }

  if (!res.ok) {
    if (res.status === 404) {
      const message =
        target.kind === 'one'
          ? `no project named "${target.slug}"`
          : `no hacker named "${target.handle}"`
      return fail(json, 'not_found', message, res)
    }
    const message = await readError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const body = (await res.json().catch(() => null)) as {
    handle?: string
    projects?: RemoteProject[]
    project?: RemoteProject
  } | null

  const appUrl = resolveAppUrl(session)
  if (target.kind === 'list') {
    if (!body?.projects) {
      if (json) emitJsonError('bad_response', 'malformed response')
      error('got a malformed response from hacklab')
      process.exit(1)
    }
    if (json) {
      printJson({
        schemaVersion: 1,
        handle: body.handle ?? target.handle,
        projects: body.projects,
      })
      return
    }
    renderList(body.handle ?? target.handle, body.projects, appUrl)
    return
  }

  if (!body?.project) {
    if (json) emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }
  if (json) {
    printJson({ schemaVersion: 1, project: body.project })
    return
  }
  renderProject(body.project, appUrl)
}

async function projectDelete(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    const message = 'usage: hacklab project delete <slug>'
    if (json) emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)

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
  if (resolved.name === 'view') return projectView(rest)
  if (resolved.name === 'delete') return projectDelete(rest)
}
