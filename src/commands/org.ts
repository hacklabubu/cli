import { readFile } from 'node:fs/promises'

import * as clack from '@clack/prompts'
import { parse as parseYaml } from 'yaml'

import { emitJsonError, requireSession } from '../api-client.js'
import { ensureScheme } from '../field-normalize.js'
import {
  normalizeOrgFieldValue,
  ORG_FIELD_NAMES,
  ORG_FIELDS,
  type OrgFieldSpec,
  parseOrgDocument,
  resolveTargetOrg,
} from '../org-fields.js'
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

// `hacklab org` is a small hub with two audiences. Humans: the bare command
// edits (autosave editor), `claim` / `create` run interactive flows, and the
// no-org case dead-ends into a claim/create menu. Agents: `list` / `view` /
// `set` / `apply` / `claim <slug>` / `create --name …` are non-interactive
// and take `--json`, so a profile can go from nothing to fully filled without
// a human at the prompts. Field definitions live in org-fields.ts.

const SUBCOMMANDS = [
  'list',
  'view',
  'set',
  'apply',
  'claim',
  'create',
  'edit',
  'access',
] as const

// `hacklab org access <list|grant|revoke>` — who controls the org. Nested like
// `hackathon team <verb>` because "grant"/"revoke" mean nothing on their own at
// the `org` level. Note `org a` is now ambiguous (access/apply); `org ap` and
// `org ac` still resolve.
const ACCESS_SUBCOMMANDS = ['list', 'grant', 'revoke'] as const

// Must match ORG_SLUG_PATTERN on the server (apps/web/lib/org-payload.ts).
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

type Org = Record<string, unknown> & {
  id: string
  name: string
  slug: string
}

// Lean shape returned for claimable orgs (the picker only needs these).
type ClaimableOrg = {
  id: string
  name: string
  slug: string
  ycBatch?: string | null
  // Why it's claimable — shown as a picker hint.
  via?: 'member' | 'email' | 'both'
}

type OrgState = { organizations: Org[]; claimable: ClaimableOrg[] }

// Human hint for why a company is claimable.
export function claimReason(via: ClaimableOrg['via']): string {
  if (via === 'email') return 'email domain'
  if (via === 'both') return 'member · email'
  return 'member'
}

// Slot the server returns when create hits an existing slug.
type ExistingOrg = {
  id: string
  name: string
  slug: string
  claimed: boolean
  isMember: boolean
}

type CreateResult =
  | { ok: true; org: Org }
  | { ok: false; existing: ExistingOrg; claimable: boolean }

// Derive a default slug from a name the same way the server's create-org helper
// does — the user can still edit it before submitting.
export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return s || 'org'
}

// Short, human label for the current value (shown as a select-menu hint and in
// `org view` rows).
export function displayValue(
  spec: Pick<OrgFieldSpec, 'type'>,
  value: unknown
): string {
  if (value == null || value === '') return '(empty)'
  if (spec.type === 'boolean') return value ? 'yes' : 'no'
  if (spec.type === 'list') {
    return Array.isArray(value) ? value.join(', ') || '(empty)' : String(value)
  }
  const s = String(value)
  return s.length > 48 ? `${s.slice(0, 47)}…` : s
}

async function fetchOrgState(session: Session): Promise<OrgState> {
  const res = await fetch(`${resolveAppUrl(session)}/api/cli/org`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (res.status === 401) throw new Error(unauthorizedHint(session))
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(
      data?.error ?? `failed to load organizations (${res.status})`
    )
  }
  return {
    organizations: (data?.organizations ?? []) as Org[],
    claimable: (data?.claimable ?? []) as ClaimableOrg[],
  }
}

async function patchOrg(
  session: Session,
  orgId: string,
  fields: Record<string, unknown>
): Promise<Org> {
  const res = await fetch(`${resolveAppUrl(session)}/api/cli/org`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ orgId, fields }),
  })
  if (res.status === 401) throw new Error(unauthorizedHint(session))
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error ?? `update failed (${res.status})`)
  }
  return data as Org
}

async function postClaim(session: Session, orgId: string): Promise<Org> {
  const res = await fetch(`${resolveAppUrl(session)}/api/cli/org/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ orgId }),
  })
  if (res.status === 401) throw new Error(unauthorizedHint(session))
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error ?? `claim failed (${res.status})`)
  }
  return data as Org
}

// Returns ok:true with the new org, or ok:false with the existing org and
// whether the caller may claim it (a 409 the create flow reroutes, not throws).
async function postCreate(
  session: Session,
  fields: Record<string, unknown>
): Promise<CreateResult> {
  const res = await fetch(`${resolveAppUrl(session)}/api/cli/org/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ fields }),
  })
  if (res.status === 401) throw new Error(unauthorizedHint(session))
  const data = await res.json().catch(() => null)
  if (res.ok) return { ok: true, org: data as Org }
  if (res.status === 409 && data?.existing) {
    return {
      ok: false,
      existing: data.existing as ExistingOrg,
      claimable: Boolean(data.claimable),
    }
  }
  throw new Error(data?.error ?? `create failed (${res.status})`)
}

