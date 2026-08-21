import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import * as clack from '@clack/prompts'
import { parse as parseYaml } from 'yaml'

import { captureEvent } from '../posthog.js'
import {
  findRepoRoot,
  type InferredProject,
  inferProject,
  isGithubRepoUrl,
  normalizeRepoUrl,
  probeRepoPrivate,
  slugFromName,
} from '../project-infer.js'
import { resolveCommand } from '../resolve-command.js'
import {
  loadSession,
  resolveAppUrl,
  type Session,
  unauthorizedHint,
} from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info, linkBlue, success } from '../ui.js'
import { openBrowser } from '../utils/openBrowser.js'

// `hacklab project` — publish and manage the projects on your profile. `add`
// reads the repo you're in (git remote, README, package.json) and only asks
// for confirmation; `apply` takes a declarative YAML/JSON manifest for agents
// or long-form content. `add` is idempotent per repo: the slug derives from
// the repo name, and a re-run refreshes the same project without touching its
// publish date or losing screenshots.

const SUBCOMMANDS = ['add', 'apply', 'list', 'view', 'edit', 'delete'] as const

const PROJECTS_PATH = '/api/projects'

type RemoteProject = {
  slug: string
  title: string
  description: string | null
  content: string | null
  tags: string[]
  repoUrl: string | null
  liveUrl: string | null
  private: boolean
  source: string
  screenshots: { url: string; caption: string }[]
  sourceYaml: string | null
  publishedAt: string | null
  updatedAt: string
  path: string
}

type ProjectList = { handle: string; projects: RemoteProject[] }

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function emitJsonError(code: string, message: string): never {
  console.log(JSON.stringify({ schemaVersion: 1, error: { code, message } }))
  process.exit(1)
}

function usage(exitCode = 1): never {
  if (exitCode === 0)
    info('usage: hacklab project [add|apply|list|view|edit|delete]')
  else error('usage: hacklab project [add|apply|list|view|edit|delete]')
  info(
    `  hacklab project ${dim('add [path] [--yes] [--json]')}       publish the repo you're in (re-run to refresh)`
  )
  info(
    `  hacklab project ${dim('add --no-repo --title <t> [--url <u>] [--desc <d>]')}  a project with no repo`
  )
  info(
    `  hacklab project ${dim('add --title/--desc/--url/--repo/--live/--tags/--slug')}  override any field`
  )
  info(
    `  hacklab project ${dim('add --content <md> | --content-file <path>')}  set the long-form content`
  )
  info(
    `  hacklab project ${dim('apply <file> [--yes] [--json]')}     publish from a yaml/json manifest`
  )
  info(
    `  hacklab project ${dim('list [--json]')}                      your projects`
  )
  info(
    `  hacklab project ${dim('view <slug> [--web] [--json]')}       show one`
  )
  info(
    `  hacklab project ${dim('edit <slug> --title/--desc/--url/--repo/--tags')}  change fields`
  )
  info(
    `  hacklab project ${dim('edit <slug> --clear-repo|--clear-live')}   drop a URL`
  )
  info(
    `  hacklab project ${dim('delete <slug> [--yes] [--json]')}     remove one`
  )
  process.exit(exitCode)
}

async function requireSession(json: boolean): Promise<Session> {
  const session = await loadSession()
  if (!session) {
    if (json) emitJsonError('unauthorized', 'not logged in')
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }
  return session
}

async function readEnvelopeError(
  res: Response,
  session: Session
): Promise<string> {
  if (res.status === 401) return unauthorizedHint(session)
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string } | string
  } | null
  if (typeof data?.error === 'string') return data.error
  return data?.error?.message ?? `request failed (${res.status})`
}

async function fetchProjects(session: Session): Promise<ProjectList> {
  const res = await fetchApi(session, PROJECTS_PATH, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) throw new Error(await readEnvelopeError(res, session))
  const data = (await res.json().catch(() => null)) as ProjectList | null
  if (!data?.projects) throw new Error('got a malformed response from hacklab')
  return data
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

/** Split a `--tags a,b,c` value into clean tag names. */
export function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20)
}

