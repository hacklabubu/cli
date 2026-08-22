import { readFile } from 'node:fs/promises'

import * as clack from '@clack/prompts'
import { parse as parseYaml } from 'yaml'

import { emitJsonError, readApiError, requireSession } from '../api-client.js'
import { ensureScheme, FALSE_WORDS, TRUE_WORDS } from '../field-normalize.js'
import { captureEvent } from '../posthog.js'
import { resolveCommand } from '../resolve-command.js'
import { resolveAppUrl, type Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info, link, success } from '../ui.js'

// `hacklab profile` — view and edit your own profile. Thin wrapper over
// GET/PATCH /api/hackers/me: the server owns validation (lengths, URL rules);
// this side only shapes input, so agents get one-shot writes (`set`, `apply
// profile.yaml`) and humans get an org-style autosave editor (`edit`).

const SUBCOMMANDS = ['view', 'set', 'edit', 'apply'] as const

const ME_PATH = '/api/hackers/me?src=cli'

export type ProfileFieldKind =
  | 'text'
  | 'markdown'
  | 'url'
  | 'handle'
  | 'boolean'

export type ProfileField = {
  /** API key sent to /api/hackers/me. */
  key: string
  /** CLI-facing name (`hacklab profile set <name> …`). */
  name: string
  kind: ProfileFieldKind
  /** handle kind: canonical site origin, with trailing slash. */
  base?: string
  /** handle kind: path put between `base` and a bare handle (`@`, `user/show/`). */
  handlePath?: string
  /** handle kind: recognized site prefixes to strip before rebuilding. */
  strip?: RegExp
  hint: string
}

// Mirrors the server's PROFILE_LINK_KEYS (apps/web/lib/profile-fields.ts) —
// the real validation boundary; this side just shapes input. Same list, same
// order, so the CLI, the settings form, and the public profile agree.
export const PROFILE_FIELDS: ProfileField[] = [
  { key: 'displayName', name: 'name', kind: 'text', hint: 'display name' },
  { key: 'bio', name: 'bio', kind: 'text', hint: 'short bio' },
  {
    key: 'profileReadme',
    name: 'readme',
    kind: 'markdown',
    hint: 'markdown or --file profile.md',
  },
  { key: 'websiteUrl', name: 'website', kind: 'url', hint: 'your-site.com' },
  { key: 'blogUrl', name: 'blog', kind: 'url', hint: 'your-blog.com' },
  {
    key: 'xUrl',
    name: 'x',
    kind: 'handle',
    base: 'https://x.com/',
    strip: /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i,
    hint: 'handle or x.com url',
  },
  {
    key: 'youtubeUrl',
    name: 'youtube',
    kind: 'handle',
    base: 'https://youtube.com/',
    handlePath: '@',
    strip: /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\//i,
    hint: '@channel or youtube url',
  },
  {
    key: 'instagramUrl',
    name: 'instagram',
    kind: 'handle',
    base: 'https://instagram.com/',
    strip: /^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i,
    hint: 'handle or instagram url',
  },
  {
    key: 'goodreadsUrl',
    name: 'goodreads',
    kind: 'handle',
    base: 'https://www.goodreads.com/',
    handlePath: 'user/show/',
    strip: /^(?:https?:\/\/)?(?:www\.)?goodreads\.com\//i,
    hint: 'user id or goodreads url',
  },
  {
    key: 'rssFeedUrl',
    name: 'rss',
    kind: 'url',
    hint: 'your-site.com/rss.xml',
  },
  {
    key: 'openToWork',
    name: 'open-to-work',
    kind: 'boolean',
    hint: 'yes / no',
  },
]

const FIELD_NAMES = PROFILE_FIELDS.map((f) => f.name)

type Profile = {
  handle: string
  displayName: string | null
  bio: string | null
  profileReadme: string | null
  websiteUrl: string | null
  blogUrl: string | null
  xUrl: string | null
  youtubeUrl: string | null
  instagramUrl: string | null
  goodreadsUrl: string | null
  rssFeedUrl: string | null
  githubUsername: string | null
  openToWork: boolean
  claimed: boolean
}

type PatchResponse = { updated: string[]; profile: Profile }

export type NormalizedValue =
  | { ok: true; value: string | boolean | null }
  | { ok: false; error: string }

/** Strip repeatedly until stable, so a pasted double prefix can't survive. */
function stripAll(pattern: RegExp, value: string): string {
  let out = value
  let prev: string
  do {
    prev = out
    out = out.replace(pattern, '')
  } while (out !== prev)
  return out
}

