import { readFile, writeFile } from 'node:fs/promises'

import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { resolveCommand } from '../resolve-command.js'
import type { Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, hint, info, mint, success } from '../ui.js'

// `hacklab hackathon` — RSVP, team up, and submit for a hacklab hackathon from
// the terminal. Every response from `<appUrl>/api/hackathons` is enveloped as
// `{schemaVersion:1, ...}` (errors as `{schemaVersion:1, error:{code,message}}`),
// so every subcommand relays the server's own body verbatim in `--json` mode
// instead of reshaping it — this side only picks fields out for the human
// renderers, defensively, since the exact field names are the server's call.

const SUBCOMMANDS = [
  'list',
  'view',
  'rsvp',
  'invite',
  'team',
  'track',
  'submit',
  'export',
] as const

const TEAM_SUBCOMMANDS = ['create', 'join', 'accept', 'reject', 'list'] as const

const BASE = '/api/hackathons'

function usage(): never {
  error(
    'usage: hacklab hackathon <list|view|rsvp|invite|team|track|submit|export>'
  )
  info(`  hacklab hackathon ${dim('list [--past] [--json]')}`)
  info(`  hacklab hackathon ${dim('view <slug> [--json]')}`)
  info(`  hacklab hackathon ${dim('rsvp <slug> [--token <t>] [--json]')}`)
  info(
    `  hacklab hackathon ${dim('invite <slug> --file <path> | --emails a@b.com,c@d.com [--json]')}`
  )
  info(
    `  hacklab hackathon ${dim('team create <slug> --name "X" [--summary S] [--max N] [--closed] [--json]')}`
  )
  info(`  hacklab hackathon ${dim('team join <slug> <teamSlug> [--json]')}`)
  info(
    `  hacklab hackathon ${dim('team accept|reject <slug> <teamSlug> <handle> [--json]')}`
  )
  info(`  hacklab hackathon ${dim('team list <slug> [--json]')}`)
  info(
    `  hacklab hackathon ${dim('track <slug> <teamSlug> <trackSlug> [--json]')}`
  )
  info(
    `  hacklab hackathon ${dim('submit <slug> <teamSlug> --title T --description D [--repo/--video/--site/--track] [--json]')}`
  )
  info(
    `  hacklab hackathon ${dim('export <slug> [--format csv|json] [--out <path>] [--json]')}`
  )
  process.exit(1)
}

function teamUsage(): never {
  error('usage: hacklab hackathon team <create|join|accept|reject|list>')
  info(
    `  hacklab hackathon ${dim('team create <slug> --name "X" [--summary S] [--max N] [--closed]')}`
  )
  info(`  hacklab hackathon ${dim('team join <slug> <teamSlug>')}`)
  info(
    `  hacklab hackathon ${dim('team accept|reject <slug> <teamSlug> <handle>')}`
  )
  info(`  hacklab hackathon ${dim('team list <slug>')}`)
  process.exit(1)
}

function printJson(data: unknown): void {
  console.log(
    JSON.stringify({ schemaVersion: 1, ...(data as object) }, null, 2)
  )
}

/** Pull `--flag <value>` out of argv; returns the value and the rest (mirrors org.ts's extractOption). */
function extractFlag(
  args: string[],
  name: string
): { value: string | undefined; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i]
      continue
    }
    rest.push(args[i]!)
  }
  return { value, rest }
}

async function apiGet(session: Session, path: string): Promise<Response> {
  return fetchApi(session, path, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
}

async function apiPost(
  session: Session,
  path: string,
  body: unknown
): Promise<Response> {
  return fetchApi(session, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(body),
  })
}

type JsonError = {
  schemaVersion?: number
  error?: { code?: string; message?: string }
}

/** Generic non-2xx handling: relay the server envelope verbatim in --json, apiErrorMessage in human mode. */
async function handleApiError(
  res: Response,
  json: boolean,
  session: Session
): Promise<never> {
  const body = (await res.json().catch(() => null)) as JsonError | null
  if (json) {
    console.log(
      JSON.stringify(
        body ?? {
          schemaVersion: 1,
          error: { code: 'error', message: `failed (${res.status})` },
        }
      )
    )
    process.exit(1)
  }
  error(apiErrorMessage(res.status, body ?? null, session))
  process.exit(1)
}

