import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

// Infer a publishable project from the repo you're standing in — the machine
// already knows the title, description, links, and tags, so no manifest file
// is ever required. Everything here is best-effort: a missing README or
// package.json just means fewer prefilled fields, never a failure. The only
// hard requirement is a git repo (identity + idempotency come from the
// remote), enforced by the command, not here.

const execFileAsync = promisify(execFile)

export type RepoRemote = {
  /** Canonical https URL, no trailing `.git`. */
  url: string
  /** `owner/name` host path when it parses, e.g. `acme/hacklab`. */
  owner: string | null
  name: string
}

export type InferredProject = {
  slug: string
  title: string
  description: string | null
  tags: string[]
  repoUrl: string | null
  liveUrl: string | null
  /** Repo was private/inaccessible at add time; web hides its link + stats. */
  private: boolean
  /** Full README markdown, the project page's long-form content. */
  content: string | null
}

/** True when `url` points at a github.com repo — decides repoUrl vs liveUrl. */
export function isGithubRepoUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase()
    return host === 'github.com' || host === 'www.github.com'
  } catch {
    return false
  }
}

/**
 * Best-effort visibility check for a github.com repo. An unauthenticated GET
 * returns 200 for a public repo and 404 for a private (or missing) one — GitHub
 * hides a private repo's existence. Returns true only on a definitive 404.
 * Fails open to `false` on any network error/timeout or non-github URL: a dead
 * link to a private repo is harmless, but false-hiding a public project is not.
 * Our OAuth is identity-only (no repo scope), so this probe stays unauthenticated.
 */
export async function probeRepoPrivate(
  repoUrl: string | null | undefined
): Promise<boolean> {
  if (!repoUrl || !isGithubRepoUrl(repoUrl)) return false
  try {
    const res = await fetch(repoUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'HacklabCLI (+https://hacklab.so)' },
    })
    return res.status === 404
  } catch {
    return false
  }
}

/**
 * Normalize any common git remote spelling to a canonical https URL.
 * `git@github.com:acme/hacklab.git`, `ssh://git@github.com/acme/hacklab.git`,
 * and `https://github.com/acme/hacklab.git` all become
 * `https://github.com/acme/hacklab`.
 */
export function normalizeRepoUrl(remote: string): RepoRemote | null {
  const trimmed = remote.trim()
  if (!trimmed) return null

  const scp = trimmed.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/)
  const url = trimmed.match(
    /^(?:https?|ssh|git):\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/
  )
  const host = url?.[1] ?? scp?.[1]
  let path = url?.[2] ?? scp?.[2]
  if (!host || !path) return null

  path = path.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!path) return null

  const segments = path.split('/')
  const name = segments.at(-1)
  if (!name) return null

  return {
    url: `https://${host}/${path}`,
    owner: segments.at(-2) ?? null,
    name,
  }
}

/** Repo-name-derived slug matching the server's PROJECT_SLUG_PATTERN. */
export function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '')
  return slug || 'project'
}

/** Strip inline markdown (links, images, emphasis, code ticks) to plain text. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

/** The first ATX heading's text, e.g. `# hacklab` -> `hacklab`. */
export function titleFromReadme(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const match = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/)
    if (match?.[1]) {
      const text = stripInlineMarkdown(match[1])
      if (text) return text
    }
  }
  return null
}

/**
 * The first prose paragraph of a README: skips headings, badge/image-only
 * lines, block quotes, code fences, and HTML, then joins the first run of
 * plain text lines. This is the description fallback when package.json has
 * none.
 */
export function firstParagraph(markdown: string): string | null {
  const collected: string[] = []
  let inFence = false

  for (const raw of markdown.split('\n')) {
    const line = raw.trim()

    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const isProse =
      line.length > 0 &&
      !/^#/.test(line) &&
      !/^>/.test(line) &&
      !/^[-*+]\s/.test(line) &&
      !/^\d+\.\s/.test(line) &&
      !/^</.test(line) &&
      !/^\|/.test(line) &&
      !/^(---|===)/.test(line) &&
      stripInlineMarkdown(line).length > 0

    if (isProse) {
      collected.push(stripInlineMarkdown(line))
      continue
    }
    if (collected.length > 0) break
  }

  if (collected.length === 0) return null
  return collected.join(' ').replace(/\s+/g, ' ').slice(0, 2000).trim()
}

