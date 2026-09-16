import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  antigravityTranscriptFiles,
  scanAntigravityPrompts,
} from './scanners/antigravity.js'
import {
  githubCopilotFiles,
  scanGitHubCopilotPrompts,
} from './scanners/github-copilot.js'
import { findFiles, toDateStr } from './scanners/util.js'

/**
 * Prompt statistics, computed on this machine from supported local harness
 * transcripts and uploaded only under an explicit consent tier (see
 * prompt-consent.ts).
 *
 * Three things come out of a full scan:
 *
 *   - a histogram of how long the user's own prompts are, in words — every
 *     bucket an exact word count — plus the tail, which is where the prompts
 *     longer than the axis are reported, and their only home
 *   - a per-project prompt count, keyed by the project's git origin
 *   - the prompt *activity* aggregate: per-session start/end/count and a
 *     per-day prompt/word tally. That one is also what the minutely tick
 *     accumulates incrementally (scanners/incremental.ts), so a full scan can
 *     re-base the tick's state without either drifting from the other.
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
/** The percentile that sets `bucketMax`; everything above it lands in `tail`. */
export const PROMPT_LENGTH_AXIS_PERCENTILE = 0.9
/** The server's cap on `tail` entries; longer distributions are coarsened. */
export const PROMPT_TAIL_MAX_ENTRIES = 400
/** Matches the backend's cap — anything longer is truncated before upload. */
export const CONVERSATION_SAMPLE_MAX_CHARS = 20_000

/**
 * Which definition of "a prompt the user typed" produced this upload.
 *
 * Version 1 is implicit — every CLI shipped before this field existed counted
 * harness-generated `user` entries (subagent task notifications, skill bodies,
 * slash-command echoes, interrupt markers) as prompts, which inflated the
 * counts and blew out the word tallies. Version 2 is the scan with
 * `isHarnessNoise` in it.
 *
 * It rides on every sync as a top-level `scannerVersion`; the server ignores
 * `promptStats` / `promptActivity` from anything below 2, so an un-upgraded CLI
 * can't keep writing the old numbers into a table that was wiped to fix them.
 */
export const PROMPT_SCANNER_VERSION = 2

/**
 * Prefixes that mark a `user` transcript entry as written by Claude Code
 * itself rather than typed by the person at the keyboard.
 *
 * These all arrive in exactly the shape a real prompt does — `type: 'user'`,
 * not a sidechain, content a plain string or `text` blocks — so nothing but the
 * text tells them apart. Measured over 194 local transcripts they were 39% of
 * everything the scan called a prompt and 65% of its words, because a machine's
 * report or an injected skill body is an order of magnitude longer than
 * anything a human types.
 *
 * Matched against the entry's text after `trimStart()`, and anchored to the
 * start on purpose: a prompt that *quotes* one of these tags mid-sentence
 * ("why does <command-name> show up twice?") is a real prompt and still counts.
 */
const HARNESS_NOISE_PREFIXES = [
  // The body of a skill, injected when one is invoked. Up to ~11.5k words.
  'Base directory for this skill:',
  // A background subagent's report, handed back as a user turn: ~400 words
  // each and the single largest source of fake prompts.
  '<task-notification>',
  // The wrapper around a slash command's expansion, its echo and its output.
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  // Context the harness injects into a turn. Nobody types it.
  '<system-reminder>',
  // Written when the user hits escape — the absence of a prompt, not one.
  '[Request interrupted',
  // `!`-prefixed bash mode: the command and whatever it printed.
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  // Text a UserPromptSubmit hook appended to the turn.
  '<user-prompt-submit-hook>',
]

/**
 * Is this entry text something the harness wrote rather than the user?
 *
 * Deliberately a prefix test and nothing more — no stripping of inline
 * `<system-reminder>` blocks out of otherwise-typed prompts. Those measured at
 * zero words of real contribution, and rewriting prompt text in place is a
 * bigger risk than the noise it would remove.
 */
export function isHarnessNoise(text: string): boolean {
  const start = text.trimStart()
  return HARNESS_NOISE_PREFIXES.some((prefix) => start.startsWith(prefix))
}

export type PromptStatsProject = {
  repoUrl: string
  promptCount: number
  lastActiveAt: string
}

/** One session's running aggregate, as both the tick and a full scan build it. */
export type PromptSessionAggregate = {
  /** ISO timestamp of the first prompt seen in this session. */
  startedAt: string
  /** ISO timestamp of the most recent one. */
  lastActiveAt: string
  promptCount: number
}

