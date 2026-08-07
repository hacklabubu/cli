import { ensureScheme } from './field-normalize.js'

// The job-listing field surface for `hacklab org jobs post`. One row per field
// a poster supplies, in the order the interactive flow asks for them. Mirrors
// the server's jobCreateSchema (apps/web/lib/job-payload.ts) — the real
// validation boundary; this side just shapes input and catches the obvious
// mistakes before anyone is sent to a payment page.

export type JobFieldType = 'text' | 'url' | 'email' | 'number' | 'choice'

export type JobFieldSpec = {
  /** API key sent inside `fields`. */
  key: string
  /** CLI flag name, used as `--<name>`. */
  name: string
  /** Label shown in the interactive flow. */
  label: string
  type: JobFieldType
  required: boolean
  /** Allowed values for a `choice` field. */
  choices?: readonly string[]
  placeholder?: string
}

export const REMOTE_ONSITE = ['remote', 'onsite', 'hybrid'] as const

export const JOB_FIELDS: JobFieldSpec[] = [
  {
    key: 'roleTitle',
    name: 'role',
    label: 'Role title',
    type: 'text',
    required: true,
    placeholder: 'Staff Engineer',
  },
  {
    key: 'description',
    name: 'description',
    label: 'Description',
    type: 'text',
    required: true,
    placeholder: 'What the role involves, who you are looking for…',
  },
  {
    key: 'atsUrl',
    name: 'apply-url',
    label: 'Application URL',
    type: 'url',
    required: true,
    placeholder: 'https://your-company.com/careers/…',
  },
  {
    key: 'contactEmail',
    name: 'contact',
    label: 'Contact email',
    type: 'email',
    required: true,
    placeholder: 'hiring@company.com',
  },
  {
    key: 'companyName',
    name: 'company',
    label: 'Company name',
    type: 'text',
    // Defaulted from the org you post as, so the flow only asks when it has to.
    required: false,
  },
  {
    key: 'companyUrl',
    name: 'company-url',
    label: 'Company website',
    type: 'url',
    required: false,
  },
  {
    key: 'salaryRange',
    name: 'salary',
    label: 'Salary range',
    type: 'text',
    required: false,
    placeholder: '$150K-$200K',
  },
  {
    key: 'remoteOnsite',
    name: 'work-style',
    label: 'Work style',
    type: 'choice',
    required: false,
    choices: REMOTE_ONSITE,
  },
  {
    key: 'beltRankMin',
    name: 'min-belt',
    label: 'Minimum belt rank',
    type: 'number',
    required: false,
  },
]

export const JOB_FIELD_NAMES = JOB_FIELDS.map((f) => f.name)

export type JobValue = string | number | null

export type NormalizedJobValue =
  | { ok: true; value: JobValue }
  | { ok: false; error: string }

/**
 * Shape one raw CLI string into the value the API expects. Empty clears an
 * optional field; a required field refuses to be empty. URLs get https://
 * prepended when the scheme is missing. Real validation (lengths, URL syntax,
 * email syntax) stays server-side — this is the cheap check that saves a
 * round-trip, not the authority.
 */
export function normalizeJobFieldValue(
  spec: JobFieldSpec,
  raw: string
): NormalizedJobValue {
  const trimmed = raw.trim()
  if (!trimmed) {
    if (spec.required) return { ok: false, error: `${spec.name} is required` }
    return { ok: true, value: null }
  }

  if (spec.type === 'number') {
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, error: `${spec.name} must be a whole number` }
    }
    return { ok: true, value: Number(trimmed) }
  }

  if (spec.type === 'choice') {
    const word = trimmed.toLowerCase()
    if (!spec.choices?.includes(word)) {
      return {
        ok: false,
        error: `${spec.name} must be one of: ${spec.choices?.join(', ')}`,
      }
    }
    return { ok: true, value: word }
  }

  if (spec.type === 'url') return { ok: true, value: ensureScheme(trimmed) }

  if (spec.type === 'email') {
    // Deliberately loose: the server owns the real rule. This only catches the
    // "you typed a name, not an address" case before a payment page.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      return { ok: false, error: `${spec.name} must be an email address` }
    }
    return { ok: true, value: trimmed }
  }

  return { ok: true, value: trimmed }
}

/**
 * Build the `fields` payload from parsed `--flag value` options.
 *
 * `companyName` falls back to the org's name: you are posting *as* a company,
 * so making people retype it would only create a way for the two to disagree.
 */
export function buildJobFields(
  options: Record<string, string | undefined>,
  fallbackCompanyName: string
):
  | { ok: true; fields: Record<string, JobValue> }
  | { ok: false; error: string } {
  const fields: Record<string, JobValue> = {}

  for (const spec of JOB_FIELDS) {
    const raw = options[spec.name]
    if (raw === undefined) {
      if (spec.key === 'companyName') {
        fields.companyName = fallbackCompanyName
        continue
      }
      if (spec.required) {
        return { ok: false, error: `pass --${spec.name}` }
      }
      continue
    }
    const normalized = normalizeJobFieldValue(spec, raw)
    if (!normalized.ok) return normalized
    if (normalized.value !== null) fields[spec.key] = normalized.value
  }

  if (!fields.companyName) fields.companyName = fallbackCompanyName
  return { ok: true, fields }
}
