import { describe, expect, it } from 'vitest'

import {
  normalizeOrgFieldValue,
  ORG_FIELDS,
  type OrgFieldSpec,
  parseOrgDocument,
  resolveTargetOrg,
} from './org-fields.js'

function field(name: string): OrgFieldSpec {
  const found = ORG_FIELDS.find((f) => f.name === name)
  if (!found) throw new Error(`no field named ${name}`)
  return found
}

describe('normalizeOrgFieldValue', () => {
  it('clears optional fields on blank input', () => {
    expect(normalizeOrgFieldValue(field('description'), '')).toEqual({
      ok: true,
      value: null,
    })
    expect(normalizeOrgFieldValue(field('website'), '   ')).toEqual({
      ok: true,
      value: null,
    })
  })

  it('refuses to blank the required name and slug', () => {
    expect(normalizeOrgFieldValue(field('name'), '').ok).toBe(false)
    expect(normalizeOrgFieldValue(field('slug'), '  ').ok).toBe(false)
  })

  it('parses boolean words for hiring', () => {
    expect(normalizeOrgFieldValue(field('hiring'), 'yes')).toEqual({
      ok: true,
      value: true,
    })
    expect(normalizeOrgFieldValue(field('hiring'), 'OFF')).toEqual({
      ok: true,
      value: false,
    })
    expect(normalizeOrgFieldValue(field('hiring'), 'maybe').ok).toBe(false)
  })

  it('parses team-size as a whole number', () => {
    expect(normalizeOrgFieldValue(field('team-size'), '12')).toEqual({
      ok: true,
      value: 12,
    })
    expect(normalizeOrgFieldValue(field('team-size'), 'twelve').ok).toBe(false)
    expect(normalizeOrgFieldValue(field('team-size'), '1.5').ok).toBe(false)
  })

  it('splits list fields on commas', () => {
    expect(normalizeOrgFieldValue(field('tags'), 'ai, dev tools , ')).toEqual({
      ok: true,
      value: ['ai', 'dev tools'],
    })
  })

  it('prepends https:// to schemeless URLs', () => {
    expect(normalizeOrgFieldValue(field('website'), 'acme.com')).toEqual({
      ok: true,
      value: 'https://acme.com',
    })
    expect(
      normalizeOrgFieldValue(field('logo'), 'https://acme.com/logo.png')
    ).toEqual({ ok: true, value: 'https://acme.com/logo.png' })
  })
})

describe('parseOrgDocument', () => {
  it('accepts CLI names and API keys', () => {
    const parsed = parseOrgDocument({
      'long-description': 'The pitch.',
      isHiring: true,
      teamSize: 12,
    })
    expect(parsed).toEqual({
      ok: true,
      fields: { longDescription: 'The pitch.', isHiring: true, teamSize: 12 },
    })
  })

  it('accepts real arrays and comma-separated strings for lists', () => {
    const parsed = parseOrgDocument({
      industries: ['AI', ' Robotics '],
      locations: 'Warsaw, Remote',
    })
    expect(parsed).toEqual({
      ok: true,
      fields: {
        industries: ['AI', 'Robotics'],
        locations: ['Warsaw', 'Remote'],
      },
    })
  })

  it('null clears optional fields but never name/slug', () => {
    expect(parseOrgDocument({ website: null })).toEqual({
      ok: true,
      fields: { website: null },
    })
    expect(parseOrgDocument({ name: null }).ok).toBe(false)
  })

  it('rejects unknown keys loudly', () => {
    const parsed = parseOrgDocument({ hirring: true })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('hirring')
  })

  it('rejects type mismatches and empty documents', () => {
    expect(parseOrgDocument({ website: true }).ok).toBe(false)
    expect(parseOrgDocument({ hiring: ['yes'] }).ok).toBe(false)
    expect(parseOrgDocument({}).ok).toBe(false)
    expect(parseOrgDocument('nope').ok).toBe(false)
  })
})

describe('resolveTargetOrg', () => {
  const acme = { slug: 'acme' }
  const beta = { slug: 'beta' }

  it('targets the single managed org with no flag', () => {
    expect(resolveTargetOrg([acme], undefined)).toEqual({ ok: true, org: acme })
  })

  it('errors no_org when nothing is managed', () => {
    const r = resolveTargetOrg([], undefined)
    expect(r).toMatchObject({ ok: false, code: 'no_org' })
  })

  it('errors ambiguous_org with the slugs when several are managed', () => {
    const r = resolveTargetOrg([acme, beta], undefined)
    expect(r).toMatchObject({ ok: false, code: 'ambiguous_org' })
    if (!r.ok) expect(r.error).toContain('acme, beta')
  })

  it('--org picks by slug, and misses are not_found', () => {
    expect(resolveTargetOrg([acme, beta], 'beta')).toEqual({
      ok: true,
      org: beta,
    })
    expect(resolveTargetOrg([acme], 'ghost')).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })
})
