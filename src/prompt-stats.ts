import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { findFiles } from './scanners/util.js'

/**
 * Prompt statistics, computed entirely on this machine from the local Claude
 * Code transcripts and uploaded only under an explicit consent tier (see
 * prompt-consent.ts).
 *
 * Two numbers come out of a scan:
 *
 *   - a histogram of how long the user's own prompts are, in words
 *   - a per-project prompt count, keyed by the project's git origin
 *
 * and, under the `full` tier only, a sample of the raw prompt text so the
 * backend can score "how technical is this person's prompting". The backend
 * scores that sample and throws it away; it is never stored.
 *
 * Everything here is deliberately best-effort: an unreadable transcript, a
 * project that isn't a git repo, a missing `git` binary — each drops its own
 * contribution and the rest of the scan still uploads.
 */

const execFileAsync = promisify(execFile)

/** Buckets are `1..bucketMax`, so the axis stays readable at any prompt length. */
export const PROMPT_LENGTH_BUCKET_MIN = 10
export const PROMPT_LENGTH_BUCKET_MAX = 100
/** The percentile that sets `bucketMax`; everything above lands in the overflow. */
export const PROMPT_LENGTH_OVERFLOW_PERCENTILE = 0.9
/** Matches the backend's cap — anything longer is truncated before upload. */
export const CONVERSATION_SAMPLE_MAX_CHARS = 20_000

export type PromptStatsProject = {
  repoUrl: string
  promptCount: number
  lastActiveAt: string
}

export type PromptStats = {
  totalPrompts: number
  bucketMax: number
  histogram: { length: number; count: number }[]
  projects: PromptStatsProject[]
  /** Only ever set under the `full` consent tier. */
  conversationSample?: string
}

/**
 * The user's own prompt text from one transcript line, or null when the line
 * isn't one.
 *
 * A transcript's `user` entries cover more than typed prompts: tool results
 * come back as synthetic user turns too. Those carry `tool_result` content
 * blocks, so a line only counts when its content is a plain string or an array
 * of nothing but `text` blocks. Sidechain entries (subagent conversations) are
 * the agent talking to itself, not the person typing, so they're excluded.
 */
export function promptTextFrom(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const line = entry as {
    type?: unknown
    isSidechain?: unknown
    message?: { content?: unknown }
  }
  if (line.type !== 'user') return null
  if (line.isSidechain === true) return null

  const content = line.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') return null
    const { type, text } = block as { type?: unknown; text?: unknown }
    // One non-text block (a tool_result, an image) disqualifies the whole
    // entry: it isn't a prompt the person typed.
    if (type !== 'text' || typeof text !== 'string') return null
    texts.push(text)
  }
  return texts.length > 0 ? texts.join('\n') : null
}

/** Whitespace-separated word count. Zero-word prompts are dropped by callers. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

/**
 * The overflow threshold for this user's own distribution: their p90 prompt
 * length rounded up to a multiple of 10, clamped to [10, 100].
 *
 * Per-user rather than fixed because prompt length varies enormously between
 * people — a fixed axis would either crush a terse user's histogram into the
 * first two buckets or run a verbose one off the end.
 */
export function bucketMaxFor(wordCounts: number[]): number {
  if (wordCounts.length === 0) return PROMPT_LENGTH_BUCKET_MIN
  const sorted = [...wordCounts].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * PROMPT_LENGTH_OVERFLOW_PERCENTILE)
  )
  const p90 = sorted[index] ?? PROMPT_LENGTH_BUCKET_MIN
  const rounded = Math.ceil(p90 / 10) * 10
  return Math.min(
    PROMPT_LENGTH_BUCKET_MAX,
    Math.max(PROMPT_LENGTH_BUCKET_MIN, rounded)
  )
}

/**
 * Bucket the word counts. Buckets `1..bucketMax-1` are exact word counts; the
 * bucket at `bucketMax` is the overflow, holding every prompt that long or
 * longer. Empty buckets are omitted — the chart fills the gaps.
 */
export function buildHistogram(
  wordCounts: number[],
  bucketMax: number
): { length: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const words of wordCounts) {
    if (words <= 0) continue
    const bucket = words >= bucketMax ? bucketMax : words
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([length, count]) => ({ length, count }))
    .sort((a, b) => a.length - b.length)
}

/**
 * The `origin` remote of the repo at `cwd`, or null when there isn't one (not
 * a repo, no origin, no git binary, or the directory is gone). The URL is sent
 * as-is; the backend normalizes it before matching against the user's own
 * projects.
 */