/** One day's running tally. Cumulative for this machine, never a delta. */
export type PromptDayAggregate = { prompts: number; words: number }

/**
 * The whole prompt-activity aggregate, keyed for cheap merging: sessions by
 * session id, days by YYYY-MM-DD.
 */
export type PromptActivityAggregate = {
  sessions: Record<string, PromptSessionAggregate>
  daily: Record<string, PromptDayAggregate>
}

/** Prompt-only sources: no token estimates and no token harness registration. */
export const IDE_PROMPT_SOURCES = [
  {
    id: 'antigravity',
    files: antigravityTranscriptFiles,
    scan: scanAntigravityPrompts,
  },
  {
    id: 'github_copilot',
    files: githubCopilotFiles,
    scan: scanGitHubCopilotPrompts,
  },
]

export type ScannedPromptActivity = PromptActivityAggregate & {
  /** Local-only partitions, so replacing one source never erases another. */
  sources?: Record<string, PromptActivityAggregate>
}

export function mergePromptActivities(
  sources: Iterable<PromptActivityAggregate>
): PromptActivityAggregate {
  const merged = emptyPromptActivity()
  for (const source of sources) {
    for (const [id, session] of Object.entries(source.sessions)) {
      merged.sessions[id] = { ...session }
    }
    for (const [date, day] of Object.entries(source.daily)) {
      merged.daily[date] ??= { prompts: 0, words: 0 }
      const target = merged.daily[date]
      target.prompts += day.prompts
      target.words += day.words
    }
  }
  return merged
}