// og:image discovery: one GET of the live page, one regex. Both content-first
// and property-first attribute orders appear in the wild.
const OG_IMAGE_PATTERNS = [
  /<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i,
]

export function extractOgImage(html: string, baseUrl: string): string | null {
  for (const pattern of OG_IMAGE_PATTERNS) {
    const match = html.match(pattern)
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).toString()
      } catch {
        return null
      }
    }
  }
  return null
}

const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Best-effort screenshot from the live site's og:image. Any failure —
 * unreachable site, no tag, oversized or non-png/jpeg image, upload error —
 * returns null and costs nothing but the attempt.
 */
async function captureOgScreenshot(
  session: Session,
  liveUrl: string
): Promise<{ url: string; caption: string } | null> {
  try {
    const page = await fetch(liveUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'HacklabCLI (+https://hacklab.so)' },
    })
    if (!page.ok) return null
    const imageUrl = extractOgImage(await page.text(), liveUrl)
    if (!imageUrl) return null

    const image = await fetch(imageUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'HacklabCLI (+https://hacklab.so)' },
    })
    if (!image.ok) return null
    const contentType = image.headers.get('content-type')?.split(';')[0]
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null
    const bytes = Buffer.from(await image.arrayBuffer())
    if (bytes.length === 0 || bytes.length > SCREENSHOT_MAX_BYTES) return null

    const upload = await fetchApi(session, '/api/screenshots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        image: bytes.toString('base64'),
        filename: contentType === 'image/png' ? 'og.png' : 'og.jpg',
        contentType,
      }),
    })
    const data = (await upload.json().catch(() => null)) as {
      url?: string
    } | null
    if (!upload.ok || !data?.url) return null
    return { url: data.url, caption: '' }
  } catch {
    return null
  }
}

function summarize(value: string | null, max = 72): string {
  if (!value) return dim('(none)')
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

// ── `project apply <file>` — declarative YAML/JSON manifest ──────────────────
// `add` reads a repo; `apply` reads a manifest, giving agents a one-shot path
// for long-form content and explicit screenshots. The raw source is stored as
// `sourceYaml` so a later `edit` can round-trip it.

type ProjectScreenshot = { url: string; caption: string }

type ProjectDraft = InferredProject & {
  screenshots?: ProjectScreenshot[]
  sourceYaml?: string
}

export type ParsedProjectDocument =
  | { ok: true; project: ProjectDraft }
  | { ok: false; error: string }

// Keep in sync with PROJECT_SCREENSHOT_CONTENT_TYPES in
// apps/web/app/(app)/api/screenshots/route.ts (server-side counterpart).
const SCREENSHOT_CONTENT_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
])

function httpUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${field} must be a URL`)
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http or https`)
  }
  return url.toString()
}

function requiredHttpUrl(value: unknown, field: string): string {
  const url = httpUrl(value, field)
  if (!url) throw new Error(`${field} is required`)
  return url
}