// One person who controls an org. `handle`/`displayName` come from a left join,
// so an account that never finished a hacker profile has neither — `email` is
// the only field guaranteed to identify someone.
type Claimant = {
  handle: string | null
  displayName: string | null
  email: string
  // The user id of whoever granted this claim, or null for the original
  // claimer. An id, not a handle — see accessRows() for why it prints as-is.
  grantedBy: string | null
  since: string
  isYou: boolean
}

type AccessList = {
  organization: { id: string; name: string; slug: string }
  claimants: Claimant[]
}

/** Outcome of a grant/revoke, echoed by the server. */
type AccessChange = { status: string; handle: string }

type AccessResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

/**
 * Map an access-route refusal to a stable code.
 *
 * The route answers with a bare `{ error: "<sentence>" }` — no machine code —
 * and it reuses 404 for three different refusals. Classifying on the message is
 * the only way to tell them apart, and telling them apart is the point: "there
 * is no such account" and "that account doesn't control this org" send the
 * caller to completely different next steps. Unrecognized text falls back to a
 * generic code rather than guessing.
 */
export function accessErrorCode(status: number, message: string): string {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 409) return 'last_claimant'
  if (status === 400) return 'invalid_args'
  if (status === 404) {
    if (/^no hacklab account/i.test(message)) return 'no_such_account'
    if (/does not control/i.test(message)) return 'not_a_claimant'
    return 'org_not_found'
  }
  return 'error'
}

/** What the caller can do about a refusal. Printed to stderr, never stdout. */
export function accessErrorHint(code: string): string | null {
  if (code === 'last_claimant') {
    return 'grant control to someone else first: `hacklab org access grant <handle>`'
  }
  if (code === 'no_such_account') {
    return 'handles are hacklab usernames — check one with `hacklab hacker view <handle>`'
  }
  if (code === 'not_a_claimant') {
    return 'see who controls it with `hacklab org access list`'
  }
  if (code === 'forbidden' || code === 'org_not_found') {
    return 'you no longer control this company — `hacklab org list` shows the ones you do'
  }
  return null
}

/**
 * Call the access route. Returns the parsed body, or the classified refusal —
 * refusals are values here (not throws) because every caller maps them to a
 * code and a hint rather than to one generic message.
 */
async function accessRequest<T>(
  session: Session,
  method: 'GET' | 'POST' | 'DELETE',
  query: Record<string, string>,
  body?: unknown
): Promise<AccessResult<T>> {
  const url = new URL(`${resolveAppUrl(session)}/api/cli/org/access`)
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
      code: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null
  if (res.ok) return { ok: true, data: data as T }

  const message =
    res.status === 401
      ? unauthorizedHint(session)
      : (data?.error ?? `request failed (${res.status})`)
  return { ok: false, code: accessErrorCode(res.status, message), message }
}

// ---------------------------------------------------------------------------
// Agent verbs: list / view / set / apply / claim <slug> / create --name.
// Non-interactive, all take --json; one envelope shape with profile/hacker.

function usage(): never {
  error('usage: hacklab org [list|view|set|apply|claim|create|access]')
  info(
    `  hacklab org                          ${dim('interactive editor (claim/create hub)')}`
  )
  info(
    `  hacklab org ${dim('list [--json]')}            orgs you manage + orgs you can claim`
  )
  info(`  hacklab org ${dim('view [--org <slug>] [--json]')}`)
  info(
    `  hacklab org ${dim('set <field> <value> [--org <slug>] [--clear] [--json]')}`
  )
  info(`  hacklab org ${dim('apply <file|-> [--org <slug>] [--json]')}`)
  info(`  hacklab org ${dim('claim <slug> [--json]')}`)
  info(
    `  hacklab org ${dim('create --name <name> [--slug <slug>] [--website <url>] [--description <text>] [--json]')}`
  )
  info(
    `  hacklab org ${dim('access [list] [--org <slug>] [--json]')}     who controls it`
  )
  info(
    `  hacklab org ${dim('access grant|revoke <handle> [--org <slug>] [--json]')}`
  )
  info(`  fields: ${dim(ORG_FIELD_NAMES.join(', '))}`)
  process.exit(1)
}

/** Exit with the mode-appropriate error: JSON envelope or human copy. */
function fail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  process.exit(1)
}

function printJson(data: unknown) {
  console.log(
    JSON.stringify({ schemaVersion: 1, ...(data as object) }, null, 2)
  )
}

/** Pull `--flag <value>` out of argv; returns the value and the rest. */
export function extractOption(
  args: string[],
  flag: string
): { value: string | undefined; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      value = args[++i]
      continue
    }
    rest.push(args[i]!)
  }
  return { value, rest }
}

/** File contents, or stdin when the path is `-`. */
async function readInput(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  return readFile(path, 'utf8')
}

async function loadState(session: Session, json: boolean): Promise<OrgState> {
  try {
    return await fetchOrgState(session)
  } catch (err) {
    fail(json, 'error', err instanceof Error ? err.message : String(err))
  }
}

