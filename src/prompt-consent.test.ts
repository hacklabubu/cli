import { describe, expect, it, vi } from 'vitest'

import {
  isPromptSyncTier,
  PROMPT_SYNC_TIERS,
  parsePromptSyncFlag,
} from './prompt-consent.js'

describe('isPromptSyncTier', () => {
  it('accepts every declared tier', () => {
    for (const tier of PROMPT_SYNC_TIERS) {
      expect(isPromptSyncTier(tier)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isPromptSyncTier('yes')).toBe(false)
    expect(isPromptSyncTier('')).toBe(false)
    expect(isPromptSyncTier(true)).toBe(false)
    expect(isPromptSyncTier(undefined)).toBe(false)
  })
})

describe('parsePromptSyncFlag', () => {
  it('returns null when the flag is absent, leaving args untouched', () => {
    expect(parsePromptSyncFlag(['--quiet'])).toEqual({
      tier: null,
      rest: ['--quiet'],
    })
  })

  it('treats a bare flag as the metadata-only tier', () => {
    // An unqualified yes must never opt into uploading prompt *text*.
    expect(parsePromptSyncFlag(['--share-prompt-sync']).tier).toBe('stats')
  })

  it('accepts an explicit tier', () => {
    expect(parsePromptSyncFlag(['--share-prompt-sync=full']).tier).toBe('full')
    expect(parsePromptSyncFlag(['--share-prompt-sync=none']).tier).toBe('none')
  })

  it('falls back to the safe tier on an unknown value', () => {
    expect(parsePromptSyncFlag(['--share-prompt-sync=everything']).tier).toBe(
      'stats'
    )
  })

  it('supports an explicit refusal', () => {
    expect(parsePromptSyncFlag(['--no-share-prompt-sync']).tier).toBe('none')
  })

  it('strips the flag so per-command parsing never sees it', () => {
    const { rest } = parsePromptSyncFlag([
      '--quiet',
      '--share-prompt-sync=full',
    ])
    expect(rest).toEqual(['--quiet'])
  })

  it('lets the last flag win when repeated', () => {
    expect(
      parsePromptSyncFlag([
        '--share-prompt-sync=full',
        '--no-share-prompt-sync',
      ]).tier
    ).toBe('none')
  })

  it('does not answer to the retired prompt-stats flag', () => {
    // The old flag consented to a one-off scan, not a minutely sync. Silently
    // honouring it would carry an answer across a question that changed.
    expect(parsePromptSyncFlag(['--share-prompt-stats=full'])).toEqual({
      tier: null,
      rest: ['--share-prompt-stats=full'],
    })
  })
})

describe('resolvePromptSync', () => {
  it('never consents on a non-TTY run that has never been asked', async () => {
    // The load-bearing guarantee: an unattended agent or CI run uploads token
    // counts only unless someone explicitly opted in.
    vi.resetModules()
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({}),
      updateConfig: async () => true,
    }))
    const { resolvePromptSync } = await import('./prompt-consent.js')

    const isTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    try {
      expect(await resolvePromptSync(null, { interactive: true })).toBe('none')
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
      loadConfig: async () => ({ promptSync: 'full' }),
      updateConfig: async () => true,
    }))
    const { resolvePromptSync } = await import('./prompt-consent.js')
    try {
      expect(await resolvePromptSync(null, { interactive: true })).toBe('full')
    } finally {
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })

  it('treats the retired prompt-stats answer as no answer at all', async () => {
    // It answered a narrower question — a scan uploaded once a day, not a
    // minutely sync of session metadata — so it can never stand in for this one.
    vi.resetModules()
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({ promptStatsConsent: 'full' }),
      updateConfig: async () => true,
    }))
    const { resolvePromptSync } = await import('./prompt-consent.js')

    const isTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    try {
      expect(await resolvePromptSync(null, { interactive: true })).toBe('none')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: isTTY,
        configurable: true,
      })
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })

  it('lets an explicit flag win over a stored answer, and remembers it', async () => {
    vi.resetModules()
    const written: Record<string, unknown>[] = []
    vi.doMock('./config.js', () => ({
      loadConfig: async () => ({ promptSync: 'full' }),
      updateConfig: async (
        mutate: (c: Record<string, unknown>) => Record<string, unknown> | null
      ) => {
        const next = mutate({ promptStatsConsent: 'full', promptSync: 'full' })
        if (next) written.push(next)
        return true
      },
    }))
    const { resolvePromptSync } = await import('./prompt-consent.js')
    try {
      expect(await resolvePromptSync('none')).toBe('none')
      // The obsolete key goes with the write, so a machine never carries two
      // answers to two different questions.
      expect(written).toEqual([{ promptSync: 'none' }])
    } finally {
      vi.doUnmock('./config.js')
      vi.resetModules()
    }
  })
})