/** Parse the agent-friendly project.yaml/json shape before sending it. */
export function parseProjectDocument(doc: unknown): ParsedProjectDocument {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: 'expected a project mapping' }
  }

  const input = doc as Record<string, unknown>
  const allowed = new Set([
    'title',
    'slug',
    'description',
    'tags',
    'repoUrl',
    'liveUrl',
    'content',
    'screenshots',
  ])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown) return { ok: false, error: `unknown field "${unknown}"` }

  try {
    if (
      input.repoUrl !== undefined &&
      input.repoUrl !== null &&
      typeof input.repoUrl !== 'string'
    ) {
      throw new Error('repoUrl must be a git URL')
    }
    const repo =
      typeof input.repoUrl === 'string' ? normalizeRepoUrl(input.repoUrl) : null
    if (input.repoUrl && !repo) {
      throw new Error('repoUrl is not a valid git URL')
    }

    const rawTitle = input.title
    if (rawTitle !== undefined && typeof rawTitle !== 'string') {
      throw new Error('title must be text')
    }
    const title = rawTitle?.trim() || repo?.name
    if (!title) throw new Error('title is required when repoUrl is missing')

    if (
      input.description !== undefined &&
      input.description !== null &&
      typeof input.description !== 'string'
    ) {
      throw new Error('description must be text')
    }
    if (
      input.content !== undefined &&
      input.content !== null &&
      typeof input.content !== 'string'
    ) {
      throw new Error('content must be text')
    }

    let tags: string[] = []
    if (typeof input.tags === 'string') tags = parseTags(input.tags)
    else if (Array.isArray(input.tags)) {
      if (!input.tags.every((tag) => typeof tag === 'string')) {
        throw new Error('tags must contain only text')
      }
      tags = input.tags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    } else if (input.tags !== undefined) {
      throw new Error('tags must be a list or comma-separated text')
    }

    let screenshots: ProjectScreenshot[] = []
    if (input.screenshots !== undefined) {
      if (!Array.isArray(input.screenshots)) {
        throw new Error('screenshots must be a list')
      }
      if (input.screenshots.length > 5) {
        throw new Error('screenshots supports at most 5 images')
      }
      screenshots = input.screenshots.map((shot, index) => {
        if (typeof shot === 'string') {
          return {
            url: requiredHttpUrl(shot, `screenshots[${index}]`),
            caption: '',
          }
        }
        if (typeof shot !== 'object' || shot === null || Array.isArray(shot)) {
          throw new Error(`screenshots[${index}] must be a URL or mapping`)
        }
        const value = shot as Record<string, unknown>
        if (typeof value.caption !== 'string' && value.caption !== undefined) {
          throw new Error(`screenshots[${index}].caption must be text`)
        }
        return {
          url: requiredHttpUrl(value.url, `screenshots[${index}].url`),
          caption: value.caption?.trim() ?? '',
        }
      })
    }

    const rawSlug = input.slug
    if (rawSlug !== undefined && typeof rawSlug !== 'string') {
      throw new Error('slug must be text')
    }

    return {
      ok: true,
      project: {
        title,
        slug: slugFromName(rawSlug?.trim() || repo?.name || title),
        description:
          typeof input.description === 'string'
            ? input.description.trim() || null
            : null,
        tags,
        repoUrl: repo?.url ?? null,
        liveUrl: httpUrl(input.liveUrl, 'liveUrl'),
        // Manifests don't declare privacy; `publishProject` probes the repo.
        private: false,
        content: typeof input.content === 'string' ? input.content : null,
        ...(input.screenshots !== undefined ? { screenshots } : {}),
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function uploadScreenshotFromUrl(
  session: Session,
  screenshot: ProjectScreenshot,
  index: number
): Promise<ProjectScreenshot> {
  const sourceUrl = httpUrl(screenshot.url, `screenshots[${index}]`)
  if (!sourceUrl) throw new Error(`screenshots[${index}] needs a URL`)

  const image = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'HacklabCLI (+https://hacklab.so)' },
  })
  if (!image.ok) {
    throw new Error(
      `could not download screenshot ${index + 1} (${image.status})`
    )
  }
  const contentType = image.headers.get('content-type')?.split(';')[0] ?? ''
  const extension = SCREENSHOT_CONTENT_TYPES.get(contentType)
  if (!extension) {
    throw new Error(`screenshot ${index + 1} must be PNG, JPEG, or WebP`)
  }
  const bytes = Buffer.from(await image.arrayBuffer())
  if (!bytes.length) throw new Error(`screenshot ${index + 1} is empty`)
  if (bytes.length > SCREENSHOT_MAX_BYTES) {
    throw new Error(`screenshot ${index + 1} is too large`)
  }

  const sourceName = basename(new URL(sourceUrl).pathname)
  const filename = sourceName || `screenshot-${index + 1}.${extension}`
  const upload = await fetchApi(session, '/api/screenshots', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      image: bytes.toString('base64'),
      filename,
      contentType,
    }),
  })
  const data = (await upload.json().catch(() => null)) as {
    url?: string
    error?: string
  } | null
  if (!upload.ok || !data?.url) {
    throw new Error(data?.error ?? `could not upload screenshot ${index + 1}`)
  }
  return { url: data.url, caption: screenshot.caption }
}