export async function gitOriginUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { timeout: 5_000 }
    )
    const url = stdout.trim()
    return url.length > 0 ? url : null
  } catch {
    return null
  }
}

type ProjectAccumulator = {
  cwd: string | null
  promptCount: number
  lastActiveAt: number
}

/**
 * Scan the local Claude Code transcripts.
 *
 * `includeSample` gates the raw prompt text: only the `full` consent tier
 * passes true, and the sample never touches disk here — it goes straight into
 * the upload payload the caller builds.
 */
export async function scanPromptStats(
  options: { includeSample?: boolean } = {}
): Promise<PromptStats | null> {
  const root = join(homedir(), '.claude', 'projects')
  const files = await findFiles(root, '.jsonl')
  if (files.length === 0) return null

  const wordCounts: number[] = []
  const sampleParts: string[] = []
  let sampleChars = 0
  // Keyed by the transcript's project directory, which is Claude Code's own
  // grouping. The directory name is a lossy encoding of the path, so the real
  // working directory comes from the `cwd` recorded inside the entries.
  const byProjectDir = new Map<string, ProjectAccumulator>()

  for (const filePath of files) {
    const projectDir = dirname(filePath)
    let project = byProjectDir.get(projectDir)
    if (!project) {
      project = { cwd: null, promptCount: 0, lastActiveAt: 0 }
      byProjectDir.set(projectDir, project)
    }

    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const entry = parsed as { cwd?: unknown; timestamp?: unknown }
      if (!project.cwd && typeof entry.cwd === 'string' && entry.cwd) {
        project.cwd = entry.cwd
      }

      const text = promptTextFrom(parsed)
      if (text === null) continue
      const words = countWords(text)
      if (words <= 0) continue

      wordCounts.push(words)
      project.promptCount += 1

      if (typeof entry.timestamp === 'string') {
        const at = Date.parse(entry.timestamp)
        if (Number.isFinite(at) && at > project.lastActiveAt) {
          project.lastActiveAt = at
        }
      }

      if (options.includeSample && sampleChars < CONVERSATION_SAMPLE_MAX_CHARS) {
        sampleParts.push(text)
        sampleChars += text.length + 2
      }
    }
  }

  if (wordCounts.length === 0) return null

  const bucketMax = bucketMaxFor(wordCounts)
  const stats: PromptStats = {
    totalPrompts: wordCounts.length,
    bucketMax,
    histogram: buildHistogram(wordCounts, bucketMax),
    projects: await resolveProjects(byProjectDir),
  }

  if (options.includeSample && sampleParts.length > 0) {
    stats.conversationSample = sampleParts
      .join('\n\n')
      .slice(0, CONVERSATION_SAMPLE_MAX_CHARS)
  }

  return stats
}

/**
 * Turn the per-directory tallies into repo-keyed entries. Directories with no
 * prompts, no recorded `cwd`, or no git origin drop out — the backend can only
 * match a project by its repo URL, so an entry without one is dead weight.
 *
 * Two transcript directories can resolve to the same repo (the same project
 * opened at different paths), so counts are summed per origin.
 */
async function resolveProjects(
  byProjectDir: Map<string, ProjectAccumulator>
): Promise<PromptStatsProject[]> {
  const byRepo = new Map<string, { promptCount: number; lastActiveAt: number }>()

  for (const project of byProjectDir.values()) {
    if (project.promptCount === 0 || !project.cwd) continue
    const repoUrl = await gitOriginUrl(project.cwd)
    if (!repoUrl) continue

    const existing = byRepo.get(repoUrl)
    if (existing) {
      existing.promptCount += project.promptCount
      existing.lastActiveAt = Math.max(
        existing.lastActiveAt,
        project.lastActiveAt
      )
    } else {
      byRepo.set(repoUrl, {
        promptCount: project.promptCount,
        lastActiveAt: project.lastActiveAt,
      })
    }
  }

  return [...byRepo.entries()].map(([repoUrl, entry]) => ({
    repoUrl,
    promptCount: entry.promptCount,
    // A transcript with no usable timestamp still happened; dating it now is
    // more honest than dropping the project or claiming the epoch.
    lastActiveAt: new Date(
      entry.lastActiveAt > 0 ? entry.lastActiveAt : Date.now()
    ).toISOString(),
  }))
}
