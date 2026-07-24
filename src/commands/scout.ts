import { resolveCommand } from '../resolve-command.js'
import { formatTokens } from '../scanners/util.js'
import { loadSession, type Session } from '../session.js'
import { ensureFreshSession, fetchApi, LOGIN_EXPIRED_MESSAGE } from '../sync.js'
import { bold, dim, error, hint, info, rankColor, stripControl } from '../ui.js'

// `hacklab scout` is a namespace over two products, kept together so the pair is
// obvious and neither is privileged by a bare command:
//   scout search — the client filters the pool themselves (their criteria, their
//                  ranking); flags map 1:1 to the API.
//   scout picks  — our curated shortlist, pre-ranked with a thesis per hacker.
// Subcommands resolve by shortest unambiguous prefix (shared resolveCommand), so
// `hacklab scout se` / `hacklab scout p` work. Access is gated by the API
// (key scope / grant), never by which subcommand is typed.
const SUBCOMMANDS = ['search', 'picks'] as const

// Exit-code contract for cron consumers (v2 design doc, step 4): 0 = success
// (including an empty list), 2 = auth expired/missing, 3 = not entitled,
// 1 = anything else. Errors and hints go to stderr, NEVER onto --json stdout.
const EXIT_AUTH = 2
const EXIT_NOT_ENTITLED = 3
const EXIT_OTHER = 1

const GATE_MESSAGE = 'scout is invite-only. talk to marin.'
const BROKEN_MESSAGE = "broken. we're on it."

function usage(): never {
  error('usage: hacklab scout <search|picks> [flags]')
  hint('scout search  filter the hacker pool yourself, or --json for crons')
  hint("scout picks   this week's curated shortlist")
  process.exit(EXIT_OTHER)
}

