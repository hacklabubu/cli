import * as clack from '@clack/prompts'

import { emitJsonError } from '../api-client.js'
import {
  buildJobFields,
  JOB_FIELD_NAMES,
  JOB_FIELDS,
  type JobFieldSpec,
  type JobValue,
  normalizeJobFieldValue,
} from '../job-fields.js'
import { resolveCommand } from '../resolve-command.js'
import { resolveAppUrl, type Session, unauthorizedHint } from '../session.js'
import {
  bold,
  dim,
  displayWidth,
  error,
  hint,
  info,
  padEndTo,
  stripControl,
  success,
} from '../ui.js'

// `hacklab org jobs <list|view|post|close>` — a company's Job Shop listings.
//
// Nested under `org` because posting a listing is speaking for a company, and
// which company you may speak for is exactly what `org access` decides. Both
// roles on the access list reach these verbs: admins because they run the
// company, recruiters because filling the job shop is the whole reason that
// role exists.
//
// `post` cannot finish here. A listing is $1,000 and the terminal has no way
// to take a card, so it creates the listing and hands back a Stripe checkout
// URL. Until that is paid the listing sits in `pending_payment` and nobody
// sees it; after payment a human reviews it before it goes live.

export const JOBS_SUBCOMMANDS = ['list', 'view', 'post', 'close'] as const

export type OrgJob = {
  id: string
  roleTitle: string
  companyName: string
  status: string
  salaryRange: string | null
  remoteOnsite: string | null
  beltRankMin: number | null
  atsUrl: string
  reviewNote: string | null
  expiresAt: string | null
  createdAt: string
}

type JobsList = {
  organization: { id: string; slug: string; name: string }
  yourRole: 'admin' | 'recruiter'
  jobs: OrgJob[]
}

type PostResult = { job: OrgJob; checkoutUrl: string | null }

type Target = {
  session: Session
  org: { id: string; name: string; slug: string }
}

function printJson(data: unknown) {
  console.log(
    JSON.stringify({ schemaVersion: 1, ...(data as object) }, null, 2)
  )
}

function fail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  process.exit(1)
}

export function jobsUsage(): never {
  error('usage: hacklab org jobs [list|view|post|close]')
  info(
    `  hacklab org jobs ${dim('[list] [--org <slug>] [--json]')}       every listing you have posted`
  )
  info(`  hacklab org jobs ${dim('view <id> [--org <slug>] [--json]')}`)
  info(
    `  hacklab org jobs ${dim('post [--role "…"] [--description "…"] [--apply-url <url>] [--contact <email>] [--json]')}`
  )
  info(`  hacklab org jobs ${dim('close <id> [--org <slug>] [--json]')}`)
  info(`  fields: ${dim(JOB_FIELD_NAMES.map((n) => `--${n}`).join(', '))}`)
  hint('a listing costs $1,000 — post hands back a Stripe checkout link')
  process.exit(1)
}

/**
 * How a listing reads at a glance.
 *
 * Statuses are shown as what they mean to the person who paid, not as the
 * enum: `pending_payment` is "you never finished checkout", which is a very
 * different thing to do next than "we are still reading it".
 */
export function jobStatusLabel(
  status: string,
  expiresAt: string | null
): string {
  if (status === 'active') {
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      return 'expired'
    }
    return 'live'
  }
  if (status === 'pending_payment') return 'unpaid'
  if (status === 'pending_review') return 'in review'
  if (status === 'rejected') return 'rejected'
  if (status === 'disputed') return 'disputed'
  if (status === 'closed') return 'closed'
  return status
}

/** What the poster should do about a listing in this state, if anything. */
export function jobStatusHint(job: OrgJob): string | null {
  if (job.status === 'pending_payment') {
    return 'checkout was never completed — post it again to get a fresh link'
  }
  if (job.status === 'rejected') {
    return job.reviewNote ? `rejected: ${job.reviewNote}` : 'rejected'
  }
  return null
}

// ---------------------------------------------------------------------------
// HTTP

async function request<T>(
  session: Session,
  method: 'GET' | 'POST' | 'DELETE',
  query: Record<string, string>,
  body?: unknown
): Promise<
  { ok: true; data: T } | { ok: false; code: string; message: string }
> {
  const url = new URL(`${resolveAppUrl(session)}/api/cli/org/jobs`)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null
  if (res.ok) return { ok: true, data: data as T }

  const message =
    res.status === 401
      ? unauthorizedHint(session)
      : (data?.error ?? `request failed (${res.status})`)
  // The route names its own refusals, so unlike the access route there is
  // nothing to reverse-engineer from the message here.
  return { ok: false, code: data?.code ?? 'error', message }
}

