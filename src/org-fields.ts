import { ensureScheme, FALSE_WORDS, TRUE_WORDS } from './field-normalize.js'

// The org field surface for `hacklab org`'s agent verbs (set/apply) and the
// interactive editor. One row per editable column, in display order. Mirrors
// the server's orgFieldShape (apps/web/lib/org-payload.ts) — the real
// validation boundary; this side just shapes input.

export type OrgFieldType = 'text' | 'url' | 'number' | 'boolean' | 'list'

export type OrgFieldSpec = {
  /** API key sent to /api/cli/org. */
  key: string
  /** CLI-facing name (`hacklab org set <name> …`). */
  name: string
  /** Label shown in the interactive editor. */
  label: string
  type: OrgFieldType
}

export const ORG_FIELDS: OrgFieldSpec[] = [
  { key: 'name', name: 'name', label: 'Name', type: 'text' },
  { key: 'slug', name: 'slug', label: 'Slug (URL handle)', type: 'text' },
  { key: 'logoUrl', name: 'logo', label: 'Logo URL', type: 'url' },
  { key: 'website', name: 'website', label: 'Website', type: 'url' },
  {
    key: 'description',
    name: 'description',
    label: 'Short description',
    type: 'text',
  },
  {
    key: 'longDescription',
    name: 'long-description',
    label: 'Long description',
    type: 'text',
  },
  { key: 'ycBatch', name: 'yc-batch', label: 'YC batch', type: 'text' },
  { key: 'ycSlug', name: 'yc-slug', label: 'YC slug', type: 'text' },
  { key: 'ycUrl', name: 'yc-url', label: 'YC URL', type: 'url' },
  { key: 'waasUrl', name: 'waas', label: 'WaaS URL', type: 'url' },
  { key: 'teamSize', name: 'team-size', label: 'Team size', type: 'number' },
  { key: 'status', name: 'status', label: 'Status', type: 'text' },
  { key: 'stage', name: 'stage', label: 'Stage', type: 'text' },
  { key: 'isHiring', name: 'hiring', label: 'Hiring?', type: 'boolean' },
  { key: 'industries', name: 'industries', label: 'Industries', type: 'list' },
  { key: 'tags', name: 'tags', label: 'Tags', type: 'list' },
  { key: 'locations', name: 'locations', label: 'Locations', type: 'list' },
]

export const ORG_FIELD_NAMES = ORG_FIELDS.map((f) => f.name)

// name and slug are notNull columns — a blank must fail loudly, not clear.
const REQUIRED_KEYS = new Set(['name', 'slug'])

export type OrgValue = string | number | boolean | string[] | null

export type NormalizedOrgValue =
  | { ok: true; value: OrgValue }
  | { ok: false; error: string }

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Shape one raw CLI string into the value the API expects. Empty clears the
 * field (except name/slug, which are required). URLs get https:// prepended
 * when the scheme is missing; lists split on commas. Real validation (slug
 * pattern, lengths, URL syntax) stays server-side.
 */
export function normalizeOrgFieldValue(
  spec: OrgFieldSpec,
  raw: string
): NormalizedOrgValue {
  const trimmed = raw.trim()
  if (!trimmed) {
    if (REQUIRED_KEYS.has(spec.key)) {
      return { ok: false, error: `${spec.name} can't be empty` }
    }
    return { ok: true, value: null }
  }

  if (spec.type === 'boolean') {
    const word = trimmed.toLowerCase()
    if (TRUE_WORDS.has(word)) return { ok: true, value: true }
    if (FALSE_WORDS.has(word)) return { ok: true, value: false }
    return { ok: false, error: `${spec.name} must be yes or no` }
  }

  if (spec.type === 'number') {
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, error: `${spec.name} must be a whole number` }
    }
    return { ok: true, value: Number(trimmed) }
  }

  if (spec.type === 'list') {
    const items = splitList(trimmed)
    return { ok: true, value: items.length ? items : null }
  }

  if (spec.type === 'url') return { ok: true, value: ensureScheme(trimmed) }

  return { ok: true, value: trimmed }
}

/**
 * Map a parsed yaml/json document to API fields for `org apply`. Keys may be
 * CLI names (`long-description`, `hiring`) or API keys (`longDescription`,
 * `isHiring`); unknown keys fail loudly so a typo can't silently drop a field.
 * Lists accept real arrays or comma-separated strings.
 */
export function parseOrgDocument(doc: unknown):
  | { ok: true; fields: Record<string, OrgValue> }
  | {
      ok: false
      error: string
    } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: 'expected a mapping of fields to values' }
  }

  const fields: Record<string, OrgValue> = {}
  for (const [rawKey, rawValue] of Object.entries(doc)) {
    const spec = ORG_FIELDS.find((f) => f.name === rawKey || f.key === rawKey)
    if (!spec) {
      return {
        ok: false,
        error: `unknown field "${rawKey}" (fields: ${ORG_FIELD_NAMES.join(', ')})`,
      }
    }

    if (rawValue === null) {
      if (REQUIRED_KEYS.has(spec.key)) {
        return { ok: false, error: `${spec.name} can't be empty` }
      }
      fields[spec.key] = null
      continue
    }

    if (typeof rawValue === 'boolean') {
      if (spec.type !== 'boolean') {
        return { ok: false, error: `${spec.name}: expected a string value` }
      }
      fields[spec.key] = rawValue
      continue
    }

    if (Array.isArray(rawValue)) {
      if (spec.type !== 'list') {
        return { ok: false, error: `${spec.name}: expected a single value` }
      }
      const items = rawValue.map((v) => String(v).trim()).filter(Boolean)
      fields[spec.key] = items.length ? items : null
      continue
    }

    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      return { ok: false, error: `${spec.name}: expected a string value` }
    }

    const normalized = normalizeOrgFieldValue(spec, String(rawValue))
    if (!normalized.ok) return normalized
    fields[spec.key] = normalized.value
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'no fields to apply' }
  }
  return { ok: true, fields }
}

/**
 * Pick the org a view/set/apply targets. `--org <slug>` wins; with no flag,
 * exactly one managed org is the target, zero or several is a typed error the
 * caller renders (JSON gets the code, humans get the message — which always
 * names the way out).
 */
export function resolveTargetOrg<T extends { slug: string }>(
  organizations: T[],
  slugFlag: string | undefined
):
  | { ok: true; org: T }
  | {
      ok: false
      code: 'no_org' | 'ambiguous_org' | 'not_found'
      error: string
    } {
  if (slugFlag) {
    const found = organizations.find((o) => o.slug === slugFlag)
    if (found) return { ok: true, org: found }
    const yours = organizations.map((o) => o.slug).join(', ')
    return {
      ok: false,
      code: 'not_found',
      error: organizations.length
        ? `you don't manage "${slugFlag}" (you manage: ${yours})`
        : `you don't manage "${slugFlag}" — claim or create it first`,
    }
  }

  if (organizations.length === 0) {
    return {
      ok: false,
      code: 'no_org',
      error:
        "you don't manage a company yet — run `hacklab org claim <slug>` or `hacklab org create`",
    }
  }
  if (organizations.length > 1) {
    const slugs = organizations.map((o) => o.slug).join(', ')
    return {
      ok: false,
      code: 'ambiguous_org',
      error: `you manage ${organizations.length} companies — pass --org <slug> (${slugs})`,
    }
  }
  return { ok: true, org: organizations[0]! }
}
