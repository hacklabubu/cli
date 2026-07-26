import { readFile } from 'node:fs/promises'

import {
  apiErrorMessage,
  emitJsonError,
  requireSession,
} from '../api-client.js'
import { captureEvent } from '../posthog.js'
import { resolveCommand } from '../resolve-command.js'
import type { Session } from '../session.js'
import { resolveAppUrl } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info, success } from '../ui.js'

const EVENTS_PATH = '/api/events'

const USAGE = `usage:
  hacklab event add --title <title> --start <iso> --end <iso> --timezone <iana> [options]
  hacklab event going <event> [--status going|looking|solo] [--json]
  hacklab event hackers <event> [--json]
  hacklab event teams <event> [--json]
  hacklab event team create <event> --name <name> [options]
  hacklab event team view|request|leave <event> <team> [--json]
  hacklab event team accept|reject <event> <team> <handle> [--json]

event add options:
  --summary <text>             short event summary
  --description <markdown>     long-form event details
  --description-file <path>    read long-form details from a file
  --location <text>            venue, city, or online
  --url <url>                  external event website
  --image <url>                event cover image
  --org <slug>                 publish for an organization you control
  --slug <slug>                override the title-derived URL slug
  --json                       machine-readable output

team create options:
  --name <name>                team name (required)
  --slug <slug>                override the team URL slug
  --summary <text>             short recruiting pitch
  --readme <markdown>          team profile README
  --readme-file <path>         read team README from a file
  --avatar <url>               square PNG, JPG, or WebP image URL
  --max-members <2-10>         team capacity (default: 4)
  --closed                     create without accepting requests
  --json                       machine-readable output`

const EVENT_SUBCOMMANDS = ['add', 'going', 'hackers', 'teams', 'team'] as const
const TEAM_SUBCOMMANDS = [
  'create',
  'view',
  'request',
  'accept',
  'reject',
  'leave',
] as const

type EventDraft = {
  title: string
  slug: string
  summary?: string
  description?: string
  descriptionFile?: string
  startsAt: string
  endsAt: string
  timezone: string
  location?: string
  url?: string
  imageUrl?: string
  organizerOrgSlug?: string
  json: boolean
}

export class EventInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function httpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function eventSlugFromTitle(title: string) {
  return title
    .replace(/[Łł]/g, 'l')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '')
}

function flagValue(args: string[], index: number, flag: string) {
  const current = args[index] ?? ''
  if (current.startsWith(`${flag}=`)) {
    return { value: current.slice(flag.length + 1), consumed: 0 }
  }
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new EventInputError('missing_value', `${flag} requires a value`)
  }
  return { value, consumed: 1 }
}

