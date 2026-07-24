import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Session } from '../session.js'
import { formatEssayDate, parseListTarget, readError } from './essay.js'

// The list-target grammar is the load-bearing design decision of `essay list`:
// user vs org is decided by ARGUMENT COUNT, never by whether the word "org"
// could be a username (reserved now, but legacy rows are conceivable).
describe('parseListTarget', () => {
  it('no args → your own essays', () => {
    expect(parseListTarget([])).toEqual({ kind: 'self' })
  })

  it('one arg → a user handle', () => {
    expect(parseListTarget(['ada'])).toEqual({ kind: 'user', handle: 'ada' })
  })

  it('`org <slug>` → an org', () => {
    expect(parseListTarget(['org', 'homebrew'])).toEqual({
      kind: 'org',
      slug: 'homebrew',
    })
  })

  it('`org/<slug>` mirrors the web URL form', () => {
    expect(parseListTarget(['org/homebrew'])).toEqual({
      kind: 'org',
      slug: 'homebrew',
    })
  })

  it('a bare `org` is the USER named org, not an org lookup', () => {
    expect(parseListTarget(['org'])).toEqual({ kind: 'user', handle: 'org' })
  })

  it('`org/` with no slug is invalid', () => {
    expect(parseListTarget(['org/'])).toEqual({ kind: 'invalid' })
  })

  it('three positionals are invalid', () => {
    expect(parseListTarget(['org', 'a', 'b'])).toEqual({ kind: 'invalid' })
  })

  it('two positionals not led by org are invalid', () => {
    expect(parseListTarget(['ada', 'lovelace'])).toEqual({ kind: 'invalid' })
  })
})

// A bare "Unauthorized" dead-ends the user: the server can't know which
// backend their token was minted against, so only the CLI can name the fix.
describe('readError', () => {
  afterEach(() => vi.unstubAllEnvs())

  const session: Session = {
    token: 't',
    email: 'user@example.com',
    appUrl: 'https://app.example.com',
    savedAt: '2026-01-01T00:00:00Z',
  }

  const unauthorized = () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })

  it('turns a 401 into the backend-mismatch hint when a session is given', async () => {
    vi.stubEnv('HACKLAB_APP_URL', 'http://localhost:3000')
    const msg = await readError(unauthorized(), session)
    expect(msg).toContain('hacklab login --env development')
    expect(msg).not.toBe('Unauthorized')
  })

  it('keeps the server text for a 401 on a public read (no session)', async () => {
    const msg = await readError(unauthorized())
    expect(msg).toBe('Unauthorized')
  })

  it('passes non-401 server errors through untouched', async () => {
    const res = new Response(JSON.stringify({ error: 'Title too long.' }), {
      status: 400,
    })
    expect(await readError(res, session)).toBe('Title too long.')
  })

  it('falls back to the status when the body is not JSON', async () => {
    const res = new Response('<html>502</html>', { status: 502 })
    expect(await readError(res, session)).toBe('request failed (502)')
  })
})

describe('formatEssayDate', () => {
  it('renders an absolute lowercase date', () => {
    expect(formatEssayDate('2026-07-12T10:00:00.000Z')).toMatch(
      /^jul 1[12] 2026$/ // day depends on the local timezone of the test host
    )
  })

  it('falls back to the raw string when unparseable', () => {
    expect(formatEssayDate('not-a-date')).toBe('not-a-date')
  })
})