function renderOrg(org: Org, appUrl: string): string[] {
  const lines: string[] = []
  lines.push(`  ${bold(org.name)} ${dim(`/o/${org.slug}`)}`)
  lines.push('')
  const rows = ORG_FIELDS.filter((f) => f.key !== 'name')
  const width = Math.max(...rows.map((f) => f.name.length))
  for (const f of rows) {
    const value = displayValue(f, org[f.key])
    lines.push(
      `  ${dim(f.name.padEnd(width))}  ${value === '(empty)' ? dim(value) : value}`
    )
  }
  lines.push('')
  lines.push(`  ${dim(`${appUrl}/o/${org.slug}`)}`)
  return lines
}

/** Slug edits break old links — surface that in both output modes. */
function slugWarnings(before: string, after: string): string[] {
  return before === after
    ? []
    : [`old links to /o/${before} will no longer resolve`]
}

async function orgList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)
  const state = await loadState(session, json)

  if (json) {
    printJson(state)
    return
  }

  const appUrl = resolveAppUrl(session)
  if (state.organizations.length === 0) {
    info("you don't manage a company yet")
  } else {
    info('you manage:')
    for (const o of state.organizations) {
      console.log(`  ${bold(o.name)}  ${dim(`${appUrl}/o/${o.slug}`)}`)
    }
  }
  if (state.claimable.length > 0) {
    info(`claimable (run ${dim('hacklab org claim <slug>')}):`)
    for (const o of state.claimable) {
      console.log(
        `  ${o.name}  ${dim(`/o/${o.slug}`)}  ${dim(`(${claimReason(o.via)})`)}`
      )
    }
  } else if (state.organizations.length === 0) {
    info(`create one with ${dim('hacklab org create')}`)
  }
}

async function orgView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: orgSlug } = extractOption(args, '--org')
  const session = await requireSession(json)
  const state = await loadState(session, json)

  const target = resolveTargetOrg(state.organizations, orgSlug)
  if (!target.ok) fail(json, target.code, target.error)

  if (json) {
    printJson({ organization: target.org })
    return
  }
  console.log(renderOrg(target.org, resolveAppUrl(session)).join('\n'))
}

async function orgSet(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const clear = args.includes('--clear')
  const { value: orgSlug, rest } = extractOption(
    args.filter((a) => a !== '--json' && a !== '--clear'),
    '--org'
  )
  const [fieldToken, ...valueParts] = rest
  if (!fieldToken) usage()

  const resolved = resolveCommand(fieldToken, ORG_FIELD_NAMES)
  if (resolved.kind === 'ambiguous') {
    fail(
      json,
      'invalid_fields',
      `ambiguous field: ${fieldToken} (${resolved.matches.join(', ')})`
    )
  }
  if (resolved.kind === 'unknown') {
    fail(
      json,
      'invalid_fields',
      `unknown field "${fieldToken}" (fields: ${ORG_FIELD_NAMES.join(', ')})`
    )
  }
  const spec = ORG_FIELDS.find((f) => f.name === resolved.name)
  if (!spec) usage()

  const raw = clear ? '' : valueParts.join(' ')
  if (!clear && !raw.trim()) {
    fail(json, 'invalid_fields', 'pass a value, or --clear')
  }
  const normalized = normalizeOrgFieldValue(spec, raw)
  if (!normalized.ok) fail(json, 'invalid_fields', normalized.error)

  const session = await requireSession(json)
  const state = await loadState(session, json)
  const target = resolveTargetOrg(state.organizations, orgSlug)
  if (!target.ok) fail(json, target.code, target.error)

  let updated: Org
  try {
    updated = await patchOrg(session, target.org.id, {
      [spec.key]: normalized.value,
    })
  } catch (err) {
    fail(json, 'error', err instanceof Error ? err.message : String(err))
  }

  const warnings = slugWarnings(target.org.slug, updated.slug)
  if (json) {
    printJson({
      updated: [spec.key],
      organization: updated,
      ...(warnings.length ? { warnings } : {}),
    })
    return
  }
  success(`saved ${spec.name}: ${displayValue(spec, updated[spec.key])}`)
  for (const w of warnings) info(w)
  info(dim(`${resolveAppUrl(session)}/o/${updated.slug}`))
}