export function parseEventAddArgs(args: string[]): EventDraft {
  const values: Record<string, string> = {}
  let json = false
  const supported = new Map([
    ['--title', 'title'],
    ['--slug', 'slug'],
    ['--summary', 'summary'],
    ['--description', 'description'],
    ['--description-file', 'descriptionFile'],
    ['--start', 'startsAt'],
    ['--end', 'endsAt'],
    ['--timezone', 'timezone'],
    ['--location', 'location'],
    ['--url', 'url'],
    ['--image', 'imageUrl'],
    ['--org', 'organizerOrgSlug'],
  ])

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--json') {
      json = true
      continue
    }

    const flag = [...supported.keys()].find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`)
    )
    if (!flag) {
      throw new EventInputError('unknown_argument', `unknown argument: ${arg}`)
    }
    const { value, consumed } = flagValue(args, i, flag)
    const field = supported.get(flag)
    if (!field) {
      throw new EventInputError('unknown_argument', `unknown argument: ${arg}`)
    }
    values[field] = value.trim()
    i += consumed
  }

  const title = values.title
  const rawStart = values.startsAt
  const rawEnd = values.endsAt
  const eventTimezone = values.timezone
  if (!title) throw new EventInputError('missing_field', '--title is required')
  if (!rawStart)
    throw new EventInputError('missing_field', '--start is required')
  if (!rawEnd) throw new EventInputError('missing_field', '--end is required')
  if (!eventTimezone)
    throw new EventInputError('missing_field', '--timezone is required')

  if (values.description && values.descriptionFile) {
    throw new EventInputError(
      'conflicting_flags',
      'use --description or --description-file, not both'
    )
  }

  const startsAt = new Date(rawStart)
  const endsAt = new Date(rawEnd)
  if (Number.isNaN(startsAt.getTime())) {
    throw new EventInputError('invalid_start', '--start must be an ISO date')
  }
  if (Number.isNaN(endsAt.getTime())) {
    throw new EventInputError('invalid_end', '--end must be an ISO date')
  }
  if (endsAt <= startsAt) {
    throw new EventInputError('invalid_range', '--end must be after --start')
  }
  if (!validTimezone(eventTimezone)) {
    throw new EventInputError(
      'invalid_timezone',
      '--timezone must be an IANA timezone such as Europe/Warsaw'
    )
  }
  if (values.url && !httpUrl(values.url)) {
    throw new EventInputError('invalid_url', '--url must use http or https')
  }
  if (values.imageUrl && !httpUrl(values.imageUrl)) {
    throw new EventInputError('invalid_image', '--image must use http or https')
  }

  const slug = values.slug || eventSlugFromTitle(title)
  if (!slug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new EventInputError(
      'invalid_slug',
      '--slug must use lowercase letters, numbers, and hyphens only'
    )
  }

  return {
    title,
    slug,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timezone: eventTimezone,
    ...(values.summary ? { summary: values.summary } : {}),
    ...(values.description ? { description: values.description } : {}),
    ...(values.descriptionFile
      ? { descriptionFile: values.descriptionFile }
      : {}),
    ...(values.location ? { location: values.location } : {}),
    ...(values.url ? { url: values.url } : {}),
    ...(values.imageUrl ? { imageUrl: values.imageUrl } : {}),
    ...(values.organizerOrgSlug
      ? { organizerOrgSlug: values.organizerOrgSlug }
      : {}),
    json,
  }
}

function fail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  info(USAGE)
  process.exit(1)
}

async function eventAdd(args: string[]): Promise<void> {
  const json = args.includes('--json')
  let draft: EventDraft
  try {
    draft = parseEventAddArgs(args)
  } catch (cause) {
    if (cause instanceof EventInputError) {
      fail(json, cause.code, cause.message)
    }
    throw cause
  }

  if (draft.descriptionFile) {
    try {
      draft.description = await readFile(draft.descriptionFile, 'utf8')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      fail(draft.json, 'description_file_failed', message)
    }
  }

  const session = await requireSession(draft.json)
  const { descriptionFile: _descriptionFile, json: _json, ...payload } = draft
  const response = await fetchApi(session, EVENTS_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(payload),
  })
  const body = (await response.json().catch(() => null)) as {
    schemaVersion?: number
    created?: boolean
    event?: { slug: string; title: string; path: string }
    error?: { code?: string; message?: string }
  } | null

  if (!response.ok || !body?.event) {
    const message = apiErrorMessage(response.status, body, session)
    if (draft.json) {
      emitJsonError(body?.error?.code ?? 'request_failed', message)
    }
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle ?? session.email, 'cli_event_upserted', {
    created: Boolean(body.created),
    organized_by_org: Boolean(draft.organizerOrgSlug),
  })

  if (draft.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }

  success(body.created ? 'event published.' : 'event updated.')
  info(
    `${bold(body.event.title)} · ${dim(`${resolveAppUrl(session)}${body.event.path}`)}`
  )
}

type ParsedArgs = {
  flags: Record<string, string>
  positionals: string[]
  json: boolean
  closed: boolean
}

function parseArgs(
  args: string[],
  valueFlags: readonly string[] = []
): ParsedArgs {
  const flags: Record<string, string> = {}
  const positionals: string[] = []
  let json = false
  let closed = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--closed') {
      closed = true
      continue
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const flag = valueFlags.find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`)
    )
    if (!flag) {
      throw new EventInputError('unknown_argument', `unknown argument: ${arg}`)
    }
    const { value, consumed } = flagValue(args, i, flag)
    flags[flag] = value.trim()
    i += consumed
  }

  return { flags, positionals, json, closed }
}

function requirePositionals(parsed: ParsedArgs, count: number, usage: string) {
  if (parsed.positionals.length !== count) {
    fail(parsed.json, 'usage', usage)
  }
}