/**
 * rsvp gets its own error path. The two refusals a real person actually hits
 * are "you are not on the list" and "your address does not match the one you
 * were invited under", and both are resolved by the organizer rather than by
 * retrying, so each gets a hint pointing there.
 */
async function handleRsvpError(
  res: Response,
  json: boolean,
  session: Session
): Promise<never> {
  const body = (await res.json().catch(() => null)) as JsonError | null
  if (json) {
    console.log(
      JSON.stringify(
        body ?? {
          schemaVersion: 1,
          error: { code: 'error', message: `failed (${res.status})` },
        }
      )
    )
    process.exit(1)
  }
  if (body?.error?.code === 'not_invited' && body.error.message) {
    error(body.error.message)
    hint('ask the organizer to add this address, or your @handle, to the list.')
    process.exit(1)
  }
  // A link alone never admits anyone: the address has to match too.
  if (body?.error?.code === 'email_mismatch' && body.error.message) {
    error(body.error.message)
    hint(`you are signed in as ${session.email}.`)
    hint('ask the organizer to add that address, or your @handle, to the list.')
    process.exit(1)
  }
  error(apiErrorMessage(res.status, body ?? null, session))
  process.exit(1)
}

async function networkFail(err: unknown, json: boolean): Promise<never> {
  const message = err instanceof Error ? err.message : String(err)
  if (json) emitJsonError('network', message)
  error(message)
  process.exit(1)
}

// ── list / view rendering ────────────────────────────────────────────────