async function orgApply(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: orgSlug, rest } = extractOption(
    args.filter((a) => a !== '--json'),
    '--org'
  )
  const path = rest.find((a) => a === '-' || !a.startsWith('-'))
  if (!path) usage()

  let content: string
  try {
    content = await readInput(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message =
      code === 'ENOENT' ? `file not found: ${path}` : `could not read ${path}`
    fail(json, 'read_failed', message)
  }

  let doc: unknown
  try {
    // YAML is a superset of JSON, so one parser covers both file shapes.
    doc = parseYaml(content)
  } catch (err) {
    fail(
      json,
      'parse_failed',
      `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const parsed = parseOrgDocument(doc)
  if (!parsed.ok) fail(json, 'invalid_fields', parsed.error)

  const session = await requireSession(json)
  const state = await loadState(session, json)
  const target = resolveTargetOrg(state.organizations, orgSlug)
  if (!target.ok) fail(json, target.code, target.error)

  let updated: Org
  try {
    updated = await patchOrg(session, target.org.id, parsed.fields)
  } catch (err) {
    fail(json, 'error', err instanceof Error ? err.message : String(err))
  }

  const keys = Object.keys(parsed.fields)
  const warnings = slugWarnings(target.org.slug, updated.slug)
  if (json) {
    printJson({
      updated: keys,
      organization: updated,
      ...(warnings.length ? { warnings } : {}),
    })
    return
  }
  const names = keys
    .map((key) => ORG_FIELDS.find((f) => f.key === key)?.name ?? key)
    .join(', ')
  success(`saved ${keys.length} field${keys.length === 1 ? '' : 's'}: ${names}`)
  for (const w of warnings) info(w)
  console.log(renderOrg(updated, resolveAppUrl(session)).join('\n'))
}

async function orgClaimDirect(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const slug = args.find((a) => !a.startsWith('-'))
  if (!slug) fail(json, 'invalid_args', 'pass a company slug to claim')

  const session = await requireSession(json)
  const state = await loadState(session, json)

  // Idempotent: claiming an org you already manage is a no-op success.
  const mine = state.organizations.find((o) => o.slug === slug)
  if (mine) {
    if (json) {
      printJson({ organization: mine, alreadyClaimed: true })
      return
    }
    success(`you already manage ${bold(mine.name)}`)
    info(dim(`${resolveAppUrl(session)}/o/${mine.slug}`))
    return
  }

  const candidate = state.claimable.find((o) => o.slug === slug)
  if (!candidate) {
    const options = state.claimable.map((o) => o.slug).join(', ')
    fail(
      json,
      'not_found',
      options
        ? `"${slug}" isn't claimable by you (claimable: ${options})`
        : `"${slug}" isn't claimable by you — create it with \`hacklab org create\``
    )
  }

  let claimed: Org
  try {
    claimed = await postClaim(session, candidate.id)
  } catch (err) {
    fail(json, 'claim_failed', err instanceof Error ? err.message : String(err))
  }

  if (json) {
    printJson({
      organization: claimed,
      alreadyClaimed: Boolean(claimed.alreadyClaimed),
    })
    return
  }
  success(`you now manage ${bold(claimed.name)}`)
  info(dim(`${resolveAppUrl(session)}/o/${claimed.slug}`))
  info(
    `fill it in with ${dim('hacklab org apply <file>')} or ${dim('hacklab org set')}`
  )
}

const CREATE_FLAGS = ['--name', '--slug', '--website', '--description'] as const

function hasCreateFlags(args: string[]): boolean {
  return CREATE_FLAGS.some((f) => args.includes(f))
}

async function orgCreateDirect(args: string[]): Promise<void> {
  const json = args.includes('--json')
  let rest = args.filter((a) => a !== '--json')
  const opts: Record<string, string | undefined> = {}
  for (const flag of CREATE_FLAGS) {
    const extracted = extractOption(rest, flag)
    opts[flag.slice(2)] = extracted.value
    rest = extracted.rest
  }

  const name = opts.name?.trim()
  if (!name) fail(json, 'invalid_args', 'pass --name <company name>')
  const slug = (opts.slug ?? slugify(name)).trim()
  if (!SLUG_PATTERN.test(slug)) {
    fail(
      json,
      'invalid_fields',
      'slug must use lowercase letters, numbers, and hyphens only'
    )
  }

  const fields: Record<string, unknown> = { name, slug }
  if (opts.website?.trim()) fields.website = ensureScheme(opts.website.trim())
  if (opts.description?.trim()) fields.description = opts.description.trim()

  const session = await requireSession(json)
  let result: CreateResult
  try {
    result = await postCreate(session, fields)
  } catch (err) {
    fail(json, 'error', err instanceof Error ? err.message : String(err))
  }

  if (result.ok) {
    if (json) {
      printJson({ organization: result.org })
      return
    }
    success(`created ${bold(result.org.name)}`)
    info(dim(`${resolveAppUrl(session)}/o/${result.org.slug}`))
    info(
      `fill it in with ${dim('hacklab org apply <file>')} or ${dim('hacklab org set')}`
    )
    return
  }

  // Slug collision: relay what the caller can do about it, in both modes.
  const { existing, claimable } = result
  const message = `a company with the slug "${slug}" already exists`
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          error: { code: 'slug_exists', message },
          existing,
          claimable,
        },
        null,
        2
      )
    )
    process.exit(1)
  }
  error(message)
  if (claimable) {
    info(`you can claim it: ${dim(`hacklab org claim ${existing.slug}`)}`)
  } else if (existing.claimed) {
    info('it is already claimed by someone else — pick a different slug')
  } else {
    info(
      "you can't claim it (not a member, and your email domain doesn't match) — pick a different slug"
    )
  }
  process.exit(1)
}