async function callEventApi(
  session: Session,
  json: boolean,
  path: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchApi(session, path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${session.token}`,
        ...init?.headers,
      },
    })
  } catch (cause) {
    fail(
      json,
      'network',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!response.ok || !body) {
    const envelope = body as {
      error?: { code?: string; message?: string }
    } | null
    const message = apiErrorMessage(response.status, envelope, session)
    if (json) emitJsonError(envelope?.error?.code ?? 'request_failed', message)
    error(message)
    process.exit(1)
  }
  return body
}

function printJsonOrSuccess(
  body: Record<string, unknown>,
  json: boolean,
  message: string
) {
  if (json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  success(message)
}

async function eventGoing(args: string[]) {
  const parsed = parseArgs(args, ['--status'])
  requirePositionals(
    parsed,
    1,
    'usage: hacklab event going <event> [--status going|looking|solo] [--json]'
  )
  const status = parsed.flags['--status'] ?? 'going'
  if (!['going', 'looking', 'solo'].includes(status)) {
    fail(
      parsed.json,
      'invalid_status',
      '--status must be going, looking, or solo'
    )
  }
  const preference = status === 'going' ? 'undecided' : status
  const session = await requireSession(parsed.json)
  const [eventSlug] = parsed.positionals
  if (!eventSlug) fail(parsed.json, 'usage', 'event slug is required')
  const body = await callEventApi(
    session,
    parsed.json,
    `/api/events/${encodeURIComponent(eventSlug)}/participants`,
    { method: 'POST', body: JSON.stringify({ teamPreference: preference }) }
  )
  printJsonOrSuccess(body, parsed.json, `event status set to ${status}.`)
}

async function eventHackers(args: string[]) {
  const parsed = parseArgs(args)
  requirePositionals(parsed, 1, 'usage: hacklab event hackers <event> [--json]')
  const session = await requireSession(parsed.json)
  const [eventSlug] = parsed.positionals
  if (!eventSlug) fail(parsed.json, 'usage', 'event slug is required')
  const body = await callEventApi(
    session,
    parsed.json,
    `/api/events/${encodeURIComponent(eventSlug)}/participants`
  )
  if (parsed.json) return console.log(JSON.stringify(body, null, 2))
  const participants = (body.participants ?? []) as Array<{
    teamPreference: string
    hacker: {
      displayName: string
      handle: string
      level: number
      title: string
    }
    team: { name: string } | null
  }>
  if (participants.length === 0) return info('no hackers are going yet.')
  for (const participant of participants) {
    const state = participant.team?.name ?? participant.teamPreference
    console.log(
      `  ${bold(participant.hacker.displayName)} ${dim(`@${participant.hacker.handle} · L${participant.hacker.level} ${participant.hacker.title} · ${state}`)}`
    )
  }
}

async function eventTeams(args: string[]) {
  const parsed = parseArgs(args)
  requirePositionals(parsed, 1, 'usage: hacklab event teams <event> [--json]')
  const session = await requireSession(parsed.json)
  const [eventSlug] = parsed.positionals
  if (!eventSlug) fail(parsed.json, 'usage', 'event slug is required')
  const body = await callEventApi(
    session,
    parsed.json,
    `/api/events/${encodeURIComponent(eventSlug)}/teams`
  )
  if (parsed.json) return console.log(JSON.stringify(body, null, 2))
  const teams = (body.teams ?? []) as Array<{
    name: string
    slug: string
    availability: string
    memberCount: number
    maxMembers: number
    summary: string | null
  }>
  if (teams.length === 0) return info('no teams have formed yet.')
  for (const team of teams) {
    console.log(
      `  ${bold(team.name)} ${dim(`${team.memberCount}/${team.maxMembers} · ${team.availability} · ${team.slug}`)}`
    )
    if (team.summary) console.log(`    ${dim(team.summary)}`)
  }
}

async function eventTeamCreate(args: string[]) {
  const parsed = parseArgs(args, [
    '--name',
    '--slug',
    '--summary',
    '--readme',
    '--readme-file',
    '--avatar',
    '--max-members',
  ])
  requirePositionals(
    parsed,
    1,
    'usage: hacklab event team create <event> --name <name> [options]'
  )
  const name = parsed.flags['--name']
  if (!name) fail(parsed.json, 'missing_field', '--name is required')
  if (parsed.flags['--readme'] && parsed.flags['--readme-file']) {
    fail(
      parsed.json,
      'conflicting_flags',
      'use --readme or --readme-file, not both'
    )
  }
  const maxMembers = Number(parsed.flags['--max-members'] ?? 4)
  if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 10) {
    fail(parsed.json, 'invalid_max_members', '--max-members must be 2-10')
  }
  const avatarUrl = parsed.flags['--avatar']
  if (avatarUrl && !httpUrl(avatarUrl)) {
    fail(parsed.json, 'invalid_avatar', '--avatar must use http or https')
  }
  let readme = parsed.flags['--readme']
  const readmeFile = parsed.flags['--readme-file']
  if (readmeFile) {
    try {
      readme = await readFile(readmeFile, 'utf8')
    } catch (cause) {
      fail(
        parsed.json,
        'readme_file_failed',
        cause instanceof Error ? cause.message : String(cause)
      )
    }
  }
  const session = await requireSession(parsed.json)
  const [eventSlug] = parsed.positionals
  if (!eventSlug) fail(parsed.json, 'usage', 'event slug is required')
  const body = await callEventApi(
    session,
    parsed.json,
    `/api/events/${encodeURIComponent(eventSlug)}/teams`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(parsed.flags['--slug'] ? { slug: parsed.flags['--slug'] } : {}),
        ...(parsed.flags['--summary']
          ? { summary: parsed.flags['--summary'] }
          : {}),
        ...(readme ? { readme } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        maxMembers,
        recruitingStatus: parsed.closed ? 'closed' : 'open',
      }),
    }
  )
  const team = body.team as { name?: string; path?: string } | undefined
  printJsonOrSuccess(
    body,
    parsed.json,
    `team ${team?.name ?? name} created${team?.path ? ` · ${resolveAppUrl(session)}${team.path}` : '.'}`
  )
}

async function eventTeamReadOrWrite(
  action: Exclude<(typeof TEAM_SUBCOMMANDS)[number], 'create'>,
  args: string[]
) {
  const parsed = parseArgs(args)
  const needsHandle = action === 'accept' || action === 'reject'
  requirePositionals(
    parsed,
    needsHandle ? 3 : 2,
    `usage: hacklab event team ${action} <event> <team>${needsHandle ? ' <handle>' : ''} [--json]`
  )
  const [eventSlug, teamSlug, handle] = parsed.positionals as [
    string,
    string,
    string | undefined,
  ]
  const session = await requireSession(parsed.json)
  const base = `/api/events/${encodeURIComponent(eventSlug)}/teams/${encodeURIComponent(teamSlug)}`
  let path = base
  let init: RequestInit | undefined
  if (action === 'request') {
    path = `${base}/requests`
    init = { method: 'POST', body: JSON.stringify({ action: 'request' }) }
  } else if (action === 'accept' || action === 'reject') {
    path = `${base}/requests`
    init = {
      method: 'POST',
      body: JSON.stringify({ action, applicantHandle: handle }),
    }
  } else if (action === 'leave') {
    path = `${base}/leave`
    init = { method: 'POST' }
  }
  const body = await callEventApi(session, parsed.json, path, init)
  if (parsed.json) return console.log(JSON.stringify(body, null, 2))
  if (action === 'view') {
    const team = body.team as {
      name: string
      summary: string | null
      memberCount: number
      maxMembers: number
      availability: string
      members: Array<{ displayName: string; handle: string }>
    }
    console.log(
      `${bold(team.name)} ${dim(`${team.memberCount}/${team.maxMembers} · ${team.availability}`)}`
    )
    if (team.summary) console.log(dim(team.summary))
    for (const member of team.members) {
      console.log(`  ${member.displayName} ${dim(`@${member.handle}`)}`)
    }
    return
  }
  success(
    action === 'request'
      ? 'join request sent.'
      : action === 'leave'
        ? 'left team.'
        : `request ${action === 'accept' ? 'accepted' : 'rejected'}.`
  )
}

async function eventTeam(args: string[]) {
  const [token, ...rest] = args
  const json = args.includes('--json')
  if (!token) fail(json, 'usage', 'usage: hacklab event team <command>')
  const resolved = resolveCommand(token, TEAM_SUBCOMMANDS)
  if (resolved.kind !== 'match') {
    fail(
      json,
      resolved.kind === 'ambiguous' ? 'ambiguous_command' : 'unknown_command',
      resolved.kind === 'ambiguous'
        ? `ambiguous team command: ${token} (${resolved.matches.join(', ')})`
        : `unknown team command: ${token}`
    )
  }
  if (resolved.name === 'create') return eventTeamCreate(rest)
  return eventTeamReadOrWrite(
    resolved.name as Exclude<(typeof TEAM_SUBCOMMANDS)[number], 'create'>,
    rest
  )
}

export async function event(args: string[]): Promise<void> {
  const [token, ...rest] = args
  const json = args.includes('--json')
  if (!token) fail(json, 'usage', USAGE)
  const resolved = resolveCommand(token, EVENT_SUBCOMMANDS)
  if (resolved.kind !== 'match') {
    fail(
      json,
      resolved.kind === 'ambiguous' ? 'ambiguous_command' : 'unknown_command',
      resolved.kind === 'ambiguous'
        ? `ambiguous event command: ${token} (${resolved.matches.join(', ')})`
        : `unknown event command: ${token}`
    )
  }
  if (resolved.name === 'add') return eventAdd(rest)
  if (resolved.name === 'going') return eventGoing(rest)
  if (resolved.name === 'hackers') return eventHackers(rest)
  if (resolved.name === 'teams') return eventTeams(rest)
  return eventTeam(rest)
}