/**
 * Shape one raw CLI string into the value the API expects. Empty clears the
 * field. URLs get https:// prepended when the scheme is missing; handle fields
 * additionally accept a bare handle (`@mattbratos`, `mattbratos`) or a pasted
 * profile URL and rebuild the canonical link. A pasted URL on the canonical
 * host keeps its path (`x.com/me/status/1`, `youtube.com/channel/UC…`) — only
 * a bare handle gets the handle path. Real validation stays server-side.
 */
export function normalizeFieldValue(
  field: ProfileField,
  raw: string
): NormalizedValue {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }

  if (field.kind === 'boolean') {
    const word = trimmed.toLowerCase()
    if (TRUE_WORDS.has(word)) return { ok: true, value: true }
    if (FALSE_WORDS.has(word)) return { ok: true, value: false }
    return { ok: false, error: `${field.name} must be yes or no` }
  }

  if (field.kind === 'text' || field.kind === 'markdown') {
    return { ok: true, value: trimmed }
  }

  if (field.kind === 'handle' && field.base && field.strip) {
    const onSite = field.strip.test(trimmed)
    const cleaned = stripAll(field.strip, trimmed)
    const handle = cleaned.replace(/^@/, '')
    if (!handle) return { ok: true, value: null }
    // A path on the canonical site is kept as-is under the canonical origin.
    if (onSite && handle.includes('/')) {
      return { ok: true, value: field.base + cleaned }
    }
    // Anything else URL-shaped passes through as a URL; a bare handle gets
    // the canonical base. Dots alone don't make it a URL — instagram handles
    // can contain them.
    if (!onSite && (/^https?:\/\//i.test(handle) || handle.includes('/'))) {
      return { ok: true, value: ensureScheme(handle) }
    }
    return { ok: true, value: field.base + (field.handlePath ?? '') + handle }
  }

  return { ok: true, value: ensureScheme(trimmed) }
}

/**
 * Map a parsed yaml/json document to API fields. Keys may be CLI names
 * (`website`, `open-to-work`) or API keys (`websiteUrl`, `openToWork`);
 * unknown keys fail loudly so a typo can't silently drop a field.
 */
export function parseProfileDocument(doc: unknown):
  | { ok: true; fields: Record<string, string | boolean | null> }
  | {
      ok: false
      error: string
    } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: 'expected a mapping of fields to values' }
  }

  const fields: Record<string, string | boolean | null> = {}
  for (const [rawKey, rawValue] of Object.entries(doc)) {
    const field = PROFILE_FIELDS.find(
      (f) => f.name === rawKey || f.key === rawKey
    )
    if (!field) {
      return {
        ok: false,
        error: `unknown field "${rawKey}" (fields: ${FIELD_NAMES.join(', ')})`,
      }
    }

    if (rawValue === null) {
      fields[field.key] = null
      continue
    }
    if (typeof rawValue === 'boolean' && field.kind === 'boolean') {
      fields[field.key] = rawValue
      continue
    }
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      return { ok: false, error: `${field.name}: expected a string value` }
    }

    const normalized = normalizeFieldValue(field, String(rawValue))
    if (!normalized.ok) return normalized
    fields[field.key] = normalized.value
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'no fields to apply' }
  }
  return { ok: true, fields }
}

/** Value column for human output. */
export function displayValue(field: ProfileField, value: unknown): string {
  if (field.kind === 'boolean') return value ? 'yes' : 'no'
  if (value == null || value === '') return ''
  if (field.kind === 'markdown') return `${String(value).length} chars`
  return String(value)
}

// Login-shaped (DESIGN.md): only what's set, dim label + value, full
// clickable URLs. No `(not set)` spreadsheet — an empty field is silence.
export function renderProfile(profile: Profile, appUrl: string): string[] {
  const lines: string[] = []
  const title = profile.displayName
    ? `${bold(profile.displayName)} ${dim(`@${profile.handle}`)}`
    : bold(`@${profile.handle}`)
  lines.push(title)

  const rows: { label: string; value: string; isUrl: boolean }[] = []
  for (const f of PROFILE_FIELDS) {
    if (f.name === 'name') continue
    const raw = profile[f.key as keyof Profile]
    if (f.kind === 'boolean' ? !raw : raw == null || raw === '') continue
    rows.push({
      label: f.name,
      value: displayValue(f, raw),
      isUrl: f.kind === 'url' || f.kind === 'handle',
    })
  }
  if (profile.githubUsername) {
    rows.push({
      label: 'github',
      value: `https://github.com/${profile.githubUsername}`,
      isUrl: true,
    })
  }

  if (rows.length > 0) {
    lines.push('')
    const width = Math.max(...rows.map((r) => r.label.length))
    for (const row of rows) {
      const value = row.isUrl ? link(row.value) : row.value
      lines.push(`${dim(row.label.padEnd(width))}  ${value}`)
    }
  }

  lines.push('')
  lines.push(link(`${appUrl}/${profile.handle}`))
  return lines
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

// Help is plain console.log (DESIGN.md): no arrows, no echo of what they
// typed, no example dump. A table of the real surface, nothing else.
function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows.map(([k, v]) => `${dim(k.padEnd(width))}  ${v}`)
}

