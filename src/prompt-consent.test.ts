import { describe, expect, it, vi } from 'vitest'

import {
  isPromptConsentTier,
  parsePromptStatsFlag,
  PROMPT_CONSENT_TIERS,
} from './prompt-consent.js'

describe('isPromptConsentTier', () => {
  it('accepts every declared tier', () => {
    for (const tier of PROMPT_CONSENT_TIERS) {
      expect(isPromptConsentTier(tier)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isPromptConsentTier('yes')).toBe(false)
    expect(isPromptConsentTier('')).toBe(false)
    expect(isPromptConsentTier(true)).toBe(false)
    expect(isPromptConsentTier(undefined)).toBe(false)
  })
})

describe('parsePromptStatsFlag', () => {
  it('returns null when the flag is absent, leaving args untouched', () => {
    expect(parsePromptStatsFlag(['--quiet'])).toEqual({
      tier: null,
      rest: ['--quiet'],
    })
  })

  it('treats a bare flag as the numbers-only tier', () => {
    // An unqualified yes must never opt into uploading prompt *text*.
    expect(parsePromptStatsFlag(['--share-prompt-stats']).tier).toBe('stats')
  })

  it('accepts an explicit tier', () => {
    expect(parsePromptStatsFlag(['--share-prompt-stats=full']).tier).toBe('full')
    expect(parsePromptStatsFlag(['--share-prompt-stats=none']).tier).toBe('none')
  })

  it('falls back to the safe tier on an unknown value', () => {
    expect(parsePromptStatsFlag(['--share-prompt-stats=everything']).tier).toBe(
      'stats'
    )
  })

  it('supports an explicit refusal', () => {
    expect(parsePromptStatsFlag(['--no-share-prompt-stats']).tier).toBe('none')
  })

  it('strips the flag so per-command parsing never sees it', () => {
    const { rest } = parsePromptStatsFlag([
      '--quiet',
      '--share-prompt-stats=full',
    ])
    expect(rest).toEqual(['--quiet'])
  })

  it('lets the last flag win when repeated', () => {
    expect(
      parsePromptStatsFlag(['--share-prompt-stats=full', '--no-share-prompt-stats'])
        .tier
    ).toBe('none')
  })
})

describe('resolvePromptConsent', () => {
  it('never consents on a non-TTY run that has never been asked', async () => {
    // The load-bearing guarantee: an unattended agent or CI run uploads token
    // counts only unless someone explicitly opted in.
    vi.resetModules()
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({}),
      saveConfig: async () => {},
    }))
    const { resolvePromptConsent } = await import('./prompt-consent.js')

    const isTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    try {
      expect(await resolvePromptConsent(null, { interactive: true })).toBe('none')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: isTTY,
        configurable: true,
      })
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })

  it('uses the stored answer without asking again', async () => {
    vi.resetModules()
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({ promptStatsConsent: 'full' }),
      saveConfig: async () => {},
    }))
    const { resolvePromptConsent } = await import('./prompt-consent.js')
    try {
      expect(await resolvePromptConsent(null, { interactive: true })).toBe('full')
    } finally {
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })

  it('lets an explicit flag win over a stored answer, and remembers it', async () => {
    vi.resetModules()
    const saved: string[] = []
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({ promptStatsConsent: 'full' }),
      saveConfig: async (c: { promptStatsConsent?: string }) => {
        if (c.promptStatsConsent) saved.push(c.promptStatsConsent)
      },
    }))
    const { resolvePromptConsent } = await import('./prompt-consent.js')
    try {
      expect(await resolvePromptConsent('none')).toBe('none')
      expect(saved).toEqual(['none'])
    } finally {
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })
})
