import { getTitle } from './belt.js'
import { formatTokens } from './scanners/util.js'
import {
  dim,
  displayWidth,
  mint,
  padEndTo,
  rankColor,
  stripControl,
  truncateToWidth,
  white,
} from './ui.js'

// The terminal hacker card. A distinct Surface Map entry from the shareable
// "CLI card" (share-card.tsx) — per-model breakdown, drops, a sparkline. See
// the design doc + DESIGN.md. Hard rules enforced here (and by card.test.ts):
// no `//` comment chrome, no em-dash, belt as a coloured band + romaji rank,
// no decorative glyphs. Render order per row is strip → truncate → colorize.
//
// This mirrors the JSON `hacker` payload from GET /api/hackers/[handle], so
// dates are ISO strings — the CLI is a thin HTTP client and must NOT import
// @hacklab/db (that would pull the server DB layer into the published package).

export type HackerCardData = {
  handle: string
  displayName: string | null
  bio: string | null
  joinedAt: string
  claimedAt: string | null
  level: number
  tokensTotal: number
  tokens30d: number
  estimatedCost: number
  rank: number | null
  topModels30d: { model: string; tokens: number; pct: number }[]
  currentStreak: number
  longestStreak: number
  activeDays30: number
  activity30: number[]
  counts: { projects: number; essays: number; drops: number; followers: number }
  recent: {
    projects: { title: string; description: string | null }[]
    essays: { title: string; publishedAt: string | null }[]
    drops: { text: string; createdAt: string }[]
  }
  links: {
    profile: string
    website: string | null
    github: string | null
    x: string | null
  }
  openToWork: boolean
}

const DESIGN_WIDTH = 68
const MIN_WIDTH = 45 // below this the fixed 30d row can't fit; wrapping is accepted

/** 8 log-scaled buckets for the 30-day sparkline. Zero renders dim, lit cells mint. */
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export type RenderCardOptions = {
  /** Terminal columns. Clamped to [MIN_WIDTH, DESIGN_WIDTH]. */
  columns?: number
  now?: Date
}

function resolveWidth(columns: number | undefined): number {
  const cols = columns ?? DESIGN_WIDTH
  return Math.max(MIN_WIDTH, Math.min(DESIGN_WIDTH, cols))
}

/** ISO string → `YYYY-MM-DD`. */
function ymd(iso: string): string {
  return iso.slice(0, 10)
}

function ageDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000))
}

/** A left segment and a right segment on one line, right-aligned to `width`. */
function justify(
  width: number,
  leftColored: string,
  rightColored: string
): string {
  const gap = Math.max(
    1,
    width - displayWidth(leftColored) - displayWidth(rightColored)
  )
  return leftColored + ' '.repeat(gap) + rightColored
}

function rule(width: number): string {
  return dim('─'.repeat(width))
}

/** `████ L32 SHINOBI` — coloured band + dim romaji rank. Belt derived from level. */
function beltBadge(level: number): string {
  const band = rankColor(level, '████')
  const label = dim(` L${level} ${getTitle(level).toUpperCase()}`)
  return band + label
}

function sparkline(values: number[]): string {
  const max = Math.max(0, ...values)
  const denom = Math.log2(max + 1)
  return values
    .map((v) => {
      if (v <= 0) return dim('▁')
      const frac = denom > 0 ? Math.log2(v + 1) / denom : 0
      const idx = Math.min(
        SPARK.length - 1,
        Math.max(0, Math.round(frac * (SPARK.length - 1)))
      )
      return mint(SPARK[idx] ?? '█')
    })
    .join('')
}

/** A `label   value` row; the label is dim, the value plain, truncated to width. */
function labelled(width: number, label: string, value: string): string {
  const head = dim(padEndTo(label, 8)) // "joined  ", "streak  ", …
  const budget = width - displayWidth(head)
  return head + truncateToWidth(value, budget)
}

/** A recent-list section: `HEADER N` then rows, or `HEADER 0   nothing yet`. */
function section(
  width: number,
  label: string,
  total: number,
  rows: string[]
): string[] {
  if (total === 0) return [dim(`${label} 0   nothing yet`)]
  return [`${label} ${total}`, ...rows.map((r) => truncateToWidth(r, width))]
}

/**
 * Projects/essays row-budget rule: ≤3 rows below the header. When more than 3
 * exist, show 2 items + `+N more`; otherwise show them all.
 */
function recentRows<T>(
  total: number,
  items: T[],
  row: (item: T) => string
): string[] {
  if (total > 3) {
    return [...items.slice(0, 2).map(row), `  +${total - 2} more`]
  }
  return items.map(row)
}

/**
 * Render the full one-screen card as an array of lines (caller joins with \n).
 * Pure: no I/O, deterministic given `now`. Every user-supplied string is passed
 * through stripControl before it reaches the terminal.
 */