function usage(exitCode = 1): never {
  const lines = [
    'profile [view|set|edit|apply]',
    '',
    ...table([
      ['view', 'show your profile'],
      ['set <field> <value>', 'set one field'],
      ['set <url>', 'x, youtube, instagram, goodreads — field from the host'],
      ['edit', 'interactive editor'],
      ['apply <file>', 'fields from a yaml/json file'],
    ]),
    '',
    ...table([['--json', 'machine-readable (view, set, apply)']]),
  ]
  console.log(lines.join('\n'))
  process.exit(exitCode)
}

// Help for `hacklab profile set` on its own. The field table is derived from
// PROFILE_FIELDS so the help can't drift from what `set` actually accepts.
function setUsage(): never {
  const lines = [
    'profile set <field> <value>',
    'profile set <url>',
    '',
    ...table(PROFILE_FIELDS.map((f) => [f.name, f.hint])),
    '',
    ...table([
      ['--clear', 'unset'],
      ['--file <path>', 'readme from a file'],
      ['--json', 'machine-readable'],
    ]),
  ]
  console.log(lines.join('\n'))
  process.exit(0)
}

/**
 * `hacklab profile set https://x.com/mattbratos` — no field named, so pick it
 * from the host. Only handle fields are inferable: website, blog, and rss all
 * live on your own domain, so a bare URL there stays explicit.
 */
export function inferFieldFromUrl(token: string): ProfileField | null {
  if (!/^(?:https?:\/\/|www\.)|\.[a-z]{2,}(?:\/|$)/i.test(token)) return null
  return (
    PROFILE_FIELDS.find((f) => f.kind === 'handle' && f.strip?.test(token)) ??
    null
  )
}

async function fetchProfile(session: Session): Promise<Profile> {
  const res = await fetchApi(session, ME_PATH, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) throw new Error(await readApiError(res, session))
  const data = (await res.json().catch(() => null)) as {
    profile?: Profile
  } | null
  if (!data?.profile) throw new Error('got a malformed response from hacklab')
  return data.profile
}

async function patchProfile(
  session: Session,
  fields: Record<string, string | boolean | null>
): Promise<PatchResponse> {
  const res = await fetchApi(session, ME_PATH, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await readApiError(res, session))
  const data = (await res.json().catch(() => null)) as PatchResponse | null
  if (!data?.profile) throw new Error('got a malformed response from hacklab')
  return data
}

