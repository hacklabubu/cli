import { readFile } from 'node:fs/promises'

import * as clack from '@clack/prompts'
import { parse as parseYaml } from 'yaml'

import { emitJsonError, readApiError, requireSession } from '../api-client.js'
import { ensureScheme, FALSE_WORDS, TRUE_WORDS } from '../field-normalize.js'
import { captureEvent } from '../posthog.js'
import { resolveCommand } from '../resolve-command.js'
import { resolveAppUrl, type Session } from '../session.js'
import { fetchApi } from '../sync.js'
import { bold, dim, error, info, success } from '../ui.js'

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
  /** handle kind: URL prepended to a bare handle. */
  base?: string
  /** handle kind: recognized site prefixes to strip before rebuilding. */
  strip?: RegExp
  hint: string
}

// Mirrors the server's parseProfilePatch surface (apps/web/lib/profile-fields.ts)
// — the real validation boundary; this side just shapes input.
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
    kind: 'url',
    hint: 'youtube.com/@channel',
  },
  {
    key: 'instagramUrl',
    name: 'instagram',
    kind: 'handle',
    base: 'https://instagram.com/',
    strip: /^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i,
    hint: 'handle or instagram.com url',
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
 * profile URL and rebuild the canonical link. Real validation stays server-side.
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
    const cleaned = stripAll(field.strip, trimmed).replace(/^@/, '')
    if (!cleaned) return { ok: true, value: null }
    // Anything still URL-shaped passes through as a URL; a bare handle gets
    // the canonical base. Dots alone don't make it a URL — instagram handles
    // can contain them.
    if (/^https?:\/\//i.test(cleaned) || cleaned.includes('/')) {
      return { ok: true, value: ensureScheme(cleaned) }
    }
    return { ok: true, value: field.base + cleaned }
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

export function renderProfile(profile: Profile, appUrl: string): string[] {
  const lines: string[] = []
  const title = profile.displayName
    ? `${bold(profile.displayName)} ${dim(`@${profile.handle}`)}`
    : bold(`@${profile.handle}`)
  lines.push(`  ${title}`)
  lines.push('')

  const rows: { label: string; value: string; note?: string }[] =
    PROFILE_FIELDS.filter((f) => f.name !== 'name').map((f) => ({
      label: f.name,
      value: displayValue(f, profile[f.key as keyof Profile]),
    }))
  rows.push({
    label: 'github',
    value: profile.githubUsername
      ? `https://github.com/${profile.githubUsername}`
      : '',
    note: 'from github login',
  })

  const width = Math.max(...rows.map((r) => r.label.length))
  for (const row of rows) {
    const label = dim(row.label.padEnd(width))
    const value = row.value || dim('(not set)')
    const note = row.note ? ` ${dim(`(${row.note})`)}` : ''
    lines.push(`  ${label}  ${value}${note}`)
  }

  lines.push('')
  lines.push(`  ${dim(`${appUrl}/${profile.handle}`)}`)
  return lines
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function usage(exitCode = 1): never {
  if (exitCode === 0) info('usage: hacklab profile [view|set|edit|apply]')
  else error('usage: hacklab profile [view|set|edit|apply]')
  info(`  hacklab profile ${dim('view [--json]')}            show your profile`)
  info(
    `  hacklab profile ${dim('set <field> <value>')}      set one field (--file for long content, --clear to unset)`
  )
  info(
    `  hacklab profile ${dim('edit')}                     interactive editor`
  )
  info(
    `  hacklab profile ${dim('apply <file> [--json]')}    apply fields from a yaml/json file`
  )
  info(`  fields: ${dim(FIELD_NAMES.join(', '))}`)
  process.exit(exitCode)
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
  if (!fieldToken) usage()

  const resolved = resolveCommand(fieldToken, FIELD_NAMES)
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
    error(`unknown field: ${fieldToken}`)
    info(`fields: ${dim(FIELD_NAMES.join(', '))}`)
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
    info(`usage: hacklab profile set ${field.name} <${field.hint}>`)
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
  success(`saved ${field.name}${saved ? `: ${saved}` : ' (cleared)'}`)
  info(dim(`${resolveAppUrl(session)}/${result.profile.handle}`))
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