// ---------------------------------------------------------------------------
// access: who controls this org. list / grant <handle> / revoke <handle>.
// People are named by hacklab handle — the identifier an organizer actually
// knows about a colleague — matching how the server takes them.

function accessUsage(): never {
  error('usage: hacklab org access [list|grant|revoke]')
  info(
    `  hacklab org access ${dim('[list] [--org <slug>] [--json]')}      who controls it`
  )
  info(`  hacklab org access ${dim('grant <handle> [--org <slug>] [--json]')}`)
  info(`  hacklab org access ${dim('revoke <handle> [--org <slug>] [--json]')}`)
  hint('revoking yourself is allowed — the last controller is not')
  process.exit(1)
}

/** Like fail(), plus the "what to do instead" line on stderr. */
function accessFail(json: boolean, code: string, message: string): never {
  if (json) emitJsonError(code, message)
  error(message)
  const tip = accessErrorHint(code)
  if (tip) hint(tip)
  process.exit(1)
}

/** Trim and drop a leading @, so `@marin` and `marin` both work. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim()
}

/** Session + the org these verbs act on, resolved exactly like the other verbs. */
async function accessTarget(
  orgSlug: string | undefined,
  json: boolean
): Promise<{ session: Session; org: Org }> {
  const session = await requireSession(json)
  const state = await loadState(session, json)
  const target = resolveTargetOrg(state.organizations, orgSlug)
  if (!target.ok) fail(json, target.code, target.error)
  return { session, org: target.org }
}

/** `@handle`, falling back to the email when there's no hacker profile yet. */
export function claimantLabel(
  claimant: Pick<Claimant, 'handle' | 'email'>
): string {
  const handle = claimant.handle?.trim()
  return handle ? `@${stripControl(handle)}` : stripControl(claimant.email)
}

/**
 * The "granted by" column.
 *
 * `grantedBy` is a raw user id — the route has no handle for it — so there is
 * nothing here to turn it into a name. It prints truncated: long enough to tell
 * two granters apart at a glance, short enough not to swamp the row. The full
 * value is in `--json`.
 */
export function grantedByLabel(grantedBy: string | null): string {
  if (!grantedBy) return 'original claim'
  const id = stripControl(grantedBy)
  return `granted by ${id.length > 12 ? `${id.slice(0, 12)}…` : id}`
}

function accessRows(claimants: Claimant[]): string[] {
  const rows = claimants.map((c) => ({
    who: claimantLabel(c),
    name: stripControl(c.displayName?.trim() || ''),
    meta: [
      c.isYou ? 'you' : null,
      grantedByLabel(c.grantedBy),
      `since ${new Date(c.since).toLocaleDateString()}`,
    ]
      .filter(Boolean)
      .join(' · '),
  }))
  const whoWidth = Math.max(...rows.map((r) => displayWidth(r.who)))
  const nameWidth = Math.max(...rows.map((r) => displayWidth(r.name)))
  return rows.map(
    (r) =>
      `  ${bold(padEndTo(r.who, whoWidth))}  ${padEndTo(r.name, nameWidth)}  ${dim(r.meta)}`
  )
}

async function accessList(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: orgSlug } = extractOption(
    args.filter((a) => a !== '--json'),
    '--org'
  )
  const { session, org } = await accessTarget(orgSlug, json)

  const result = await accessRequest<AccessList>(session, 'GET', {
    orgSlug: org.slug,
  })
  if (!result.ok) accessFail(json, result.code, result.message)

  const { organization, claimants } = result.data
  if (json) {
    printJson({ organization, claimants })
    return
  }

  console.log(`  ${bold(organization.name)} ${dim(`/o/${organization.slug}`)}`)
  console.log('')
  // The route only answers for an org you control, so you are always in here —
  // an empty list would mean the org lost its last controller, which revoke
  // refuses to allow. Handled anyway rather than crashing on Math.max of [].
  if (claimants.length === 0) {
    info('nobody controls this company')
  } else {
    console.log(accessRows(claimants).join('\n'))
  }
  console.log('')
  info(`grant control with ${dim('hacklab org access grant <handle>')}`)
}

async function accessGrant(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: orgSlug, rest } = extractOption(
    args.filter((a) => a !== '--json'),
    '--org'
  )
  const raw = rest.find((a) => !a.startsWith('-'))
  const handle = raw ? normalizeHandle(raw) : ''
  if (!handle) {
    fail(json, 'invalid_args', 'pass the handle to grant control to')
  }

  const { session, org } = await accessTarget(orgSlug, json)
  const result = await accessRequest<AccessChange>(
    session,
    'POST',
    {},
    { orgSlug: org.slug, handle }
  )
  if (!result.ok) accessFail(json, result.code, result.message)

  const already = result.data.status === 'already_claimed'
  if (json) {
    printJson({
      organization: { id: org.id, name: org.name, slug: org.slug },
      handle,
      status: result.data.status,
    })
    return
  }
  if (already) {
    success(`@${handle} already controls ${bold(org.name)}`)
    return
  }
  success(`@${handle} now controls ${bold(org.name)}`)
  info(`they can edit it with ${dim('hacklab org')}`)
}