/** The `scout` namespace dispatcher: routes to search or picks. */
export async function scout(args: string[]): Promise<void> {
  const [subToken, ...rest] = args
  if (!subToken || subToken.startsWith('-')) usage()

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: scout ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(EXIT_OTHER)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: scout ${subToken}`)
    usage()
  }

  if (resolved.name === 'search') return scoutSearch(rest)
  if (resolved.name === 'picks') return scoutPicks(rest)
}

type Links = { profile: string; website: string | null; github: string | null }

type FeedHacker = {
  handle: string
  displayName: string | null
  bio: string | null
  claimedAt: string | null
  belt: string
  level: number
  tokensTotal: number
  tokens30d: number
  activeDays30: number
  counts: { projects: number; essays: number; drops: number; followers: number }
  projects: { title: string; description: string | null }[]
  links: Links
  openToWork: boolean
}

type ScoutPick = {
  position: number
  thesis: string
  handle: string
  displayName: string | null
  belt: string
  level: number
  links: Links
}

/**
 * Monday 00:00 UTC of the current week, for `--new-this-week`. Mirrors
 * @hacklab/db's mondayUtcWeekOf (the week owner for picks); duplicated here
 * because the CLI doesn't depend on the db package — this is client-side
 * sugar over the real contract param, `newSince`.
 */
export function mondayUtcStartOfWeek(now: Date): string {
  const day = now.getUTCDay()
  const daysSinceMonday = day === 0 ? 6 : day - 1
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysSinceMonday
    )
  ).toISOString()
}

export type SearchFlags = {
  json: boolean
  query: URLSearchParams
}

/** Flag→param mapping is 1:1 with the API contract; the server validates. */
export function parseSearchArgs(
  args: string[]
): SearchFlags | { usage: string } {
  const query = new URLSearchParams()
  let json = false
  let newThisWeek = false
  let newSince: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') json = true
    else if (arg === '--new-this-week') newThisWeek = true
    else if (arg === '--new-since') {
      newSince = args[++i] ?? ''
    } else if (arg === '--open-to-work') query.set('openToWork', 'true')
    else if (arg === '--sort') {
      const value = args[++i] ?? ''
      query.set('sort', value)
    } else if (arg === '--limit') {
      const value = args[++i] ?? ''
      query.set('limit', value)
    } else {
      return { usage: `unknown flag ${arg}` }
    }
  }

  if (newThisWeek && newSince !== null) {
    return { usage: 'use --new-this-week or --new-since, not both' }
  }
  if (newSince !== null) {
    if (Number.isNaN(new Date(newSince).getTime())) {
      return { usage: '--new-since must be an ISO 8601 timestamp' }
    }
    query.set('newSince', newSince)
  }
  if (newThisWeek) query.set('newSince', mondayUtcStartOfWeek(new Date()))

  return { json, query }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

async function fetchScout(
  path: string,
  json: boolean
): Promise<{ body: string; data: Record<string, unknown> } | null> {
  const stored = await loadSession()
  if (!stored) {
    error('not logged in')
    hint(`run ${dim('hacklab login')} to authenticate`)
    process.exit(EXIT_AUTH)
  }
  const session: Session = await ensureFreshSession(stored)

  let res: Response
  try {
    res = await fetchApi(session, path, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    process.exit(EXIT_OTHER)
  }

  if (res.status === 401) {
    error(LOGIN_EXPIRED_MESSAGE)
    process.exit(EXIT_AUTH)
  }
  if (res.status === 403) {
    error(GATE_MESSAGE)
    process.exit(EXIT_NOT_ENTITLED)
  }
  const body = await res.text()
  if (res.status === 400) {
    const data = parseJson(body)
    error((data?.error as string | undefined) ?? 'invalid request')
    process.exit(EXIT_OTHER)
  }
  if (!res.ok) {
    error(BROKEN_MESSAGE)
    process.exit(EXIT_OTHER)
  }

  // --json stdout purity: the server envelope, verbatim, nothing else.
  if (json) {
    process.stdout.write(`${body}\n`)
    return null
  }
  // Human path: a 200 with a non-JSON body (proxy/CDN error page) is a broken
  // upstream, not renderable — fail cleanly instead of throwing on parse.
  const data = parseJson(body)
  if (!data) {
    error(BROKEN_MESSAGE)
    process.exit(EXIT_OTHER)
  }
  return { body, data }
}

// URLs and free text reach the terminal from user-controlled columns; strip
// control chars so an embedded ANSI escape can't hijack the viewer's terminal.
function formatLinks(links: Links): string {
  return [links.profile, links.github, links.website]
    .filter((l): l is string => Boolean(l))
    .map((l) => stripControl(l).replace(/^https:\/\//, ''))
    .join(' · ')
}

function renderHacker(h: FeedHacker) {
  const name = h.displayName ? `  ${stripControl(h.displayName)}` : ''
  const otw = h.openToWork ? dim(' · open to work') : ''
  console.log(
    `  ${rankColor(h.level, `@${stripControl(h.handle)}`)}${name}  ${dim(`${h.belt} lv${h.level}`)}${otw}`
  )
  if (h.bio) console.log(dim(`  ${stripControl(h.bio)}`))
  console.log(
    dim(
      `  ${formatTokens(h.tokens30d)} tokens (30d) · ${h.activeDays30} active days · ${h.counts.projects} projects · ${h.counts.essays} essays · ${h.counts.followers} followers`
    )
  )
  const top = h.projects[0]
  if (top) {
    const desc = top.description ? `, ${stripControl(top.description)}` : ''
    console.log(dim(`  building: ${stripControl(top.title)}${desc}`))
  }
  console.log(dim(`  ${formatLinks(h.links)}`))
  console.log('')
}

async function scoutSearch(args: string[]) {
  const parsed = parseSearchArgs(args)
  if ('usage' in parsed) {
    error(parsed.usage)
    hint(
      `usage: hacklab scout search [--new-this-week | --new-since <iso>] [--open-to-work] [--sort <key>] [--limit <n>] [--json]`
    )
    process.exit(EXIT_OTHER)
  }

  const qs = parsed.query.size > 0 ? `?${parsed.query}` : ''
  const result = await fetchScout(`/api/scout/hackers${qs}`, parsed.json)
  if (!result) return

  const list = (result.data.hackers ?? []) as FeedHacker[]
  if (list.length === 0) {
    info('no hackers match. loosen the filters?')
    return
  }
  console.log('')
  console.log(bold(`  ${list.length} hacker${list.length === 1 ? '' : 's'}`))
  console.log('')
  for (const h of list) renderHacker(h)
}

async function scoutPicks(args: string[]) {
  const json = args.includes('--json')
  const unknown = args.find((a) => a !== '--json')
  if (unknown) {
    error(`unknown flag ${unknown}`)
    hint('usage: hacklab scout picks [--json]')
    process.exit(EXIT_OTHER)
  }

  const result = await fetchScout('/api/scout/picks', json)
  if (!result) return

  const picks = (result.data.picks ?? []) as ScoutPick[]
  if (picks.length === 0) {
    info('no picks yet this week. check back friday.')
    return
  }
  console.log('')
  // DESIGN.md Voice: no em-dashes in product copy (hard rule).
  console.log(bold(`  scout picks: week of ${result.data.weekOf}`))
  console.log('')
  for (const p of picks) {
    const name = p.displayName ? `  ${stripControl(p.displayName)}` : ''
    console.log(
      `  ${p.position}. ${rankColor(p.level, `@${stripControl(p.handle)}`)}${name}  ${dim(`${p.belt} lv${p.level}`)}`
    )
    console.log(`     ${stripControl(p.thesis)}`)
    console.log(dim(`     ${formatLinks(p.links)}`))
    console.log('')
  }
}