// Dependency -> tag. Deliberately coarse: tags are for browsing, not a
// lockfile inventory, so only broadly recognizable stack names make the cut.
const DEP_TAGS: [RegExp, string][] = [
  [/^next$/, 'nextjs'],
  [/^react(-dom)?$/, 'react'],
  [/^vue$/, 'vue'],
  [/^svelte$/, 'svelte'],
  [/^@angular\//, 'angular'],
  [/^solid-js$/, 'solidjs'],
  [/^astro$/, 'astro'],
  [/^expo$|^react-native$/, 'react-native'],
  [/^electron$/, 'electron'],
  [/^tailwindcss$/, 'tailwind'],
  [/^typescript$/, 'typescript'],
  [/^drizzle-orm$/, 'drizzle'],
  [/^@prisma\/client$|^prisma$/, 'prisma'],
  [/^hono$/, 'hono'],
  [/^express$/, 'express'],
  [/^fastify$/, 'fastify'],
  [/^@trpc\//, 'trpc'],
  [/^ai$|^openai$|^@anthropic-ai\//, 'ai'],
]

const MAX_TAGS = 10

/** package.json keywords first, then detected stack tags, deduped, capped. */
export function detectTags(pkg: {
  keywords?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}): string[] {
  const tags: string[] = []
  const push = (tag: string) => {
    const t = tag.trim().toLowerCase().slice(0, 50)
    if (t && !tags.includes(t)) tags.push(t)
  }

  if (Array.isArray(pkg.keywords)) {
    for (const k of pkg.keywords) {
      if (typeof k === 'string') push(k)
    }
  }

  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  for (const dep of Object.keys(deps)) {
    for (const [pattern, tag] of DEP_TAGS) {
      if (pattern.test(dep)) push(tag)
    }
  }

  return tags.slice(0, MAX_TAGS)
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** The repo root for cwd, or null when not inside a git work tree. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  return git(cwd, 'rev-parse', '--show-toplevel')
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

type PackageJson = {
  name?: string
  description?: string
  homepage?: string
  keywords?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Build the best project we can from the repo at `root`. Precedence per
 * field: README title > repo name; package.json description > README first
 * paragraph; homepage is the only liveUrl source (anything else is guessing).
 */
export async function inferProject(root: string): Promise<InferredProject> {
  const remoteUrl = await git(root, 'remote', 'get-url', 'origin')
  const remote = remoteUrl ? normalizeRepoUrl(remoteUrl) : null

  let pkg: PackageJson = {}
  const pkgRaw = await readIfExists(join(root, 'package.json'))
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw) as PackageJson
    } catch {
      // A broken package.json costs its fields, nothing more.
    }
  }

  const readme =
    (await readIfExists(join(root, 'README.md'))) ??
    (await readIfExists(join(root, 'readme.md')))

  // `root` is a git top-level path (forward slashes even on Windows), but use
  // basename so a backslash path passed in directly still yields the leaf dir.
  const dirName = basename(root) || 'project'
  const name = remote?.name ?? dirName

  const homepage =
    typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)
      ? pkg.homepage
      : null

  return {
    slug: slugFromName(name),
    title: (readme ? titleFromReadme(readme) : null) ?? name,
    description:
      pkg.description?.trim() || (readme ? firstParagraph(readme) : null),
    tags: detectTags(pkg),
    repoUrl: remote?.url ?? null,
    liveUrl: homepage,
    // Probing GitHub for visibility is the command's job (it owns the network
    // + the --private/--public overrides); inference stays offline.
    private: false,
    content: readme,
  }
}