async function accessRevoke(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const { value: orgSlug, rest } = extractOption(
    args.filter((a) => a !== '--json'),
    '--org'
  )
  const raw = rest.find((a) => !a.startsWith('-'))
  const handle = raw ? normalizeHandle(raw) : ''
  if (!handle) {
    fail(json, 'invalid_args', 'pass the handle to revoke control from')
  }

  const { session, org } = await accessTarget(orgSlug, json)
  const result = await accessRequest<AccessChange>(session, 'DELETE', {
    orgSlug: org.slug,
    handle,
  })
  if (!result.ok) accessFail(json, result.code, result.message)

  if (json) {
    printJson({
      organization: { id: org.id, name: org.name, slug: org.slug },
      handle,
      status: result.data.status,
    })
    return
  }
  // Removing yourself is a supported move, and it reads very differently.
  if (session.handle && normalizeHandle(session.handle) === handle) {
    success(`you no longer control ${bold(org.name)}`)
    return
  }
  success(`@${handle} no longer controls ${bold(org.name)}`)
}

async function orgAccess(args: string[]): Promise<void> {
  const [subToken, ...rest] = args
  // Bare `org access` (and `org access --json`) is the list — the cheapest read.
  if (!subToken || subToken.startsWith('-')) return accessList(args)

  const resolved = resolveCommand(subToken, ACCESS_SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: org access ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: org access ${subToken}`)
    accessUsage()
  }

  if (resolved.name === 'list') return accessList(rest)
  if (resolved.name === 'grant') return accessGrant(rest)
  if (resolved.name === 'revoke') return accessRevoke(rest)
}

// ---------------------------------------------------------------------------
// Interactive flows (unchanged behavior): the human editor and claim/create.

// Prompt for one field, prefilled with the current value. Returns the new
// value to send, or a clack cancel symbol.
async function promptField(
  spec: OrgFieldSpec,
  current: unknown
): Promise<unknown> {
  if (spec.type === 'boolean') {
    return clack.confirm({
      message: spec.label,
      initialValue: Boolean(current),
    })
  }

  if (spec.type === 'list') {
    const initial = Array.isArray(current) ? current.join(', ') : ''
    const value = await clack.text({
      message: `${spec.label} ${dim('(comma-separated, blank to clear)')}`,
      initialValue: initial,
    })
    if (clack.isCancel(value)) return value
    const items = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return items.length ? items : null
  }

  if (spec.type === 'number') {
    const value = await clack.text({
      message: `${spec.label} ${dim('(blank to clear)')}`,
      initialValue: current == null ? '' : String(current),
      validate: (v) => {
        const t = (v ?? '').trim()
        return !t || /^\d+$/.test(t) ? undefined : 'must be a whole number'
      },
    })
    if (clack.isCancel(value)) return value
    return value.trim() ? Number(value.trim()) : null
  }

  const value = await clack.text({
    message:
      spec.type === 'url'
        ? `${spec.label} ${dim('(blank to clear)')}`
        : spec.label,
    initialValue: current == null ? '' : String(current),
    validate:
      spec.type === 'url'
        ? (v) => {
            const t = (v ?? '').trim()
            if (!t) return undefined
            try {
              new URL(t)
              return undefined
            } catch {
              return 'must be a valid URL (include https://)'
            }
          }
        : undefined,
  })
  if (clack.isCancel(value)) return value
  const trimmed = value.trim()
  // name/slug are required (notNull): a blank keeps the current value.
  if ((spec.key === 'name' || spec.key === 'slug') && !trimmed) return current
  return trimmed ? trimmed : null
}

// Autosave editor over a claimed org. Editing a field writes it immediately
// (mirrors the web settings' "saves instantly, no Save button"): pick a field,
// set its value, it saves, and the menu shows the saved value. Leave any time
// with "done" or Esc — nothing is pending, so nothing is lost. Prints its own
// outro, so callers don't add another.
async function editLoop(session: Session, initial: Org): Promise<void> {
  let target = initial
  const DONE = '__done__'
  let savedCount = 0
  while (true) {
    const choice = await clack.select({
      message: `editing ${bold(target.name)} ${dim('(saves as you go)')}`,
      options: [
        ...ORG_FIELDS.map((f) => ({
          value: f.key,
          label: f.label,
          hint: displayValue(f, target[f.key]),
        })),
        { value: DONE, label: '← done' },
      ],
    })
    // Esc / Ctrl+C at the menu, or "done": leave. Every edit is already saved.
    if (clack.isCancel(choice) || choice === DONE) break

    const spec = ORG_FIELDS.find((f) => f.key === choice)
    if (!spec) continue
    const next = await promptField(spec, target[spec.key])
    // Cancelling a single field drops just that edit and returns to the menu.
    if (clack.isCancel(next)) continue

    const label = spec.label.toLowerCase()
    const prevSlug = target.slug
    const spin = clack.spinner()
    spin.start(`saving ${label}`)
    try {
      const updated = await patchOrg(session, target.id, {
        [spec.key]: next,
      })
      target = { ...target, ...updated }
      savedCount++
      spin.stop(`saved ${label}`)
      if (spec.key === 'slug' && target.slug !== prevSlug) {
        clack.log.warn(`old links to /o/${prevSlug} will no longer resolve`)
      }
    } catch (err) {
      spin.stop(`could not save ${label}`)
      error(err instanceof Error ? err.message : String(err))
      // Stay in the loop so they can retry or edit something else.
    }
  }

  if (savedCount > 0) {
    success(
      `saved ${savedCount} change${savedCount === 1 ? '' : 's'} to ${bold(target.name)}`
    )
    info(`${resolveAppUrl(session)}/o/${target.slug}`)
  }
  clack.outro(dim('done.'))
}

// After a claim/create, offer to drop straight into the editor. Either branch
// finishes the command (editLoop or the outro here), so exactly one outro runs.
async function offerEdit(session: Session, org: Org): Promise<void> {
  const go = await clack.confirm({
    message: 'edit its details now?',
    initialValue: false,
  })
  if (clack.isCancel(go) || !go) {
    clack.outro(dim('done.'))
    return
  }
  await editLoop(session, org)
}

async function claimFlow(
  session: Session,
  preloaded?: ClaimableOrg[]
): Promise<void> {
  let list = preloaded
  if (!list) {
    try {
      list = (await fetchOrgState(session)).claimable
    } catch (err) {
      clack.cancel(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  }

  if (list.length === 0) {
    clack.cancel(
      "no companies to claim — you're not a member of any unclaimed company, and none match your email domain. create one with `hacklab org create`."
    )
    return
  }

  const picked = await clack.select({
    message: 'claim which company?',
    options: list.map((o) => ({
      value: o.id,
      label: `${o.name} ${dim(`/o/${o.slug}`)}`,
      hint: claimReason(o.via),
    })),
  })
  if (clack.isCancel(picked)) {
    clack.outro(dim('cancelled.'))
    return
  }
  const chosen = list.find((o) => o.id === picked)
  if (!chosen) {
    clack.outro(dim('cancelled.'))
    return
  }

  const ok = await clack.confirm({
    message: `claim ${bold(chosen.name)}? you'll be able to edit its public profile.`,
  })
  if (clack.isCancel(ok) || !ok) {
    clack.outro(dim('cancelled.'))
    return
  }

  const spin = clack.spinner()
  spin.start(`claiming ${chosen.name}`)
  let claimed: Org
  try {
    claimed = await postClaim(session, chosen.id)
    spin.stop(`claimed ${chosen.name}`)
  } catch (err) {
    spin.stop('could not claim')
    error(err instanceof Error ? err.message : String(err))
    return
  }

  success(`you now manage ${bold(claimed.name)}`)
  info(`${resolveAppUrl(session)}/o/${claimed.slug}`)
  await offerEdit(session, claimed)
}