/** What the caller can do about a refusal. Printed to stderr, never stdout. */
export function jobsErrorHint(code: string): string | null {
  if (code === 'forbidden') {
    return 'ask an admin for access: `hacklab org access grant <your handle> --role recruiter`'
  }
  if (code === 'org_not_found') {
    return '`hacklab org list` shows the companies you manage'
  }
  if (code === 'not_closable') {
    return 'only live listings can be closed — `hacklab org jobs list` shows their status'
  }
  return null
}

function jobsFail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  const tip = jobsErrorHint(code)
  if (tip) hint(tip)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Verbs

async function jobsList(target: Target, args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { session, org } = target

  const result = await request<JobsList>(session, 'GET', { orgSlug: org.slug })
  if (!result.ok) jobsFail(json, result.code, result.message)

  if (json) {
    printJson(result.data)
    return
  }

  const { jobs, yourRole } = result.data
  console.log(
    `  ${bold(org.name)} ${dim(`/o/${org.slug}`)} ${dim(`(${yourRole})`)}`
  )
  console.log('')
  if (jobs.length === 0) {
    info('no listings yet')
    info(`post one with ${dim('hacklab org jobs post')}`)
    return
  }

  const rows = jobs.map((job) => ({
    title: stripControl(job.roleTitle),
    status: jobStatusLabel(job.status, job.expiresAt),
    id: job.id,
    tip: jobStatusHint(job),
  }))
  const titleWidth = Math.max(...rows.map((r) => displayWidth(r.title)))
  const statusWidth = Math.max(...rows.map((r) => displayWidth(r.status)))
  for (const row of rows) {
    console.log(
      `  ${bold(padEndTo(row.title, titleWidth))}  ${padEndTo(row.status, statusWidth)}  ${dim(row.id)}`
    )
    if (row.tip) console.log(`    ${dim(row.tip)}`)
  }
}

async function jobsView(target: Target, args: string[]): Promise<void> {
  const json = args.includes('--json')
  const id = args.find((a) => !a.startsWith('-'))
  if (!id) fail(json, 'invalid_args', 'pass a listing id')

  const { session, org } = target
  const result = await request<JobsList>(session, 'GET', { orgSlug: org.slug })
  if (!result.ok) jobsFail(json, result.code, result.message)

  const job = result.data.jobs.find((candidate) => candidate.id === id)
  if (!job) {
    fail(json, 'not_found', `no listing "${id}" on ${org.name}`)
  }

  if (json) {
    printJson({ organization: result.data.organization, job })
    return
  }

  const meta = [
    job.remoteOnsite,
    job.salaryRange,
    job.beltRankMin != null && job.beltRankMin > 0
      ? `lv.${job.beltRankMin}+`
      : null,
  ].filter(Boolean)

  console.log(`  ${bold(stripControl(job.roleTitle))}`)
  console.log(`  ${dim(stripControl(job.companyName))}`)
  console.log('')
  console.log(
    `  ${dim('status')}  ${jobStatusLabel(job.status, job.expiresAt)}`
  )
  if (meta.length) console.log(`  ${dim('about ')}  ${meta.join(' · ')}`)
  console.log(`  ${dim('apply ')}  ${job.atsUrl}`)
  if (job.expiresAt) {
    console.log(
      `  ${dim('until ')}  ${new Date(job.expiresAt).toLocaleDateString()}`
    )
  }
  const tip = jobStatusHint(job)
  if (tip) {
    console.log('')
    info(tip)
  }
  if (job.status === 'active') {
    console.log('')
    info(dim(`${resolveAppUrl(session)}/jobshop/${job.id}`))
  }
}

async function jobsClose(target: Target, args: string[]): Promise<void> {
  const json = args.includes('--json')
  const id = args.find((a) => !a.startsWith('-'))
  if (!id) fail(json, 'invalid_args', 'pass the id of the listing to close')

  const { session, org } = target
  const result = await request<{ job: OrgJob }>(session, 'DELETE', {
    orgSlug: org.slug,
    jobId: id,
  })
  if (!result.ok) jobsFail(json, result.code, result.message)

  if (json) {
    printJson({
      organization: { id: org.id, name: org.name, slug: org.slug },
      job: result.data.job,
    })
    return
  }
  success(`closed ${bold(stripControl(result.data.job.roleTitle))}`)
  info('it is off the shop — the listing fee is not refunded')
}

// ---------------------------------------------------------------------------
// post

/** Pull every `--<field> <value>` out of argv, leaving the rest. */
export function extractJobOptions(args: string[]): {
  options: Record<string, string | undefined>
  rest: string[]
} {
  const options: Record<string, string | undefined> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    const name = token.startsWith('--') ? token.slice(2) : null
    if (name && JOB_FIELD_NAMES.includes(name) && i + 1 < args.length) {
      options[name] = args[++i]
      continue
    }
    rest.push(token)
  }
  return { options, rest }
}

