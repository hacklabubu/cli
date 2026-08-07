import { emitJsonError, requireSession } from '../api-client.js'
import { resolveCommand } from '../resolve-command.js'
import { resolveAppUrl, type Session, unauthorizedHint } from '../session.js'
import {
  bold,
  dim,
  displayWidth,
  error,
  info,
  padEndTo,
  stripControl,
} from '../ui.js'

// `hacklab jobs [list|view]` — the Job Shop, read-only, from the terminal.
//
// Separate from `hacklab org jobs` because they answer different questions.
// This one is "what is hiring", asked by a hacker about every company; that one
// is "what have we posted", asked by a company about itself and gated on who
// may speak for it. Same nouns, different audience, so they get different
// commands rather than one command with a mode flag.

const SUBCOMMANDS = ['list', 'view'] as const

type Job = {
  id: string
  roleTitle: string
  companyName: string
  companyUrl: string | null
  description: string
  salaryRange: string | null
  remoteOnsite: string | null
  beltRankMin: number | null
  atsUrl: string
  createdAt: string
  expiresAt: string | null
}

function usage(): never {
  error('usage: hacklab jobs [list|view]')
  info(`  hacklab jobs ${dim('[list] [--limit 20] [--json]')}   what is hiring`)
  info(`  hacklab jobs ${dim('view <id> [--json]')}`)
  info(`  post one with ${dim('hacklab org jobs post')}`)
  process.exit(1)
}

function fail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  process.exit(1)
}

async function get<T>(
  session: Session,
  path: string,
  json: boolean
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${resolveAppUrl(session)}${path}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch (err) {
    fail(json, 'network', err instanceof Error ? err.message : String(err))
  }

  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null
  if (!res.ok) {
    const message =
      res.status === 401
        ? unauthorizedHint(session)
        : (data?.error ?? `request failed (${res.status})`)
    fail(json, res.status === 404 ? 'not_found' : 'error', message)
  }
  return data as T
}

/** One-line summary of what a role offers, for the list. */
export function jobMeta(job: Job): string {
  return (
    [
      job.remoteOnsite,
      job.salaryRange,
      job.beltRankMin != null && job.beltRankMin > 0
        ? `lv.${job.beltRankMin}+`
        : null,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  )
}

async function jobsList(args: string[]): Promise<void> {
  const json = args.includes('--json')

  const limitIndex = args.indexOf('--limit')
  const rawLimit = limitIndex === -1 ? undefined : args[limitIndex + 1]
  const limit = rawLimit === undefined ? 20 : Number(rawLimit)
  if (
    (limitIndex !== -1 && rawLimit === undefined) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    fail(json, 'invalid_fields', '--limit must be 1-100')
  }

  const session = await requireSession(json)
  const body = await get<{ jobs: Job[] }>(
    session,
    `/api/jobshop?limit=${limit}`,
    json
  )
  const jobs = body.jobs ?? []

  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, jobs }, null, 2))
    return
  }
  if (jobs.length === 0) {
    info('nothing on the shop right now')
    return
  }

  const rows = jobs.map((job) => ({
    title: stripControl(job.roleTitle),
    company: stripControl(job.companyName),
    meta: jobMeta(job),
    id: job.id,
  }))
  const titleWidth = Math.max(...rows.map((r) => displayWidth(r.title)))
  const companyWidth = Math.max(...rows.map((r) => displayWidth(r.company)))
  for (const row of rows) {
    console.log(
      `  ${bold(padEndTo(row.title, titleWidth))}  ${padEndTo(row.company, companyWidth)}  ${dim(row.meta)}`
    )
  }
  console.log('')
  info(
    `read one with ${dim('hacklab jobs view <id>')} — ids in ${dim('--json')}`
  )
}

async function jobsView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const id = args.find((a) => !a.startsWith('-'))
  if (!id) fail(json, 'invalid_args', 'pass a listing id')

  const session = await requireSession(json)
  const body = await get<{ job: Job }>(
    session,
    `/api/jobshop/${encodeURIComponent(id)}`,
    json
  )

  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, job: body.job }, null, 2))
    return
  }

  const job = body.job
  console.log(`  ${bold(stripControl(job.roleTitle))}`)
  console.log(`  ${dim(stripControl(job.companyName))}`)
  console.log('')
  console.log(`  ${jobMeta(job)}`)
  console.log('')
  console.log(
    stripControl(job.description)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  )
  console.log('')
  info(`apply: ${job.atsUrl}`)
  info(dim(`${resolveAppUrl(session)}/jobshop/${job.id}`))
}

export async function jobs(args: string[] = []): Promise<void> {
  const [subToken, ...rest] = args

  // Bare `hacklab jobs` (and `--json`) is the list — the cheapest read, and
  // the one a hacker actually wants when they type the noun on its own.
  if (!subToken || subToken.startsWith('-')) return jobsList(args)

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: jobs ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: jobs ${subToken}`)
    usage()
  }

  if (resolved.name === 'list') return jobsList(rest)
  if (resolved.name === 'view') return jobsView(rest)
}
