import { describe, expect, it } from 'vitest'

import {
  displayValue,
  inferFieldFromUrl,
  normalizeFieldValue,
  PROFILE_FIELDS,
  type ProfileField,
  parseProfileDocument,
} from './profile.js'

function field(name: string): ProfileField {
  const found = PROFILE_FIELDS.find((f) => f.name === name)
  if (!found) throw new Error(`no field named ${name}`)
  return found
}

describe('normalizeFieldValue', () => {
  it('clears on empty or whitespace input', () => {
    expect(normalizeFieldValue(field('bio'), '')).toEqual({
      ok: true,
      value: null,
    })
    expect(normalizeFieldValue(field('website'), '   ')).toEqual({
      ok: true,
      value: null,
    })
  })

  it('trims text fields', () => {
    expect(normalizeFieldValue(field('name'), '  Matt B  ')).toEqual({
      ok: true,
      value: 'Matt B',
    })
  })

  it('accepts multiline markdown for the profile readme', () => {
    expect(
      normalizeFieldValue(field('readme'), '  # Hello\n\nBuilt stuff.  ')
    ).toEqual({
      ok: true,
      value: '# Hello\n\nBuilt stuff.',
    })
  })

  it('prepends https:// to schemeless URLs', () => {
    expect(normalizeFieldValue(field('website'), 'bratos.xyz')).toEqual({
      ok: true,
      value: 'https://bratos.xyz',
    })
    expect(normalizeFieldValue(field('website'), 'https://bratos.xyz')).toEqual(
      { ok: true, value: 'https://bratos.xyz' }
    )
    expect(normalizeFieldValue(field('rss'), 'bratos.xyz/rss.xml')).toEqual({
      ok: true,
      value: 'https://bratos.xyz/rss.xml',
    })
  })

  it('builds the youtube @channel link from a handle or pasted URL', () => {
    for (const input of [
      'error529',
      '@error529',
      'youtube.com/@error529',
      'https://www.youtube.com/@error529',
      'm.youtube.com/@error529',
    ]) {
      expect(normalizeFieldValue(field('youtube'), input)).toEqual({
        ok: true,
        value: 'https://youtube.com/@error529',
      })
    }
  })

  it('builds the goodreads profile link from a user id or pasted URL', () => {
    expect(normalizeFieldValue(field('goodreads'), '12345')).toEqual({
      ok: true,
      value: 'https://www.goodreads.com/user/show/12345',
    })
    expect(
      normalizeFieldValue(
        field('goodreads'),
        'https://www.goodreads.com/user/show/12345-matt'
      )
    ).toEqual({
      ok: true,
      value: 'https://www.goodreads.com/user/show/12345-matt',
    })
  })

  it('keeps a non-handle path on the canonical site', () => {
    expect(
      normalizeFieldValue(field('x'), 'https://x.com/mattbratos/status/1')
    ).toEqual({ ok: true, value: 'https://x.com/mattbratos/status/1' })
    expect(
      normalizeFieldValue(field('youtube'), 'youtube.com/channel/UCabc')
    ).toEqual({ ok: true, value: 'https://youtube.com/channel/UCabc' })
    expect(
      normalizeFieldValue(
        field('goodreads'),
        'goodreads.com/review/list/12345?shelf=read'
      )
    ).toEqual({
      ok: true,
      value: 'https://www.goodreads.com/review/list/12345?shelf=read',
    })
  })

  it('builds the canonical x link from a bare handle, @handle, or pasted URL', () => {
    for (const input of [
      'mattbratos',
      '@mattbratos',
      'x.com/mattbratos',
      'https://x.com/mattbratos',
      'https://twitter.com/mattbratos',
      'www.twitter.com/mattbratos',
    ]) {
      expect(normalizeFieldValue(field('x'), input)).toEqual({
        ok: true,
        value: 'https://x.com/mattbratos',
      })
    }
  })

  it('keeps dots in instagram handles (dots alone are not a URL)', () => {
    expect(normalizeFieldValue(field('instagram'), 'matt.bratos')).toEqual({
      ok: true,
      value: 'https://instagram.com/matt.bratos',
    })
  })

  it('passes non-canonical URL-shaped input through as a URL', () => {
    expect(normalizeFieldValue(field('x'), 'some.site/me')).toEqual({
      ok: true,
      value: 'https://some.site/me',
    })
  })

  it('survives a pasted double prefix', () => {
    expect(normalizeFieldValue(field('x'), 'x.com/x.com/mattbratos')).toEqual({
      ok: true,
      value: 'https://x.com/mattbratos',
    })
  })

  it('parses boolean words and rejects the rest', () => {
    const otw = field('open-to-work')
    expect(normalizeFieldValue(otw, 'yes')).toEqual({ ok: true, value: true })
    expect(normalizeFieldValue(otw, 'FALSE')).toEqual({
      ok: true,
      value: false,
    })
    expect(normalizeFieldValue(otw, 'maybe').ok).toBe(false)
  })
})