async function createFlow(session: Session): Promise<void> {
  const name = await clack.text({
    message: 'company name',
    validate: (v) => ((v ?? '').trim() ? undefined : 'name is required'),
  })
  if (clack.isCancel(name)) {
    clack.outro(dim('cancelled.'))
    return
  }

  const slug = await clack.text({
    message: `slug ${dim('(url handle)')}`,
    initialValue: slugify(name),
    validate: (v) => {
      const t = (v ?? '').trim()
      if (!t) return 'slug is required'
      if (!SLUG_PATTERN.test(t)) {
        return 'lowercase letters, numbers, and hyphens only'
      }
      return undefined
    },
  })
  if (clack.isCancel(slug)) {
    clack.outro(dim('cancelled.'))
    return
  }

  const website = await clack.text({
    message: `website ${dim('(blank to skip)')}`,
    validate: (v) => {
      const t = (v ?? '').trim()
      if (!t) return undefined
      try {
        new URL(t)
        return undefined
      } catch {
        return 'must be a valid URL (include https://)'
      }
    },
  })
  if (clack.isCancel(website)) {
    clack.outro(dim('cancelled.'))
    return
  }

  const description = await clack.text({
    message: `short description ${dim('(blank to skip)')}`,
  })
  if (clack.isCancel(description)) {
    clack.outro(dim('cancelled.'))
    return
  }

  const fields: Record<string, unknown> = {
    name: name.trim(),
    slug: slug.trim(),
  }
  if (website.trim()) fields.website = website.trim()
  if (description.trim()) fields.description = description.trim()

  const spin = clack.spinner()
  spin.start(`creating ${name.trim()}`)
  let result: CreateResult
  try {
    result = await postCreate(session, fields)
  } catch (err) {
    spin.stop('could not create')
    error(err instanceof Error ? err.message : String(err))
    return
  }

  if (result.ok) {
    spin.stop(`created ${result.org.name}`)
    success(`you now manage ${bold(result.org.name)}`)
    info(`${resolveAppUrl(session)}/o/${result.org.slug}`)
    await offerEdit(session, result.org)
    return
  }

  // Slug collision. If the existing org is unclaimed and the caller is a member,
  // offer to claim it instead of forcing a rename.
  spin.stop(`"${slug.trim()}" already exists`)
  const { existing, claimable } = result
  if (claimable) {
    const go = await clack.confirm({
      message: `${bold(existing.name)} already exists and you can claim it — claim it instead?`,
    })
    if (clack.isCancel(go) || !go) {
      clack.outro(dim('cancelled.'))
      return
    }
    const spin2 = clack.spinner()
    spin2.start(`claiming ${existing.name}`)
    let claimed: Org
    try {
      claimed = await postClaim(session, existing.id)
      spin2.stop(`claimed ${existing.name}`)
    } catch (err) {
      spin2.stop('could not claim')
      error(err instanceof Error ? err.message : String(err))
      return
    }
    success(`you now manage ${bold(claimed.name)}`)
    info(`${resolveAppUrl(session)}/o/${claimed.slug}`)
    await offerEdit(session, claimed)
    return
  }

  // Can't claim it: either someone else owns it, or the caller has no claim
  // (not a member and email domain doesn't match).
  if (existing.claimed) {
    error(
      `${existing.name} is already claimed by someone else — pick a different slug.`
    )
  } else {
    error(
      `${existing.name} already exists but you can't claim it (not a member, and your email domain doesn't match). pick a different slug, or ask to be added as a member.`
    )
  }
  clack.outro(dim('done.'))
}

