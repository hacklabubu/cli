import { describe, expect, it } from 'vitest'

import { claimReason, displayValue, slugify } from './org.js'

// These helpers are pure and have no I/O — test them directly.
// `unauthorizedHint` moved to session.ts — its tests live in session.test.ts.

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric runs with a single hyphen', () => {
    expect(slugify('Stripe, Inc.')).toBe('stripe-inc')
    expect(slugify('OpenAI')).toBe('openai')
    expect(slugify('  Hello   World  ')).toBe('hello-world')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--test--')).toBe('test')
    expect(slugify('!!!acme!!!')).toBe('acme')
  })

  it('falls back to "org" for an all-symbol name', () => {
    expect(slugify('---')).toBe('org')
    expect(slugify('   ')).toBe('org')
    expect(slugify('')).toBe('org')
  })

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long)).toHaveLength(64)
  })
})

describe('claimReason', () => {
  it('returns "email domain" for email-only path', () => {
    expect(claimReason('email')).toBe('email domain')
  })

  it('returns "member · email" when both paths qualify', () => {
    expect(claimReason('both')).toBe('member · email')
  })

  it('returns "member" for the member-only path (and as fallback)', () => {
    expect(claimReason('member')).toBe('member')
    // undefined / unexpected values also fall back to "member"
    expect(claimReason(undefined as never)).toBe('member')
  })
})

describe('displayValue', () => {
  const textSpec = { key: 'name', label: 'Name', type: 'text' as const }
  const urlSpec = { key: 'website', label: 'Website', type: 'url' as const }
  const boolSpec = {
    key: 'isHiring',
    label: 'Hiring?',
    type: 'boolean' as const,
  }
  const listSpec = { key: 'tags', label: 'Tags', type: 'list' as const }
  const numSpec = {
    key: 'teamSize',
    label: 'Team size',
    type: 'number' as const,
  }

  it('returns "(empty)" for null, undefined, and empty string', () => {
    expect(displayValue(textSpec, null)).toBe('(empty)')
    expect(displayValue(textSpec, undefined)).toBe('(empty)')
    expect(displayValue(textSpec, '')).toBe('(empty)')
  })

  it('renders booleans as "yes" / "no"', () => {
    expect(displayValue(boolSpec, true)).toBe('yes')
    expect(displayValue(boolSpec, false)).toBe('no')
  })

  it('joins list arrays with commas', () => {
    expect(displayValue(listSpec, ['AI', 'Dev Tools'])).toBe('AI, Dev Tools')
  })

  it('returns "(empty)" for an empty array list', () => {
    expect(displayValue(listSpec, [])).toBe('(empty)')
  })

  it('coerces non-array list value to string', () => {
    expect(displayValue(listSpec, 'just-a-string')).toBe('just-a-string')
  })

  it('truncates long text at 48 chars with an ellipsis', () => {
    const long = 'x'.repeat(60)
    const result = displayValue(textSpec, long)
    expect(result).toHaveLength(48) // 47 chars + '…'
    expect(result.endsWith('…')).toBe(true)
  })

  it('keeps short text unchanged', () => {
    expect(displayValue(textSpec, 'Acme')).toBe('Acme')
    expect(displayValue(urlSpec, 'https://acme.com')).toBe('https://acme.com')
  })

  it('renders numbers as strings', () => {
    expect(displayValue(numSpec, 42)).toBe('42')
  })
})