describe('parseProfileDocument', () => {
  it('accepts CLI names and API keys, normalizing values', () => {
    const parsed = parseProfileDocument({
      name: 'Matt',
      readme: '# Builder',
      websiteUrl: 'bratos.xyz',
      x: '@mattbratos',
      'open-to-work': true,
    })
    expect(parsed).toEqual({
      ok: true,
      fields: {
        displayName: 'Matt',
        profileReadme: '# Builder',
        websiteUrl: 'https://bratos.xyz',
        xUrl: 'https://x.com/mattbratos',
        openToWork: true,
      },
    })
  })

  it('maps null and empty string to a cleared field', () => {
    const parsed = parseProfileDocument({ bio: null, website: '' })
    expect(parsed).toEqual({
      ok: true,
      fields: { bio: null, websiteUrl: null },
    })
  })

  it('rejects unknown keys, naming the valid fields', () => {
    const parsed = parseProfileDocument({ twitter: 'mattbratos' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('twitter')
      expect(parsed.error).toContain('x')
    }
  })

  it('rejects non-mapping documents and empty ones', () => {
    expect(parseProfileDocument('just a string').ok).toBe(false)
    expect(parseProfileDocument(['a']).ok).toBe(false)
    expect(parseProfileDocument(null).ok).toBe(false)
    expect(parseProfileDocument({}).ok).toBe(false)
  })

  it('rejects a boolean on a non-boolean field', () => {
    expect(parseProfileDocument({ bio: true }).ok).toBe(false)
  })
})

describe('platform handles', () => {
  it('rebuilds the canonical link for every handle field from its own placeholder', () => {
    // Each handle field must round-trip: bare handle → base+handlePath+handle,
    // and that URL pasted back → unchanged. Guards every row in the table.
    for (const f of PROFILE_FIELDS) {
      if (f.kind !== 'handle' || !f.base) continue
      const built = normalizeFieldValue(f, 'someone')
      expect(built).toEqual({
        ok: true,
        value: `${f.base}${f.handlePath ?? ''}someone`,
      })
      if (!built.ok || typeof built.value !== 'string') throw new Error()
      expect(normalizeFieldValue(f, built.value)).toEqual(built)
      expect(inferFieldFromUrl(built.value)?.name).toBe(f.name)
    }
  })

  it('handles the odd hosts: linkedin locales, spotify open., farcaster/warpcast', () => {
    expect(
      normalizeFieldValue(field('linkedin'), 'https://pl.linkedin.com/in/matt')
    ).toEqual({ ok: true, value: 'https://www.linkedin.com/in/matt' })
    expect(normalizeFieldValue(field('linkedin'), 'matt')).toEqual({
      ok: true,
      value: 'https://www.linkedin.com/in/matt',
    })
    expect(
      normalizeFieldValue(field('spotify'), 'open.spotify.com/user/matt')
    ).toEqual({ ok: true, value: 'https://open.spotify.com/user/matt' })
    expect(
      normalizeFieldValue(field('farcaster'), 'https://warpcast.com/matt')
    ).toEqual({ ok: true, value: 'https://farcaster.xyz/matt' })
    expect(
      normalizeFieldValue(
        field('scholar'),
        'scholar.google.com/citations?user=AbC'
      )
    ).toEqual({
      ok: true,
      value: 'https://scholar.google.com/citations?user=AbC',
    })
  })

  it('keeps a subdomain form of a platform as the URL', () => {
    expect(normalizeFieldValue(field('substack'), 'matt.substack.com')).toEqual(
      { ok: true, value: 'https://matt.substack.com' }
    )
    expect(normalizeFieldValue(field('substack'), 'matt')).toEqual({
      ok: true,
      value: 'https://substack.com/@matt',
    })
    expect(inferFieldFromUrl('https://matt.substack.com')?.name).toBe(
      'substack'
    )
  })
})

describe('inferFieldFromUrl', () => {
  it('picks the handle field from a pasted URL host', () => {
    expect(inferFieldFromUrl('https://x.com/mattbratos')?.name).toBe('x')
    expect(inferFieldFromUrl('twitter.com/mattbratos')?.name).toBe('x')
    expect(inferFieldFromUrl('https://youtube.com/@mattbratos')?.name).toBe(
      'youtube'
    )
    expect(inferFieldFromUrl('www.instagram.com/matt.bratos')?.name).toBe(
      'instagram'
    )
    expect(
      inferFieldFromUrl('https://www.goodreads.com/user/show/12345')?.name
    ).toBe('goodreads')
  })

  it('returns null for own-domain URLs and non-URLs', () => {
    expect(inferFieldFromUrl('https://bratos.xyz')).toBeNull()
    expect(inferFieldFromUrl('bratos.xyz/rss.xml')).toBeNull()
    expect(inferFieldFromUrl('mattbratos')).toBeNull()
    expect(inferFieldFromUrl('ope')).toBeNull()
  })
})

describe('displayValue', () => {
  it('renders booleans as yes/no and null as empty', () => {
    const otw = field('open-to-work')
    expect(displayValue(otw, true)).toBe('yes')
    expect(displayValue(otw, false)).toBe('no')
    expect(displayValue(field('bio'), null)).toBe('')
    expect(displayValue(field('bio'), 'hi')).toBe('hi')
    expect(displayValue(field('readme'), '# Hello')).toBe('7 chars')
  })
})