async function profileView(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const session = await requireSession(json)

  let profile: Profile
  try {
    profile = await fetchProfile(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  if (json) {
    printJson({ schemaVersion: 1, profile })
    return
  }
  console.log(renderProfile(profile, resolveAppUrl(session)).join('\n'))
}

async function profileSet(args: string[]): Promise<void> {
  const json = args.includes('--json')
  // Help first: before any flag parsing or requireSession, so `--help` never
  // touches the network. A bare `help` only counts in the field slot, so
  // `--file help` still reads a file called help.
  if (args[0] === 'help' || args.some((a) => a === '--help' || a === '-h')) {
    setUsage()
  }
  const clear = args.includes('--clear')
  const fileFlagIndex = args.indexOf('--file')
  const filePath = fileFlagIndex >= 0 ? args[fileFlagIndex + 1] : undefined
  if (fileFlagIndex >= 0 && (!filePath || filePath.startsWith('-'))) {
    if (json) emitJsonError('invalid_fields', '--file requires a path')
    error('--file requires a path')
    process.exit(1)
  }

  const ignoredIndexes = new Set<number>()
  for (const [index, arg] of args.entries()) {
    if (arg === '--json' || arg === '--clear') ignoredIndexes.add(index)
  }
  if (fileFlagIndex >= 0) {
    ignoredIndexes.add(fileFlagIndex)
    ignoredIndexes.add(fileFlagIndex + 1)
  }
  const rest = args.filter((_, index) => !ignoredIndexes.has(index))
  const [fieldToken, ...valueParts] = rest
  if (!fieldToken) {
    // A JSON consumer asked for machine output — a human help page would be
    // unparseable, so keep the error envelope.
    if (json) {
      emitJsonError(
        'invalid_fields',
        'usage: hacklab profile set <field> <value>'
      )
      process.exit(1)
    }
    setUsage()
  }

  let resolved = resolveCommand(fieldToken, FIELD_NAMES)
  // Pasted a URL instead of a field name? Infer the field from its host and
  // treat the URL as the value.
  if (resolved.kind === 'unknown') {
    const inferred = inferFieldFromUrl(fieldToken)
    if (inferred) {
      if (valueParts.length > 0 || filePath || clear) {
        const message = `${fieldToken} is a value — pass the field too: profile set ${inferred.name} ${fieldToken}`
        if (json) emitJsonError('invalid_fields', message)
        error(message)
        process.exit(1)
      }
      resolved = { kind: 'match', name: inferred.name }
      valueParts.push(fieldToken)
    } else if (/^(?:https?:\/\/|www\.)/i.test(fieldToken)) {
      const message = `can't tell which field ${fieldToken} is — profile set website|blog|rss ${fieldToken}`
      if (json) emitJsonError('invalid_fields', message)
      error(message)
      process.exit(1)
    }
  }
  if (resolved.kind === 'ambiguous') {
    if (json)
      emitJsonError(
        'invalid_fields',
        `ambiguous field: ${resolved.matches.join(', ')}`
      )
    error(`ambiguous field: ${fieldToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    if (json)
      emitJsonError(
        'invalid_fields',
        `unknown field "${fieldToken}" (fields: ${FIELD_NAMES.join(', ')})`
      )
    error(`unknown field: ${fieldToken} ${dim(`(${FIELD_NAMES.join(', ')})`)}`)
    process.exit(1)
  }
  const field = PROFILE_FIELDS.find((f) => f.name === resolved.name)
  if (!field) usage()

  if (clear && filePath) {
    if (json) emitJsonError('invalid_fields', 'use either --file or --clear')
    error('use either --file or --clear')
    process.exit(1)
  }
  if (filePath && valueParts.length > 0) {
    if (json)
      emitJsonError('invalid_fields', 'pass either a value or --file, not both')
    error('pass either a value or --file, not both')
    process.exit(1)
  }

  let rawValue = valueParts.join(' ')
  if (filePath) {
    try {
      rawValue = await readFile(filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const message =
        code === 'ENOENT'
          ? `file not found: ${filePath}`
          : `could not read ${filePath}`
      if (json) emitJsonError('read_failed', message)
      error(message)
      process.exit(1)
    }
  }
  if (!clear && !rawValue.trim()) {
    if (json) emitJsonError('invalid_fields', 'pass a value, or --clear')
    error(`pass a value, or ${dim('--clear')} to unset`)
    process.exit(1)
  }

  const normalized = clear
    ? ({ ok: true, value: null } as const)
    : normalizeFieldValue(field, rawValue)
  if (!normalized.ok) {
    if (json) emitJsonError('invalid_fields', normalized.error)
    error(normalized.error)
    process.exit(1)
  }

  const session = await requireSession(json)
  let result: PatchResponse
  try {
    result = await patchProfile(session, { [field.key]: normalized.value })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle, 'cli_profile_updated', {
    via: 'set',
    fields: [field.key],
  })

  if (json) {
    printJson({ schemaVersion: 1, ...result })
    return
  }
  const saved = displayValue(field, result.profile[field.key as keyof Profile])
  const shown =
    saved && (field.kind === 'url' || field.kind === 'handle')
      ? link(saved)
      : saved
  success(`saved ${field.name}${shown ? `: ${shown}` : ' (cleared)'}`)
  console.log(link(`${resolveAppUrl(session)}/${result.profile.handle}`))
}

async function profileApply(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const path = args.find((a) => !a.startsWith('-'))
  if (!path) usage()

  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message =
      code === 'ENOENT' ? `file not found: ${path}` : `could not read ${path}`
    if (json) emitJsonError('read_failed', message)
    error(message)
    process.exit(1)
  }

  let doc: unknown
  try {
    // YAML is a superset of JSON, so one parser covers both file shapes.
    doc = parseYaml(content)
  } catch (err) {
    const message = `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`
    if (json) emitJsonError('parse_failed', message)
    error(message)
    process.exit(1)
  }

  const parsed = parseProfileDocument(doc)
  if (!parsed.ok) {
    if (json) emitJsonError('invalid_fields', parsed.error)
    error(parsed.error)
    process.exit(1)
  }

  const session = await requireSession(json)
  let result: PatchResponse
  try {
    result = await patchProfile(session, parsed.fields)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) emitJsonError('error', message)
    error(message)
    process.exit(1)
  }

  await captureEvent(session.handle, 'cli_profile_updated', {
    via: 'apply',
    fields: result.updated,
  })

  if (json) {
    printJson({ schemaVersion: 1, ...result })
    return
  }
  const names = result.updated
    .map((key) => PROFILE_FIELDS.find((f) => f.key === key)?.name ?? key)
    .join(', ')
  success(
    `saved ${result.updated.length} field${result.updated.length === 1 ? '' : 's'}: ${names}`
  )
  console.log(renderProfile(result.profile, resolveAppUrl(session)).join('\n'))
}

// Autosave editor over your own profile, mirroring `hacklab org`: pick a
// field, set its value, it saves immediately — leaving loses nothing.
async function profileEdit(): Promise<void> {
  const session = await requireSession(false)
  clack.intro(bold('hacklab profile'))

  let profile: Profile
  try {
    profile = await fetchProfile(session)
  } catch (err) {
    clack.cancel(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const DONE = '__done__'
  let savedCount = 0
  const savedKeys = new Set<string>()

  while (true) {
    const choice = await clack.select({
      message: `editing ${bold(`@${profile.handle}`)} ${dim('(saves as you go)')}`,
      options: [
        ...PROFILE_FIELDS.map((f) => ({
          value: f.name,
          label: f.name,
          hint: displayValue(f, profile[f.key as keyof Profile]) || '(empty)',
        })),
        { value: DONE, label: '← done' },
      ],
    })
    if (clack.isCancel(choice) || choice === DONE) break

    const field = PROFILE_FIELDS.find((f) => f.name === choice)
    if (!field) continue

    let next: string | boolean | null
    if (field.kind === 'boolean') {
      const value = await clack.confirm({
        message: field.name,
        initialValue: Boolean(profile[field.key as keyof Profile]),
      })
      if (clack.isCancel(value)) continue
      next = value
    } else {
      const current = profile[field.key as keyof Profile]
      const value = await clack.text({
        message: `${field.name} ${dim(`(${field.hint}, blank to clear)`)}`,
        initialValue: current == null ? '' : String(current),
      })
      if (clack.isCancel(value)) continue
      const normalized = normalizeFieldValue(field, value)
      if (!normalized.ok) {
        error(normalized.error)
        continue
      }
      next = normalized.value
    }

    const spin = clack.spinner()
    spin.start(`saving ${field.name}`)
    try {
      const result = await patchProfile(session, { [field.key]: next })
      profile = result.profile
      savedCount++
      savedKeys.add(field.key)
      spin.stop(`saved ${field.name}`)
    } catch (err) {
      spin.stop(`could not save ${field.name}`)
      error(err instanceof Error ? err.message : String(err))
      // Stay in the loop so they can retry or edit something else.
    }
  }

  if (savedCount > 0) {
    await captureEvent(session.handle, 'cli_profile_updated', {
      via: 'edit',
      fields: [...savedKeys],
    })
    success(`saved ${savedCount} change${savedCount === 1 ? '' : 's'}`)
    info(`${resolveAppUrl(session)}/${profile.handle}`)
  }
  clack.outro(dim('done.'))
}

export async function profile(args: string[]): Promise<void> {
  const [subToken, ...rest] = args

  if (subToken === '--help' || subToken === '-h' || subToken === 'help') {
    usage(0)
  }

  // Bare `hacklab profile` shows the profile — the safe default; editing is
  // an explicit `edit` away.
  if (!subToken || subToken.startsWith('-')) {
    return profileView(args)
  }

  const resolved = resolveCommand(subToken, SUBCOMMANDS)
  if (resolved.kind === 'ambiguous') {
    error(`ambiguous: profile ${subToken} (${resolved.matches.join(', ')})`)
    process.exit(1)
  }
  if (resolved.kind === 'unknown') {
    error(`unknown subcommand: profile ${subToken}`)
    usage()
  }

  if (resolved.name === 'view') return profileView(rest)
  if (resolved.name === 'set') return profileSet(rest)
  if (resolved.name === 'edit') return profileEdit()
  if (resolved.name === 'apply') return profileApply(rest)
}
