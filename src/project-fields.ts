// Pure helpers shared by the `hacklab project` command: repo-URL
// normalization, slug derivation, and the GitHub privacy probe. Everything
// here is best-effort and offline except `probeRepoPrivate`, which owns the
// one network call.

export type RepoRemote = {
  /** Canonical https URL, no trailing `.git`. */
  url: string
  /** `owner/name` host path when it parses, e.g. `acme/hacklab`. */
  owner: string | null
  name: string
}

export type ProjectFields = {
  slug: string
  title: string
  description: string | null
  tags: string[]
  repoUrl: string | null
  liveUrl: string | null
  /** Repo was private/inaccessible at add time; web hides its link + stats. */
  private: boolean
  /** Long-form markdown, the project page's content. */
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

/** Name-derived slug matching the server's PROJECT_SLUG_PATTERN. */
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
