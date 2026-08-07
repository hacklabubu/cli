import { describe, expect, it } from 'vitest'

import {
  buildJobFields,
  JOB_FIELDS,
  normalizeJobFieldValue,
} from './job-fields.js'

const spec = (name: string) => {
  const found = JOB_FIELDS.find((f) => f.name === name)
  if (!found) throw new Error(`no such field: ${name}`)
  return found
}

describe('normalizeJobFieldValue', () => {
  it('refuses to blank a required field', () => {
    expect(normalizeJobFieldValue(spec('role'), '  ')).toEqual({
      ok: false,
      error: 'role is required',
    })
  })

  it('clears an optional field left empty', () => {
    expect(normalizeJobFieldValue(spec('salary'), '')).toEqual({
      ok: true,
      value: null,
    })
  })

  it('adds a scheme to a bare host so the server’s URL check passes', () => {
    expect(normalizeJobFieldValue(spec('apply-url'), 'acme.com/jobs')).toEqual({
      ok: true,
      value: 'https://acme.com/jobs',
    })
  })

  it('takes a whole number for the belt floor and nothing else', () => {
    expect(normalizeJobFieldValue(spec('min-belt'), '20')).toEqual({
      ok: true,
      value: 20,
    })
    expect(normalizeJobFieldValue(spec('min-belt'), '20.5').ok).toBe(false)
  })

  it('holds work style to the three the schema allows, case-insensitively', () => {
    expect(normalizeJobFieldValue(spec('work-style'), 'Remote')).toEqual({
      ok: true,
      value: 'remote',
    })
    const bad = normalizeJobFieldValue(spec('work-style'), 'lunar')
    expect(bad.ok).toBe(false)
  })

  // Deliberately loose — the server owns the real rule. This only saves a
  // round-trip (and a trip to a payment page) on an obvious mistake.
  it('catches a contact that is plainly not an address', () => {
    expect(normalizeJobFieldValue(spec('contact'), 'Jane Doe').ok).toBe(false)
    expect(normalizeJobFieldValue(spec('contact'), 'jane@acme.com')).toEqual({
      ok: true,
      value: 'jane@acme.com',
    })
  })
})

describe('buildJobFields', () => {
  const REQUIRED = {
    role: 'Staff Engineer',
    description: 'Build things.',
    'apply-url': 'https://acme.com/jobs/1',
    contact: 'hiring@acme.com',
  }

  it('maps CLI flag names to API keys', () => {
    const built = buildJobFields(REQUIRED, 'Acme')
    expect(built).toEqual({
      ok: true,
      fields: {
        roleTitle: 'Staff Engineer',
        description: 'Build things.',
        atsUrl: 'https://acme.com/jobs/1',
        contactEmail: 'hiring@acme.com',
        companyName: 'Acme',
      },
    })
  })

  // You are posting *as* a company; making people retype its name would only
  // create a way for the listing and the company page to disagree.
  it('defaults the company name to the org, and lets a flag override it', () => {
    expect(
      (buildJobFields(REQUIRED, 'Acme') as { fields: Record<string, unknown> })
        .fields.companyName
    ).toBe('Acme')
    expect(
      (
        buildJobFields({ ...REQUIRED, company: 'Acme Labs' }, 'Acme') as {
          fields: Record<string, unknown>
        }
      ).fields.companyName
    ).toBe('Acme Labs')
  })

  it('names the missing flag rather than failing at the server', () => {
    const { role: _role, ...withoutRole } = REQUIRED
    expect(buildJobFields(withoutRole, 'Acme')).toEqual({
      ok: false,
      error: 'pass --role',
    })
  })

  it('leaves optional fields out of the payload entirely when unset', () => {
    const built = buildJobFields(REQUIRED, 'Acme') as {
      fields: Record<string, unknown>
    }
    expect(built.fields).not.toHaveProperty('salaryRange')
    expect(built.fields).not.toHaveProperty('remoteOnsite')
  })
})