export function renderCard(
  card: HackerCardData,
  opts: RenderCardOptions = {}
): string[] {
  const width = resolveWidth(opts.columns)
  const now = opts.now ?? new Date()
  const lines: string[] = []

  // Line 1 — identity + belt.
  const name = card.displayName ? ` · ${stripControl(card.displayName)}` : ''
  const identity = white(
    truncateToWidth(
      `${stripControl(card.handle)}${name}`,
      width - displayWidth(beltBadge(card.level)) - 1
    )
  )
  lines.push(justify(width, identity, beltBadge(card.level)))

  // Line 2 — bio (left) + open-to-work dot (right). Skipped when both absent.
  const bio = card.bio
    ? truncateToWidth(stripControl(card.bio), width - 16)
    : ''
  const otw = card.openToWork ? `${mint('●')} open to work` : ''
  if (bio || otw) lines.push(justify(width, bio, otw))

  lines.push(rule(width))

  // Identity block.
  const claimed = card.claimedAt
    ? `claimed ${ymd(card.claimedAt)}`
    : 'not claimed yet'
  const rank = card.rank != null ? `      rank #${card.rank}` : ''
  lines.push(
    labelled(
      width,
      'joined',
      `${ymd(card.joinedAt)} (${ageDays(card.joinedAt, now)}d)   ${claimed}${rank}`
    )
  )

  // Activity block, with the two null-state collapses.
  if (card.tokensTotal === 0) {
    lines.push(dim('no activity yet. run hacklab sync to bank the proof.'))
  } else {
    lines.push(
      labelled(
        width,
        'streak',
        `${card.currentStreak}d current · ${card.longestStreak}d longest      active ${card.activeDays30}/30d`
      )
    )
    const cost = `$${Math.round(card.estimatedCost).toLocaleString('en-US')} est. cost`
    lines.push(
      labelled(
        width,
        'tokens',
        `${formatTokens(card.tokensTotal)} burned · ${formatTokens(card.tokens30d)} last 30d · ${cost}`
      )
    )
    // Models + sparkline collapse when there's no 30-day activity.
    if (card.tokens30d > 0) {
      const models = card.topModels30d
        .slice(0, 2)
        .map((m) => `${m.model} ${m.pct}%`)
        .join(' · ')
      if (models) lines.push(labelled(width, 'models', models))
      lines.push(dim(padEndTo('30d', 8)) + sparkline(card.activity30))
    }
  }

  lines.push(rule(width))

  // Recent work.
  lines.push(
    ...section(
      width,
      'PROJECTS',
      card.counts.projects,
      recentRows(
        card.counts.projects,
        card.recent.projects,
        (p) =>
          `  ${padEndTo(truncateToWidth(stripControl(p.title), 16), 16)} ${stripControl(p.description ?? '')}`
      )
    )
  )
  lines.push(
    ...section(
      width,
      'ESSAYS',
      card.counts.essays,
      recentRows(
        card.counts.essays,
        card.recent.essays,
        (e) =>
          `  ${e.publishedAt ? ymd(e.publishedAt) : '        '}  ${stripControl(e.title)}`
      )
    )
  )
  // Drops: 1 item, no "+N more"; the count lives in the header.
  if (card.counts.drops === 0) {
    lines.push(dim('DROPS 0   nothing yet'))
  } else {
    const last = card.recent.drops[0]
    lines.push(
      `DROPS ${card.counts.drops}${last ? ` · last ${ymd(last.createdAt)}` : ''}`
    )
    if (last) {
      lines.push(truncateToWidth(`  "${stripControl(last.text)}"`, width))
    }
  }

  lines.push(rule(width))
  lines.push(dim(`--json for the full payload · hacklab.so/${card.handle}`))

  return lines
}

/**
 * The compact in-chat card (`/who`): 4 lines, no rules, no sparkline. Same
 * strip discipline. Returned as separate lines so the chat renderer can push
 * them as one Entry per row (preserving the one-row-per-entry invariant).
 */
export function renderCompact(card: HackerCardData): string[] {
  const name = card.displayName ? ` · ${stripControl(card.displayName)}` : ''
  const otw = card.openToWork ? ` · ${mint('●')} open to work` : ''
  const joined = card.claimedAt
    ? `joined ${ageDays(card.claimedAt, new Date())}d ago`
    : 'not claimed yet'
  return [
    `${white(stripControl(card.handle))}${name} · ${beltBadge(card.level)}${otw}`,
    `${formatTokens(card.tokensTotal)} tokens · ${formatTokens(card.tokens30d)}/30d · ${card.currentStreak}d streak · ${joined}`,
    `${card.counts.projects} projects · ${card.counts.essays} essays · ${card.counts.drops} drops`,
    dim(`hacklab.so/${card.handle}`),
  ]
}
