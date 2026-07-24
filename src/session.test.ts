import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  envNameForUrl,
  getAppUrl,
  getSessionExpiresAt,
  HACKLAB_ENVIRONMENTS,
  isHacklabEnv,
  isSessionExpired,
  resolveHacklabEnv,
  type Session,
  unauthorizedHint,
} from './session'

const baseSession: Session = {
  token: 'token',
  email: 'user@example.com',
  appUrl: 'http://localhost:3000',
  savedAt: '2026-05-01T00:00:00.000Z',
}

describe('unauthorizedHint', () => {
  afterEach(() => vi.unstubAllEnvs())

  const base = {
    token: 't',
    email: 'user@example.com',
    savedAt: '2026-01-01T00:00:00Z',
  } satisfies Partial<Session>

  it('names the target backend + its --env login when the session is for a different backend', () => {
    // Session was minted against a custom backend, but --env development points
    // the command at localhost (the reviewer's exact footgun).
    vi.stubEnv('HACKLAB_APP_URL', 'http://localhost:3000')
    const msg = unauthorizedHint({
      ...base,
      appUrl: 'https://app.example.com',
    })
    expect(msg).toContain('hacklab login --env development')
    expect(msg).toContain('app.example.com')
    expect(msg).toContain('localhost:3000')
  })

  it('suggests a plain `hacklab login` for an expired same-backend production session', () => {
    vi.stubEnv('HACKLAB_APP_URL', 'https://hacklab.so')
    const msg = unauthorizedHint({ ...base, appUrl: 'https://hacklab.so' })
    expect(msg).toContain('hacklab login')
    expect(msg).not.toContain('--env')
    expect(msg).toContain('expired')
  })
})

describe('session expiry', () => {
  it('uses explicit expiresAt when present', () => {
    const session = {
      ...baseSession,
      savedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-05-20T00:00:00.000Z',
    }

    expect(getSessionExpiresAt(session)?.toISOString()).toBe(
      '2026-05-20T00:00:00.000Z'
    )
    expect(
      isSessionExpired(session, new Date('2026-05-12T00:00:00.000Z'))
    ).toBe(false)
  })

  it('expires legacy sessions seven days after they were saved', () => {
    expect(
      isSessionExpired(baseSession, new Date('2026-05-08T00:00:00.001Z'))
    ).toBe(true)
  })

  it('keeps recent legacy sessions valid', () => {
    expect(
      isSessionExpired(baseSession, new Date('2026-05-07T23:59:59.999Z'))
    ).toBe(false)
  })
})

describe('backend selection', () => {
  const original = process.env.HACKLAB_APP_URL

  beforeEach(() => {
    delete process.env.HACKLAB_APP_URL
  })
  afterEach(() => {
    if (original === undefined) delete process.env.HACKLAB_APP_URL
    else process.env.HACKLAB_APP_URL = original
  })

  it('defaults to production when nothing is set', () => {
    expect(getAppUrl()).toBe('https://hacklab.so')
  })

  it('honors HACKLAB_APP_URL and trims a trailing slash', () => {
    process.env.HACKLAB_APP_URL = 'http://localhost:3000/'
    expect(getAppUrl()).toBe('http://localhost:3000')
  })

  it('maps each environment name to a url', () => {
    expect(HACKLAB_ENVIRONMENTS).toEqual({
      production: 'https://hacklab.so',
      development: 'http://localhost:3000',
    })
  })

  it('recognizes valid env names only', () => {
    expect(isHacklabEnv('production')).toBe(true)
    expect(isHacklabEnv('development')).toBe(true)
    expect(isHacklabEnv('prod')).toBe(false)
    expect(isHacklabEnv('')).toBe(false)
  })

  describe('resolveHacklabEnv', () => {
    it('resolves full names', () => {
      expect(resolveHacklabEnv('development')).toBe('development')
      expect(resolveHacklabEnv('production')).toBe('production')
    })

    it('resolves unambiguous prefixes (the names start distinctly)', () => {
      expect(resolveHacklabEnv('dev')).toBe('development')
      expect(resolveHacklabEnv('d')).toBe('development')
      expect(resolveHacklabEnv('prod')).toBe('production')
      expect(resolveHacklabEnv('p')).toBe('production')
    })

    it('resolves natural aliases', () => {
      expect(resolveHacklabEnv('local')).toBe('development')
      expect(resolveHacklabEnv('localhost')).toBe('development')
    })

    it('returns null for anything that matches no env', () => {
      // '' is a prefix of both (ambiguous), 'x'/'prd'/'s' prefix none.
      expect(resolveHacklabEnv('')).toBeNull()
      expect(resolveHacklabEnv('x')).toBeNull()
      expect(resolveHacklabEnv('prd')).toBeNull()
      expect(resolveHacklabEnv('s')).toBeNull()
    })
  })

  describe('envNameForUrl', () => {
    it('maps each known backend url to its env name', () => {
      expect(envNameForUrl('https://hacklab.so')).toBe('production')
      expect(envNameForUrl('http://localhost:3000')).toBe('development')
    })

    it('ignores a trailing slash', () => {
      expect(envNameForUrl('http://localhost:3000/')).toBe('development')
    })

    it('returns null for an unknown backend (custom HACKLAB_APP_URL)', () => {
      expect(envNameForUrl('https://example.com')).toBeNull()
    })
  })
})