/** True when argv carries any listing field, i.e. this is the agent path. */
export function hasJobFlags(args: string[]): boolean {
  return JOB_FIELD_NAMES.some((name) => args.includes(`--${name}`))
}

async function submitPost(
  target: Target,
  fields: Record<string, JobValue>,
  json: boolean
): Promise<PostResult> {
  const result = await request<PostResult>(
    target.session,
    'POST',
    {},
    { orgSlug: target.org.slug, fields }
  )
  if (!result.ok) jobsFail(json, result.code, result.message)
  return result.data
}

function reportPosted(target: Target, result: PostResult): void {
  success(`created the listing for ${bold(target.org.name)}`)
  console.log('')
  info('pay to submit it for review:')
  console.log(`  ${result.checkoutUrl ?? '(no checkout url returned)'}`)
  console.log('')
  info(dim('we review every posting before it goes live.'))
}

async function jobsPostDirect(target: Target, args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { options } = extractJobOptions(args.filter((a) => a !== '--json'))

  const built = buildJobFields(options, target.org.name)
  if (!built.ok) fail(json, 'invalid_fields', built.error)

  const result = await submitPost(target, built.fields, json)
  if (json) {
    printJson({
      organization: {
        id: target.org.id,
        name: target.org.name,
        slug: target.org.slug,
      },
      job: result.job,
      checkoutUrl: result.checkoutUrl,
    })
    return
  }
  reportPosted(target, result)
}

/** Ask for one field, validating with the same rules the flags go through. */
async function promptJobField(
  spec: JobFieldSpec,
  initial: string
): Promise<string | symbol> {
  if (spec.type === 'choice') {
    const picked = await clack.select({
      message: spec.label,
      options: [
        ...(spec.choices ?? []).map((choice) => ({
          value: choice,
          label: choice,
        })),
        ...(spec.required ? [] : [{ value: '', label: 'skip' }]),
      ],
    })
    return clack.isCancel(picked) ? picked : String(picked)
  }

  return clack.text({
    message: spec.required
      ? spec.label
      : `${spec.label} ${dim('(blank to skip)')}`,
    initialValue: initial,
    placeholder: spec.placeholder,
    validate: (value) => {
      const normalized = normalizeJobFieldValue(spec, value ?? '')
      return normalized.ok ? undefined : normalized.error
    },
  })
}

async function jobsPostInteractive(target: Target): Promise<void> {
  clack.intro(bold(`hacklab org jobs post — ${target.org.name}`))
  clack.log.info(
    `a listing costs ${bold('$1,000')} and is reviewed before it goes live`
  )

  const fields: Record<string, JobValue> = {}
  for (const spec of JOB_FIELDS) {
    // Company name is the org you are posting as; asking would only create a
    // way for the listing and the company page to disagree.
    if (spec.key === 'companyName') {
      fields.companyName = target.org.name
      continue
    }
    const answer = await promptJobField(spec, '')
    if (clack.isCancel(answer)) {
      clack.outro(dim('cancelled — nothing was created, nothing was charged.'))
      return
    }
    const normalized = normalizeJobFieldValue(spec, String(answer))
    // Validated at the prompt; a failure here can only be the skip case.
    if (!normalized.ok) continue
    if (normalized.value !== null) fields[spec.key] = normalized.value
  }

  const go = await clack.confirm({
    message: `create this listing and open checkout for $1,000?`,
  })
  if (clack.isCancel(go) || !go) {
    clack.outro(dim('cancelled — nothing was created, nothing was charged.'))
    return
  }

  const spin = clack.spinner()
  spin.start('creating the listing')
  const result = await submitPost(target, fields, false)
  spin.stop('created the listing')

  reportPosted(target, result)
  clack.outro(dim('done.'))
}

// ---------------------------------------------------------------------------

/**
 * Dispatch `org jobs <verb>`. The caller resolves the target org, because that
 * is the same `--org` / single-org resolution every other org verb uses.
 */
export async function orgJobs(target: Target, args: string[]): Promise<void> {
  const [subToken, ...rest] = args

  // Bare `org jobs` (and `--json`) is the list — the cheapest read.
  if (!subToken || subToken.startsWith('-')) return jobsList(target, args)

  const resolved = resolveCommand(subToken, JOBS_SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: org jobs ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: org jobs ${subToken}`)
    jobsUsage()
  }

  if (resolved.name === 'list') return jobsList(target, rest)
  if (resolved.name === 'view') return jobsView(target, rest)
  if (resolved.name === 'close') return jobsClose(target, rest)
  if (resolved.name === 'post') {
    // Flags (or --json) make it non-interactive; bare `post` keeps the prompts.
    const direct = hasJobFlags(rest) || rest.includes('--json')
    return direct ? jobsPostDirect(target, rest) : jobsPostInteractive(target)
  }
}