type HackathonRecord = Record<string, unknown> & { slug: string; title: string }

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function formatDate(value: unknown): string {
  const raw = str(value)
  if (!raw) return '(tbd)'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatDateRange(start: unknown, end: unknown): string {
  const s = str(start)
  const e = str(end)
  if (!s && !e) return '(dates tbd)'
  const fmt = (v: string) => {
    const d = new Date(v)
    return Number.isNaN(d.getTime())
      ? v
      : d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
  }
  if (s && e) return `${fmt(s)} – ${fmt(e)}`
  if (s) return `from ${fmt(s)}`
  return `until ${fmt(e as string)}`
}

type DeadlineRow = { label: string; at: string | null }

// Field names aren't finalized on the server yet — check a `deadlines` object
// first, then fall back to flat fields, and accept a couple of aliases per
// deadline so this doesn't break on the first naming choice the API ships with.
function pickDeadlines(h: HackathonRecord): DeadlineRow[] {
  const source = (
    typeof h.deadlines === 'object' && h.deadlines !== null ? h.deadlines : h
  ) as Record<string, unknown>
  const specs: { label: string; keys: string[] }[] = [
    {
      label: 'RSVP closes',
      keys: ['rsvpClosesAt', 'rsvpCloses', 'rsvpDeadline'],
    },
    { label: 'teams lock', keys: ['teamsLockAt', 'teamLockAt', 'teamsLock'] },
    {
      label: 'tracks lock',
      keys: ['tracksLockAt', 'trackLockAt', 'tracksLock'],
    },
    {
      label: 'submissions due',
      keys: ['submissionsDueAt', 'submissionDeadline', 'submissionsDue'],
    },
  ]
  return specs.map(({ label, keys }) => {
    const key = keys.find((k) => typeof source[k] === 'string')
    return { label, at: key ? (source[key] as string) : null }
  })
}

function nextDeadline(
  rows: DeadlineRow[],
  now = new Date()
): DeadlineRow | null {
  const upcoming = rows
    .filter((r): r is { label: string; at: string } => {
      if (!r.at) return false
      const t = new Date(r.at).getTime()
      return !Number.isNaN(t) && t > now.getTime()
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return upcoming[0] ?? null
}

function renderHackathon(h: HackathonRecord): string[] {
  const lines: string[] = []
  lines.push(`  ${bold(h.title)} ${dim(`(${h.slug})`)}`)
  const phase = str(h.phase)
  if (phase) lines.push(`  ${dim('phase')}   ${phase}`)
  lines.push(`  ${dim('dates')}   ${formatDateRange(h.startsAt, h.endsAt)}`)
  lines.push('')

  const rows = pickDeadlines(h)
  const next = nextDeadline(rows)
  const width = Math.max(...rows.map((r) => r.label.length))
  for (const row of rows) {
    const line = `  ${dim(row.label.padEnd(width))}  ${formatDate(row.at)}`
    lines.push(
      row === next || (next && row.label === next.label)
        ? `${line}  ${mint('← next')}`
        : line
    )
  }
  return lines
}

// ── list ──────────────────────────────────────────────────────────────────

async function hackathonList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const past = args.includes('--past')
  const session = await requireSession(json)

  let res: Response
  try {
    res = await apiGet(session, `${BASE}${past ? '?view=past' : ''}`)
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as {
    hackathons?: HackathonRecord[]
  } | null
  if (!body?.hackathons) {
    if (json) return emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  if (json) {
    printJson(body)
    return
  }

  if (body.hackathons.length === 0) {
    info(past ? 'no past hackathons' : 'no upcoming hackathons')
    return
  }

  const width = Math.max(...body.hackathons.map((h) => h.slug.length))
  for (const h of body.hackathons) {
    const dates = formatDateRange(h.startsAt, h.endsAt)
    const phase = str(h.phase)
    console.log(
      `  ${bold(h.slug.padEnd(width))}  ${h.title}  ${dim(dates)}${phase ? `  ${dim(`[${phase}]`)}` : ''}`
    )
  }
}

// ── view ──────────────────────────────────────────────────────────────────

async function hackathonView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    if (json)
      return emitJsonError('usage', 'usage: hacklab hackathon view <slug>')
    error('usage: hacklab hackathon view <slug>')
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiGet(session, `${BASE}/${encodeURIComponent(slug)}`)
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as {
    hackathon?: HackathonRecord
  } | null
  if (!body?.hackathon) {
    if (json) return emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  if (json) {
    printJson(body)
    return
  }
  console.log(renderHackathon(body.hackathon).join('\n'))
}

// ── rsvp ──────────────────────────────────────────────────────────────────

async function hackathonRsvp(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: token, rest } = extractFlag(
    args.filter((a) => a !== '--json'),
    '--token'
  )
  const slug = rest.find((a) => !a.startsWith('-'))
  if (!slug) {
    if (json) {
      return emitJsonError(
        'usage',
        'usage: hacklab hackathon rsvp <slug> [--token <t>]'
      )
    }
    error('usage: hacklab hackathon rsvp <slug> [--token <t>]')
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/rsvp`,
      token ? { token } : {}
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleRsvpError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { rsvped: true })
    return
  }
  success(`you're in — RSVPed to ${slug}`)
}

// ── invite ────────────────────────────────────────────────────────────────

async function hackathonInvite(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const filtered = args.filter((a) => a !== '--json')
  const { value: filePath, rest: r1 } = extractFlag(filtered, '--file')
  const { value: emailsRaw, rest } = extractFlag(r1, '--emails')
  const slug = rest.find((a) => !a.startsWith('-'))

  if (!slug) {
    const message =
      'usage: hacklab hackathon invite <slug> --file <path> | --emails a@b.com,c@d.com'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }
  if (!filePath && !emailsRaw) {
    const message = 'pass --file <path> or --emails a@b.com,c@d.com'
    if (json) return emitJsonError('invalid_args', message)
    error(message)
    process.exit(1)
  }
  if (filePath && emailsRaw) {
    const message = 'use either --file or --emails, not both'
    if (json) return emitJsonError('invalid_args', message)
    error(message)
    process.exit(1)
  }

  let body: { text: string } | { emails: string[] }
  if (filePath) {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const message =
        code === 'ENOENT'
          ? `file not found: ${filePath}`
          : `could not read ${filePath}`
      if (json) return emitJsonError('read_failed', message)
      error(message)
      process.exit(1)
    }
    body = { text }
  } else {
    const emails = (emailsRaw as string)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
    body = { emails }
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/invites`,
      body
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const data = (await res.json().catch(() => null)) as {
    invited?: number
    skipped?: number
    rejected?: (string | { line?: string; reason?: string })[]
  } | null
  if (json) {
    printJson(data ?? { invited: 0, skipped: 0, rejected: [] })
    return
  }

  const invited = data?.invited ?? 0
  const skipped = data?.skipped ?? 0
  success(`invited ${invited}${skipped ? `, skipped ${skipped}` : ''}`)

  const rejected = data?.rejected ?? []
  if (rejected.length > 0) {
    error(
      `rejected ${rejected.length} line${rejected.length === 1 ? '' : 's'}:`
    )
    for (const r of rejected) {
      if (typeof r === 'string') console.log(`    ${r}`)
      else {
        console.log(
          `    ${r.line ?? '(unknown)'}${r.reason ? dim(` — ${r.reason}`) : ''}`
        )
      }
    }
  }
}

// ── team ──────────────────────────────────────────────────────────────────

async function teamCreate(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const closed = args.includes('--closed')
  let rest = args.filter((a) => a !== '--json' && a !== '--closed')
  const { value: name, rest: r1 } = extractFlag(rest, '--name')
  const { value: summary, rest: r2 } = extractFlag(r1, '--summary')
  const { value: maxRaw, rest: r3 } = extractFlag(r2, '--max')
  rest = r3
  const slug = rest.find((a) => !a.startsWith('-'))

  if (!slug) {
    const message = 'usage: hacklab hackathon team create <slug> --name "X"'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }
  if (!name) {
    const message = 'pass --name "Team Name"'
    if (json) return emitJsonError('invalid_args', message)
    error(message)
    process.exit(1)
  }

  let maxSize: number | undefined
  if (maxRaw !== undefined) {
    const n = Number(maxRaw)
    if (!Number.isInteger(n) || n < 1) {
      const message = '--max must be a positive whole number'
      if (json) return emitJsonError('invalid_args', message)
      error(message)
      process.exit(1)
    }
    maxSize = n
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(session, `${BASE}/${encodeURIComponent(slug)}/teams`, {
      name,
      summary: summary || undefined,
      maxSize,
      closed: closed || undefined,
    })
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { created: true })
    return
  }
  success(`created team ${bold(name)}`)
}

async function teamJoin(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('-'))
  const [slug, teamSlug] = positional
  if (!slug || !teamSlug) {
    const message = 'usage: hacklab hackathon team join <slug> <teamSlug>'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/teams/${encodeURIComponent(teamSlug)}/requests`,
      { action: 'request' }
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { requested: true })
    return
  }
  success(`requested to join ${bold(teamSlug)}`)
}

async function teamRequestAction(
  args: string[],
  action: 'accept' | 'reject'
): Promise<void> {
  const json = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('-'))
  const [slug, teamSlug, handle] = positional
  if (!slug || !teamSlug || !handle) {
    const message = `usage: hacklab hackathon team ${action} <slug> <teamSlug> <handle>`
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/teams/${encodeURIComponent(teamSlug)}/requests`,
      { action, applicantHandle: handle }
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { [action + 'ed']: true })
    return
  }
  success(`${action === 'accept' ? 'accepted' : 'rejected'} ${bold(handle)}`)
}

async function teamList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) {
    const message = 'usage: hacklab hackathon team list <slug>'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiGet(session, `${BASE}/${encodeURIComponent(slug)}/teams`)
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as {
    teams?: Record<string, unknown>[]
  } | null
  if (!body?.teams) {
    if (json) return emitJsonError('bad_response', 'malformed response')
    error('got a malformed response from hacklab')
    process.exit(1)
  }

  if (json) {
    printJson(body)
    return
  }
  if (body.teams.length === 0) {
    info('no teams yet')
    return
  }
  for (const t of body.teams) {
    const name = str(t.name) ?? str(t.slug) ?? '(unnamed)'
    const teamSlug = str(t.slug)
    const closedTag = t.closed ? dim(' [closed]') : ''
    console.log(
      `  ${bold(name)}${teamSlug ? ` ${dim(`(${teamSlug})`)}` : ''}${closedTag}`
    )
  }
}

async function hackathonTeam(args: string[]): Promise<void> {
  const [subToken, ...rest] = args
  if (!subToken) teamUsage()

  const resolved = resolveCommand(subToken, TEAM_SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(
      `ambiguous: hackathon team ${subToken} (${resolved.matches.join(', ')})`
    )
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: hackathon team ${subToken}`)
    teamUsage()
  }

  if (resolved.name === 'create') return teamCreate(rest)
  if (resolved.name === 'join') return teamJoin(rest)
  if (resolved.name === 'accept') return teamRequestAction(rest, 'accept')
  if (resolved.name === 'reject') return teamRequestAction(rest, 'reject')
  if (resolved.name === 'list') return teamList(rest)
}