// Shared publish path for `apply`: idempotent by slug, keeps the original
// publish date on refresh, and round-trips `sourceYaml`/`content`.
async function publishProject(
  session: Session,
  draft: ProjectDraft,
  options: { json: boolean; yes: boolean }
): Promise<void> {
  const { json, yes } = options

  let existing: RemoteProject | undefined
  try {
    existing = (await fetchProjects(session)).projects.find(
      (project) => project.slug === draft.slug
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  // Manifests don't declare privacy; probe a github repoUrl like `add` does.
  const isPrivate = await probeRepoPrivate(draft.repoUrl)

  if (!json) {
    console.log(
      `  ${bold(existing ? 'refreshing' : 'publishing')} ${bold(draft.title)} ${dim(`(${draft.slug})`)}`
    )
    console.log(`  ${dim('description')}  ${summarize(draft.description)}`)
    console.log(
      `  ${dim('repo')}         ${summarize(draft.repoUrl)}${
        isPrivate ? dim('  (private — hidden on web)') : ''
      }`
    )
    console.log(`  ${dim('live')}         ${summarize(draft.liveUrl)}`)
    console.log(
      `  ${dim('tags')}         ${draft.tags.length ? draft.tags.join(', ') : dim('(none)')}`
    )
    console.log(
      `  ${dim('content')}      ${draft.content ? `${draft.content.length} chars` : dim('(none)')}`
    )
    console.log(
      `  ${dim('screenshots')}  ${draft.screenshots?.length ?? existing?.screenshots.length ?? 0}`
    )
  }

  if (!json && !yes && process.stdout.isTTY) {
    const go = await clack.confirm({ message: 'publish it?' })
    if (clack.isCancel(go) || !go) {
      clack.outro(dim('cancelled.'))
      return
    }
  }

  let screenshots = existing?.screenshots ?? []
  try {
    if (draft.screenshots !== undefined) {
      if (!json && draft.screenshots.length) {
        info(dim(`uploading ${draft.screenshots.length} screenshot(s)…`))
      }
      screenshots = []
      for (const [index, screenshot] of draft.screenshots.entries()) {
        screenshots.push(
          await uploadScreenshotFromUrl(session, screenshot, index)
        )
      }
    } else if (draft.liveUrl) {
      if (!json) info(dim('looking for a screenshot (og:image)…'))
      const shot = await captureOgScreenshot(session, draft.liveUrl)
      if (shot) screenshots = [shot]
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('screenshot_failed', message)
    error(message)
    process.exit(1)
  }

  const payload = {
    title: draft.title,
    slug: draft.slug,
    description: draft.description ?? undefined,
    tags: draft.tags,
    repoUrl: draft.repoUrl ?? undefined,
    liveUrl: draft.liveUrl ?? undefined,
    private: isPrivate,
    screenshots,
    content: draft.content ?? existing?.content ?? undefined,
    sourceYaml: draft.sourceYaml ?? existing?.sourceYaml ?? undefined,
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
    const message = await readEnvelopeError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle, 'cli_project_added', {
    slug: draft.slug,
    refreshed: Boolean(existing),
    private: isPrivate,
    has_live_url: Boolean(draft.liveUrl),
    has_screenshot: screenshots.length > 0,
    tag_count: draft.tags.length,
    via: 'apply',
  })

  const path = `/${session.handle}/${draft.slug}`
  if (json) {
    printJson({
      schemaVersion: 1,
      [existing ? 'refreshed' : 'published']: true,
      slug: draft.slug,
      path,
      screenshots,
    })
    return
  }
  success(`${existing ? 'refreshed' : 'published'} ${bold(draft.title)}`)
  info(`${resolveAppUrl(session)}${path}`)
}

async function projectApply(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const yes = args.includes('--yes')
  const path = args.find((arg) => !arg.startsWith('-'))
  if (!path) usage()

  let sourceYaml: string
  try {
    sourceYaml = await readFile(path, 'utf8')
  } catch {
    const message = `could not read ${path}`
    if (json) emitJsonError('read_failed', message)
    error(message)
    process.exit(1)
  }

  let doc: unknown
  try {
    doc = parseYaml(sourceYaml)
  } catch (err) {
    const message = `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`
    if (json) emitJsonError('parse_failed', message)
    error(message)
    process.exit(1)
  }

  const parsed = parseProjectDocument(doc)
  if (!parsed.ok) {
    if (json) emitJsonError('invalid_fields', parsed.error)
    error(parsed.error)
    process.exit(1)
  }

  const session = await requireSession(json)
  await publishProject(
    session,
    { ...parsed.project, sourceYaml },
    { json, yes }
  )
}

async function projectAdd(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const yes = args.includes('--yes')
  const noRepo = args.includes('--no-repo')

  const overrides = {
    title: flagValue(args, '--title'),
    description: flagValue(args, '--description', '--desc'),
    liveUrl: flagValue(args, '--live'),
    repoUrl: flagValue(args, '--repo'),
    // `--url` auto-routes: a github.com URL becomes the repo, anything else the
    // live link — the one flag a "just give it a URL" manual project needs.
    url: flagValue(args, '--url'),
    slug: flagValue(args, '--slug'),
    tags: flagValue(args, '--tags'),
    // Override the long-form project content (defaults to the repo README):
    // `--content` inline, or `--content-file <path>` to read it from disk.
    content: flagValue(args, '--content'),
    contentFile: flagValue(args, '--content-file'),
  }
  const flagValues = new Set(
    Object.values(overrides).filter((v): v is string => v !== undefined)
  )

  if (overrides.content !== undefined && overrides.contentFile !== undefined) {
    const message = 'use either --content or --content-file, not both'
    if (json) emitJsonError('invalid_fields', message)
    error(message)
    process.exit(1)
  }
  let contentOverride = overrides.content
  if (overrides.contentFile) {
    try {
      contentOverride = await readFile(overrides.contentFile, 'utf8')
    } catch {
      const message = `could not read ${overrides.contentFile}`
      if (json) emitJsonError('read_failed', message)
      error(message)
      process.exit(1)
    }
  }
  const pathArg = args.find((a) => !a.startsWith('-') && !flagValues.has(a))

  // Manual (no-repo) project: explicit --no-repo, or a --title given from a
  // non-git directory. Otherwise infer from the repo you're standing in.
  const root = noRepo ? null : await findRepoRoot(pathArg ?? process.cwd())
  const manual = noRepo || (!root && Boolean(overrides.title))

  if (!manual && !root) {
    const message = `not a git repository: ${pathArg ?? process.cwd()}`
    if (json) emitJsonError('not_a_repo', message)
    error(message)
    info('run from inside the repo you want to publish')
    info(
      `or add a project with no repo: ${dim('project add --no-repo --title "…"')}`
    )
    process.exit(1)
  }

  const urlIsRepo = overrides.url ? isGithubRepoUrl(overrides.url) : false
  const urlAsRepo = urlIsRepo ? overrides.url : undefined
  const urlAsLive = overrides.url && !urlIsRepo ? overrides.url : undefined

  let draft: InferredProject
  if (manual) {
    if (!overrides.title) {
      const message =
        'a project with no repo needs a title: --title "My Project"'
      if (json) emitJsonError('missing_title', message)
      error(message)
      process.exit(1)
    }
    draft = {
      slug: slugFromName(overrides.slug ?? overrides.title),
      title: overrides.title,
      description: overrides.description ?? null,
      tags: overrides.tags ? parseTags(overrides.tags) : [],
      repoUrl: overrides.repoUrl ?? urlAsRepo ?? null,
      liveUrl: overrides.liveUrl ?? urlAsLive ?? null,
      private: false,
      content: null,
    }
  } else {
    // biome-ignore lint/style/noNonNullAssertion: `manual` is false here so root is set.
    const inferred = await inferProject(root!)
    draft = {
      ...inferred,
      title: overrides.title ?? inferred.title,
      description: overrides.description ?? inferred.description,
      liveUrl: overrides.liveUrl ?? urlAsLive ?? inferred.liveUrl,
      repoUrl: overrides.repoUrl ?? urlAsRepo ?? inferred.repoUrl,
      slug: overrides.slug ? slugFromName(overrides.slug) : inferred.slug,
      tags: overrides.tags ? parseTags(overrides.tags) : inferred.tags,
    }
  }

  if (contentOverride !== undefined) draft.content = contentOverride

  // Privacy: explicit --private/--public win; otherwise probe a github repoUrl.
  // A private repo's link 404s for visitors and it's absent from the public
  // pinned-repo snapshot, so the web hides its repo link, GitHub button + stats.
  if (args.includes('--private')) draft.private = true
  else if (args.includes('--public')) draft.private = false
  else draft.private = await probeRepoPrivate(draft.repoUrl)

  const session = await requireSession(json)

  // The existing row (if any) decides create-vs-refresh, keeps the original
  // publish date, and provides fallback screenshots.
  let existing: RemoteProject | undefined
  try {
    existing = (await fetchProjects(session)).projects.find(
      (p) => p.slug === draft.slug
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  if (!json) {
    console.log(
      `  ${bold(existing ? 'refreshing' : 'publishing')} ${bold(draft.title)} ${dim(`(${draft.slug})`)}`
    )
    console.log(`  ${dim('description')}  ${summarize(draft.description)}`)
    console.log(
      `  ${dim('repo')}         ${summarize(draft.repoUrl)}${
        draft.private ? dim('  (private — hidden on web)') : ''
      }`
    )
    console.log(`  ${dim('live')}         ${summarize(draft.liveUrl)}`)
    console.log(
      `  ${dim('tags')}         ${draft.tags.length ? draft.tags.join(', ') : dim('(none)')}`
    )
    console.log(
      `  ${dim('content')}      ${draft.content ? `${draft.content.length} chars` : dim('(none)')}`
    )
  }

  if (!json && !yes && process.stdout.isTTY) {
    const go = await clack.confirm({ message: 'publish it?' })
    if (clack.isCancel(go) || !go) {
      clack.outro(dim('cancelled.'))
      return
    }
  }

  // Fresh og:image capture when the site has one; otherwise whatever the
  // project already shows keeps showing (POST overwrites screenshots).
  let screenshots = existing?.screenshots ?? []
  if (draft.liveUrl) {
    if (!json) info(dim('looking for a screenshot (og:image)…'))
    const shot = await captureOgScreenshot(session, draft.liveUrl)
    if (shot) screenshots = [shot]
  }

  const payload = {
    title: draft.title,
    slug: draft.slug,
    description: draft.description ?? undefined,
    tags: draft.tags,
    repoUrl: draft.repoUrl ?? undefined,
    liveUrl: draft.liveUrl ?? undefined,
    private: draft.private,
    screenshots,
    content: draft.content ?? undefined,
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
    const message = await readEnvelopeError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle, 'cli_project_added', {
    slug: draft.slug,
    refreshed: Boolean(existing),
    manual,
    has_repo: Boolean(draft.repoUrl),
    private: draft.private,
    has_live_url: Boolean(draft.liveUrl),
    has_screenshot: screenshots.length > 0,
    tag_count: draft.tags.length,
  })

  const path = `/${session.handle}/${draft.slug}`
  if (json) {
    printJson({
      schemaVersion: 1,
      [existing ? 'refreshed' : 'published']: true,
      slug: draft.slug,
      path,
    })
    return
  }
  success(`${existing ? 'refreshed' : 'published'} ${bold(draft.title)}`)
  info(`${resolveAppUrl(session)}${path}`)
}

async function projectList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)

  let list: ProjectList
  try {
    list = await fetchProjects(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  if (json) {
    printJson({ schemaVersion: 1, ...list })
    return
  }

  if (list.projects.length === 0) {
    info('no projects yet')
    info(`run ${dim('hacklab project add')} inside a repo to publish one`)
    return
  }

  const width = Math.max(...list.projects.map((p) => p.slug.length))
  for (const p of list.projects) {
    console.log(
      `  ${bold(p.slug.padEnd(width))}  ${summarize(p.title, 48)} ${dim(`(${p.source})`)}`
    )
  }
  console.log('')
  info(dim(`${resolveAppUrl(session)}/${list.handle}`))
}

/** Nearest slug for a "did you mean" hint: prefix/substring match, else null. */
function nearestSlug(projects: RemoteProject[], slug: string): string | null {
  const q = slug.toLowerCase()
  const hit =
    projects.find((p) => p.slug.startsWith(q)) ??
    projects.find((p) => p.slug.includes(q))
  return hit?.slug ?? null
}

function renderProjectCard(project: RemoteProject, session: Session): void {
  console.log('')
  console.log(`  ${bold(project.title)} ${dim(`(${project.slug})`)}`)
  if (project.description) {
    console.log(`  ${summarize(project.description, 96)}`)
  }
  console.log('')
  if (project.tags.length) {
    console.log(`  ${dim('tags')}    ${project.tags.join(', ')}`)
  }
  if (project.repoUrl) {
    console.log(
      `  ${dim('repo')}    ${project.repoUrl}${
        project.private ? dim('  (private — hidden on web)') : ''
      }`
    )
  }
  if (project.liveUrl) console.log(`  ${dim('live')}    ${project.liveUrl}`)
  console.log(
    `  ${dim('source')}  ${project.source}${
      project.content
        ? dim(`  ·  README (${project.content.length} chars)`)
        : ''
    }`
  )
  console.log('')
  info(dim(`${resolveAppUrl(session)}${project.path}`))
}

async function projectView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const web = args.includes('--web')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    if (json) emitJsonError('usage', 'usage: hacklab project view <slug>')
    error('usage: hacklab project view <slug>')
    process.exit(1)
  }

  const session = await requireSession(json)

  let list: ProjectList
  try {
    list = await fetchProjects(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const project = list.projects.find((p) => p.slug === slug)
  if (!project) {
    if (json) emitJsonError('not_found', `no project named "${slug}"`)
    error(`no project named "${slug}"`)
    const near = nearestSlug(list.projects, slug)
    if (near) info(`did you mean ${dim(`hacklab project view ${near}`)}?`)
    process.exit(1)
  }

  const url = `${resolveAppUrl(session)}${project.path}`
  if (web) {
    const opened = await openBrowser(url)
    info(
      opened
        ? `opened ${linkBlue(url)}`
        : `could not open a browser — ${linkBlue(url)}`
    )
    return
  }

  if (json) {
    printJson({ schemaVersion: 1, project })
    return
  }

  renderProjectCard(project, session)
}

async function projectEdit(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const yes = args.includes('--yes')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    if (json)
      emitJsonError('usage', 'usage: hacklab project edit <slug> [--title …]')
    error(
      'usage: hacklab project edit <slug> [--title/--desc/--url/--repo/--tags]'
    )
    process.exit(1)
  }

  const titleFlag = flagValue(args, '--title')
  const descFlag = flagValue(args, '--description', '--desc')
  const liveFlag = flagValue(args, '--live')
  const repoFlag = flagValue(args, '--repo')
  const urlFlag = flagValue(args, '--url')
  const tagsFlag = flagValue(args, '--tags')
  const clearRepo = args.includes('--clear-repo')
  const clearLive = args.includes('--clear-live')

  const urlIsRepo = urlFlag ? isGithubRepoUrl(urlFlag) : false
  const changed =
    [titleFlag, descFlag, liveFlag, repoFlag, urlFlag, tagsFlag].some(
      (v) => v !== undefined
    ) ||
    clearRepo ||
    clearLive
  if (!changed) {
    const message =
      'nothing to edit — pass --title, --desc, --url, --repo, --live, --tags, --clear-repo or --clear-live'
    if (json) emitJsonError('no_change', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)

  let list: ProjectList
  try {
    list = await fetchProjects(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  const existing = list.projects.find((p) => p.slug === slug)
  if (!existing) {
    if (json) emitJsonError('not_found', `no project named "${slug}"`)
    error(`no project named "${slug}"`)
    const near = nearestSlug(list.projects, slug)
    if (near) info(`did you mean ${dim(`hacklab project edit ${near}`)}?`)
    process.exit(1)
  }

  // Editing a GitHub-synced project converts it to a manual one (the POST route
  // relabels it `cli`), so it stops updating from GitHub. Confirm first.
  if (existing.source === 'github') {
    if (!json && !yes && process.stdout.isTTY) {
      const go = await clack.confirm({
        message: `${bold(slug)} is synced from GitHub — editing stops that sync. continue?`,
      })
      if (clack.isCancel(go) || !go) {
        clack.outro(dim('cancelled.'))
        return
      }
    } else if (!json && !yes) {
      error(
        `${slug} is synced from GitHub — re-run with --yes to edit it anyway`
      )
      process.exit(1)
    }
  }

  // Merge: only passed fields change; everything else round-trips unchanged.
  let repoUrl = existing.repoUrl
  let liveUrl = existing.liveUrl
  if (repoFlag !== undefined) repoUrl = repoFlag
  if (liveFlag !== undefined) liveUrl = liveFlag
  if (urlFlag !== undefined) {
    if (urlIsRepo) repoUrl = urlFlag
    else liveUrl = urlFlag
  }
  if (clearRepo) repoUrl = null
  if (clearLive) liveUrl = null

  // Re-probe privacy only when the repo URL itself changed.
  const repoChanged =
    repoFlag !== undefined || (urlFlag !== undefined && urlIsRepo) || clearRepo
  let isPrivate = existing.private
  if (args.includes('--private')) isPrivate = true
  else if (args.includes('--public')) isPrivate = false
  else if (repoChanged) isPrivate = await probeRepoPrivate(repoUrl)

  const payload = {
    title: titleFlag ?? existing.title,
    slug: existing.slug,
    description:
      descFlag !== undefined ? descFlag : (existing.description ?? undefined),
    tags: tagsFlag !== undefined ? parseTags(tagsFlag) : existing.tags,
    repoUrl: repoUrl ?? undefined,
    liveUrl: liveUrl ?? undefined,
    private: isPrivate,
    screenshots: existing.screenshots,
    content: existing.content ?? undefined,
    // A partial edit round-trips everything it doesn't touch — including the
    // `apply` manifest source — so editing one field never wipes the rest.
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
    const message = await readEnvelopeError(res, session)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle, 'cli_project_edited', {
    slug,
    private: isPrivate,
    changed_title: titleFlag !== undefined,
    changed_repo: repoChanged,
  })

  const path = existing.path
  if (json) {
    printJson({ schemaVersion: 1, edited: true, slug, path })
    return
  }
  success(`edited ${bold(payload.title)}`)
  info(`${resolveAppUrl(session)}${path}`)
}

async function projectDelete(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const yes = args.includes('--yes')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) usage()

  const session = await requireSession(json)

  if (!json && !yes && process.stdout.isTTY) {
    const go = await clack.confirm({
      message: `delete ${bold(slug)} from your profile?`,
    })
    if (clack.isCancel(go) || !go) {
      clack.outro(dim('cancelled.'))
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
    const message = await readEnvelopeError(res, session)
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
    printJson({ schemaVersion: 1, deleted: data?.deleted ?? { slug } })
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

  if (subToken === '--help' || subToken === '-h' || subToken === 'help') {
    usage(0)
  }

  // Bare `hacklab project` prints the help — publishing the current repo is
  // an explicit `add` away.
  if (!subToken) {
    usage(0)
  }
  if (subToken.startsWith('-')) {
    usage()
  }

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
  if (resolved.name === 'apply') return projectApply(rest)
  if (resolved.name === 'list') return projectList(rest)
  if (resolved.name === 'view') return projectView(rest)
  if (resolved.name === 'edit') return projectEdit(rest)
  if (resolved.name === 'delete') return projectDelete(rest)
}