async function editFlow(session: Session): Promise<void> {
  let state: OrgState
  try {
    state = await fetchOrgState(session)
  } catch (err) {
    clack.cancel(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const { organizations, claimable } = state

  // Don't manage anything yet → offer claim (if any) / create instead of a
  // dead end pointing at the website.
  if (organizations.length === 0) {
    const options: { value: string; label: string }[] = []
    if (claimable.length > 0) {
      options.push({
        value: 'claim',
        label: `claim an existing company ${dim(`(${claimable.length})`)}`,
      })
    }
    options.push({ value: 'create', label: 'create a new company' })
    options.push({ value: 'cancel', label: 'cancel' })

    const choice = await clack.select({
      message: "you don't manage a company yet",
      options,
    })
    if (clack.isCancel(choice) || choice === 'cancel') {
      clack.outro(dim('cancelled.'))
      return
    }
    if (choice === 'claim') {
      await claimFlow(session, claimable)
      return
    }
    await createFlow(session)
    return
  }

  let target = organizations[0]!
  if (organizations.length > 1) {
    const picked = await clack.select({
      message: 'which organization?',
      options: organizations.map((o) => ({
        value: o.id,
        label: `${o.name} ${dim(`/o/${o.slug}`)}`,
      })),
    })
    if (clack.isCancel(picked)) {
      clack.outro(dim('cancelled.'))
      return
    }
    target = organizations.find((o) => o.id === picked) ?? target
  }

  await editLoop(session, target)
}

async function orgInteractive(
  mode: 'edit' | 'claim' | 'create'
): Promise<void> {
  const session = await requireSession(false)

  if (mode === 'claim') {
    clack.intro(bold('hacklab org claim'))
    await claimFlow(session)
    return
  }
  if (mode === 'create') {
    clack.intro(bold('hacklab org create'))
    // Validate the session against the *target* backend before collecting the
    // whole form, so a per-backend token mismatch (the common "I'm logged in but
    // it says Unauthorized" case) fails fast with a fix hint instead of after
    // you've filled everything in.
    try {
      await fetchOrgState(session)
    } catch (err) {
      clack.cancel(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    await createFlow(session)
    return
  }

  clack.intro(bold('hacklab org'))
  await editFlow(session)
}

export async function org(args: string[] = []): Promise<void> {
  const [subToken, ...rest] = args

  // Bare `hacklab org` keeps the interactive hub; bare + --json means view,
  // so `hacklab org --json` is the cheapest agent read.
  if (!subToken) return orgInteractive('edit')
  if (subToken.startsWith('-')) {
    if (args.includes('--json')) return orgView(args)
    return orgInteractive('edit')
  }

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: org ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: org ${subToken}`)
    usage()
  }

  if (resolved.name === 'list') return orgList(rest)
  if (resolved.name === 'view') return orgView(rest)
  if (resolved.name === 'set') return orgSet(rest)
  if (resolved.name === 'apply') return orgApply(rest)
  if (resolved.name === 'edit') return orgInteractive('edit')
  if (resolved.name === 'access') return orgAccess(rest)
  if (resolved.name === 'claim') {
    // A slug (or --json) makes it non-interactive; bare `claim` keeps the picker.
    const direct =
      rest.some((a) => !a.startsWith('-')) || rest.includes('--json')
    return direct ? orgClaimDirect(rest) : orgInteractive('claim')
  }
  if (resolved.name === 'create') {
    const direct = hasCreateFlags(rest) || rest.includes('--json')
    return direct ? orgCreateDirect(rest) : orgInteractive('create')
  }
}