// ── track ─────────────────────────────────────────────────────────────────

async function hackathonTrack(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('-'))
  const [slug, teamSlug, trackSlug] = positional
  if (!slug || !teamSlug || !trackSlug) {
    const message =
      'usage: hacklab hackathon track <slug> <teamSlug> <trackSlug>'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/teams/${encodeURIComponent(teamSlug)}/track`,
      { trackSlug }
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { track: trackSlug })
    return
  }
  success(`set ${bold(teamSlug)}'s track to ${bold(trackSlug)}`)
}

// ── submit ────────────────────────────────────────────────────────────────

async function hackathonSubmit(args: string[]): Promise<void> {
  const json = args.includes('--json')
  let rest = args.filter((a) => a !== '--json')
  const { value: title, rest: r1 } = extractFlag(rest, '--title')
  const { value: description, rest: r2 } = extractFlag(r1, '--description')
  const { value: repo, rest: r3 } = extractFlag(r2, '--repo')
  const { value: video, rest: r4 } = extractFlag(r3, '--video')
  const { value: site, rest: r5 } = extractFlag(r4, '--site')
  const { value: track, rest: r6 } = extractFlag(r5, '--track')
  rest = r6
  const [slug, teamSlug] = rest.filter((a) => !a.startsWith('-'))

  if (!slug || !teamSlug) {
    const message =
      'usage: hacklab hackathon submit <slug> <teamSlug> --title T --description D'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }
  if (!title || !description) {
    const message = 'pass --title and --description'
    if (json) return emitJsonError('invalid_args', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiPost(
      session,
      `${BASE}/${encodeURIComponent(slug)}/teams/${encodeURIComponent(teamSlug)}/submission`,
      {
        title,
        description,
        repoUrl: repo || undefined,
        videoUrl: video || undefined,
        siteUrl: site || undefined,
        trackSlug: track || undefined,
      }
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (json) {
    printJson(body ?? { submitted: true })
    return
  }
  success(`submitted ${bold(title)} for ${bold(teamSlug)}`)
}

// ── export ────────────────────────────────────────────────────────────────

async function hackathonExport(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const filtered = args.filter((a) => a !== '--json')
  const { value: formatFlag, rest: r1 } = extractFlag(filtered, '--format')
  const { value: out, rest } = extractFlag(r1, '--out')
  const slug = rest.find((a) => !a.startsWith('-'))

  if (!slug) {
    const message =
      'usage: hacklab hackathon export <slug> [--format csv|json] [--out <path>]'
    if (json) return emitJsonError('usage', message)
    error(message)
    process.exit(1)
  }

  const format = formatFlag ?? (json ? 'json' : 'csv')
  if (format !== 'csv' && format !== 'json') {
    const message = '--format must be csv or json'
    if (json) return emitJsonError('invalid_args', message)
    error(message)
    process.exit(1)
  }

  const session = await requireSession(json)
  let res: Response
  try {
    res = await apiGet(
      session,
      `${BASE}/${encodeURIComponent(slug)}/export?format=${format}`
    )
  } catch (err) {
    return networkFail(err, json)
  }
  if (!res.ok) return handleApiError(res, json, session)

  const text = await res.text()

  if (out) {
    await writeFile(out, text, 'utf8')
    if (json) {
      printJson({ wrote: out, format, bytes: Buffer.byteLength(text, 'utf8') })
      return
    }
    info(
      'this file contains participants’ personal data — handle it carefully.'
    )
    success(`wrote ${format} export to ${out}`)
    return
  }

  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

// ── dispatch ──────────────────────────────────────────────────────────────

export async function hackathon(args: string[] = []): Promise<void> {
  const [subToken, ...rest] = args

  // Bare `hacklab hackathon` (or a lone `--json`) is a safe read-only default:
  // list the events, same spirit as `hacklab org`/`hacklab hacker`'s bare mode.
  if (!subToken || subToken.startsWith('-')) {
    return hackathonList(args)
  }

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: hackathon ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: hackathon ${subToken}`)
    usage()
  }

  if (resolved.name === 'list') return hackathonList(rest)
  if (resolved.name === 'view') return hackathonView(rest)
  if (resolved.name === 'rsvp') return hackathonRsvp(rest)
  if (resolved.name === 'invite') return hackathonInvite(rest)
  if (resolved.name === 'team') return hackathonTeam(rest)
  if (resolved.name === 'track') return hackathonTrack(rest)
  if (resolved.name === 'submit') return hackathonSubmit(rest)
  if (resolved.name === 'export') return hackathonExport(rest)
}