export type PromptStats = {
  totalPrompts: number
  bucketMax: number
  histogram: { length: number; count: number }[]
  /**
   * The exact distribution above `bucketMax`, and the only place those prompts
   * are reported — the histogram stops at `bucketMax`. One entry per distinct
   * word count, ascending, coarsened if there are more than
   * `PROMPT_TAIL_MAX_ENTRIES` of them. Always present, empty when nothing
   * exceeds `bucketMax`: the field's presence is what tells the server this
   * histogram is exact, as opposed to a legacy snapshot whose last bar lumped
   * everything at or above `bucketMax`.
   */
  tail: { length: number; count: number }[]
  projects: PromptStatsProject[]
  /**
   * Sessions and per-day counts for the whole local history. Not part of the
   * `promptStats` block on the wire — the caller hands it to `stageFullScan`,
   * which re-bases the tick's incremental state on it and works out which rows
   * this upload still has to carry.
   */
  activity: ScannedPromptActivity
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
 *
 * That still leaves the harness's own writing, which is indistinguishable by
 * shape: subagent reports, injected skill bodies, slash-command echoes,
 * interrupt markers. Those are dropped two ways — `isMeta`, which Claude Code
 * sets on the entries it generates, and the text prefixes in
 * `isHarnessNoise` for the ones it doesn't.
 *
 * This is the single chokepoint: both the full scan and the minutely tick go
 * through here, so the histogram, the tail, the per-project counts, the
 * activity aggregate and the technical-score sample all see the same prompts.
 */
export function promptTextFrom(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const line = entry as {
    type?: unknown
    isSidechain?: unknown
    isMeta?: unknown
    message?: { content?: unknown }
  }
  if (line.type !== 'user') return null
  if (line.isSidechain === true) return null
  if (line.isMeta === true) return null

  const content = line.message?.content
  if (typeof content === 'string') {
    return isHarnessNoise(content) ? null : content
  }
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
  if (texts.length === 0) return null
  const joined = texts.join('\n')
  return isHarnessNoise(joined) ? null : joined
}

/** Whitespace-separated word count. Zero-word prompts are dropped by callers. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

/** The server's cap on a session id. Longer than this and the row is rejected. */
export const PROMPT_SESSION_ID_MAX_CHARS = 128

/** One prompt, reduced to the three facts the activity aggregate needs. */
export type PromptLine = {
  sessionId: string
  /** Canonical ISO-8601 UTC, so string order is time order. */
  timestamp: string
  words: number
}

/**
 * A transcript line as prompt activity, or null when it isn't one.
 *
 * Stricter than `promptTextFrom` on purpose: a prompt with no session id or no
 * usable timestamp can't be placed on a session or a day, and the server's
 * schema would reject it, so it counts towards the histogram (which needs
 * neither) and nothing else.
 */
export function parsePromptLine(line: string): PromptLine | null {
  if (!line.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const text = promptTextFrom(parsed)
  if (text === null) return null
  const words = countWords(text)
  if (words <= 0) return null

  const entry = parsed as { sessionId?: unknown; timestamp?: unknown }
  const sessionId =
    typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
  if (!sessionId || sessionId.length > PROMPT_SESSION_ID_MAX_CHARS) return null

  const timestamp = normalizeTimestamp(entry.timestamp)
  if (!timestamp) return null

  return { sessionId, timestamp, words }
}

/** An ISO-8601 UTC string, or null when the value isn't a usable instant. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const at = typeof value === 'number' ? value : Date.parse(value)
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function emptyPromptActivity(): PromptActivityAggregate {
  return { sessions: {}, daily: {} }
}

/**
 * Fold one prompt into an activity aggregate, returning the session and date it
 * landed on so an incremental caller can mark exactly those dirty.
 *
 * The date is the UTC day of the timestamp — the same attribution
 * `toDateStr` gives every token daily row, so the two halves of a sync agree
 * about which day a piece of work belongs to.
 */
export function addPromptToActivity(
  activity: PromptActivityAggregate,
  line: PromptLine
): { sessionId: string; date: string } {
  const session = activity.sessions[line.sessionId]
  if (session) {
    if (line.timestamp < session.startedAt) session.startedAt = line.timestamp
    if (line.timestamp > session.lastActiveAt) {
      session.lastActiveAt = line.timestamp
    }
    session.promptCount += 1
  } else {
    activity.sessions[line.sessionId] = {
      startedAt: line.timestamp,
      lastActiveAt: line.timestamp,
      promptCount: 1,
    }
  }

  const date = toDateStr(line.timestamp)
  const day = activity.daily[date]
  if (day) {
    day.prompts += 1
    day.words += line.words
  } else {
    activity.daily[date] = { prompts: 1, words: line.words }
  }

  return { sessionId: line.sessionId, date }
}

/**
 * Where the histogram's axis ends for this user's own distribution: their p90
 * prompt length rounded up to a multiple of 10, clamped to [10, 100]. Anything
 * longer is reported by `buildTail` instead.
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
    Math.floor(sorted.length * PROMPT_LENGTH_AXIS_PERCENTILE)
  )
  const p90 = sorted[index] ?? PROMPT_LENGTH_BUCKET_MIN
  const rounded = Math.ceil(p90 / 10) * 10
  return Math.min(
    PROMPT_LENGTH_BUCKET_MAX,
    Math.max(PROMPT_LENGTH_BUCKET_MIN, rounded)
  )
}

/**
 * Bucket the word counts. Every bucket `1..bucketMax` is an exact word count —
 * there is no overflow bar. Empty buckets are omitted; the chart fills the gaps.
 *
 * Prompts longer than `bucketMax` are not in here at all: they are reported by
 * `buildTail`, and only there. So the histogram and the tail partition the
 * scan — sum(histogram counts) + sum(tail counts) === totalPrompts, always.
 */
export function buildHistogram(
  wordCounts: number[],
  bucketMax: number
): { length: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const words of wordCounts) {
    if (words <= 0) continue
    if (words > bucketMax) continue
    counts.set(words, (counts.get(words) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([length, count]) => ({ length, count }))
    .sort((a, b) => a.length - b.length)
}

/**
 * The exact distribution of everything *longer* than `bucketMax`, which the
 * histogram does not cover at all. One entry per distinct word count,
 * ascending; empty (never absent) when nothing exceeds `bucketMax` — the
 * field's presence on the wire is the marker that the histogram's bars are
 * exact.
 *
 * Lengths only — no prompt text is involved here, or anywhere near it.
 *
 * A machine with a long history can have thousands of distinct long lengths,
 * far past what the server accepts, so an over-cap tail is coarsened: lengths
 * are rounded to multiples of 2, then 4, 8, … until at most
 * `PROMPT_TAIL_MAX_ENTRIES` entries remain, summing the counts that collapse
 * together. Rounding is *up* so that a coarsened entry still sits above
 * `bucketMax` — rounding down could claim a length inside the histogram's own
 * exact range for a prompt the histogram never counted.
 *
 * Deterministic: the result depends only on the multiset of word counts.
 */
export function buildTail(
  wordCounts: number[],
  bucketMax: number
): { length: number; count: number }[] {
  const exact = new Map<number, number>()
  for (const words of wordCounts) {
    if (words <= bucketMax) continue
    exact.set(words, (exact.get(words) ?? 0) + 1)
  }
  if (exact.size === 0) return []

  let counts = exact
  let step = 1
  while (counts.size > PROMPT_TAIL_MAX_ENTRIES) {
    step *= 2
    const coarser = new Map<number, number>()
    // Always coarsen from the exact counts, so the rounding is one clean
    // division rather than a rounding of a rounding.
    for (const [length, count] of exact) {
      const rounded = Math.ceil(length / step) * step
      coarser.set(rounded, (coarser.get(rounded) ?? 0) + count)
    }
    counts = coarser
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
 * Newest transcript first. The sample is meant to be the user's *recent*
 * prompting, so the walk order has to be time order — the directory walk's own
 * order is alphabetical and would hand the scorer whatever happens to sort
 * first, which for a long-lived machine is usually a project abandoned years
 * ago. A file we can't stat sorts last rather than dropping out.
 */
async function byMtimeDesc(paths: string[]): Promise<string[]> {
  const stamped = await Promise.all(
    paths.map(async (path) => ({
      path,
      mtimeMs: await stat(path)
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    }))
  )
  return stamped.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path)
}

/**
 * Scan local Claude Code and supported IDE/agent chat transcripts.
 *
 * `includeSample` gates the raw prompt text: only the `full` consent tier
 * passes true, and the sample never touches disk here — it goes straight into
 * the upload payload the caller builds.
 */
export async function scanPromptStats(
  options: { includeSample?: boolean } = {}
): Promise<PromptStats | null> {
  const root = join(homedir(), '.claude', 'projects')
  const files = await byMtimeDesc(await findFiles(root, '.jsonl'))

  const wordCounts: number[] = []
  const activity = emptyPromptActivity()
  const samples: { text: string; at: number }[] = []
  let sampleChars = 0
  const addSample = (text: string, timestamp: string | null) => {
    if (!options.includeSample) return
    const at = timestamp ? Date.parse(timestamp) : 0
    const clipped = text.slice(0, CONVERSATION_SAMPLE_MAX_CHARS)
    const index = samples.findIndex((sample) => sample.at < at)
    samples.splice(index < 0 ? samples.length : index, 0, { text: clipped, at })
    sampleChars += clipped.length + 2
    while (samples.length > 1) {
      const oldest = samples.at(-1)
      if (
        !oldest ||
        sampleChars - (oldest.text.length + 2) < CONVERSATION_SAMPLE_MAX_CHARS
      )
        break
      sampleChars -= oldest.text.length + 2
      samples.pop()
    }
  }
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

      const at = Date.parse(String(entry.timestamp))
      if (Number.isFinite(at) && at > project.lastActiveAt) {
        project.lastActiveAt = at
      }

      const promptLine = parsePromptLine(line)
      if (promptLine) addPromptToActivity(activity, promptLine)

      addSample(text, normalizeTimestamp(entry.timestamp))
    }
  }

  const sources: Record<string, PromptActivityAggregate> = {
    claude_code: activity,
  }
  for (const source of IDE_PROMPT_SOURCES) {
    const sourceActivity = emptyPromptActivity()
    const prompts = await source.scan()
    // Reverse preserves the newest-first sample order for equal timestamps.
    for (let i = prompts.length - 1; i >= 0; i--) {
      const prompt = prompts[i]
      if (!prompt) continue
      const words = countWords(prompt.text)
      if (words === 0) continue
      wordCounts.push(words)
      if (prompt.timestamp) {
        addPromptToActivity(sourceActivity, {
          sessionId: prompt.sessionId,
          timestamp: prompt.timestamp,
          words,
        })
      }
      addSample(prompt.text, prompt.timestamp)
    }
    sources[source.id] = sourceActivity
  }

  if (wordCounts.length === 0) return null

  const bucketMax = bucketMaxFor(wordCounts)
  const stats: PromptStats = {
    totalPrompts: wordCounts.length,
    bucketMax,
    histogram: buildHistogram(wordCounts, bucketMax),
    tail: buildTail(wordCounts, bucketMax),
    projects: await resolveProjects(byProjectDir),
    activity: { ...mergePromptActivities(Object.values(sources)), sources },
  }

  if (options.includeSample && samples.length > 0) {
    stats.conversationSample = samples
      .map((sample) => sample.text)
      .join('\n\n')
      .slice(0, CONVERSATION_SAMPLE_MAX_CHARS)
  }

  return stats
}

/**
 * The `promptStats` block as the server takes it. `activity` is deliberately
 * dropped: it is local bookkeeping for the tick's incremental state, and it
 * travels under its own top-level `promptActivity` field instead.
 */
export function promptStatsPayload(
  stats: PromptStats
): Omit<PromptStats, 'activity'> {
  const { activity: _activity, ...wire } = stats
  return wire
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
  const byRepo = new Map<
    string,
    { promptCount: number; lastActiveAt: number }
  >()

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
