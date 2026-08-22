import { describe, expect, it } from 'vitest'

import { shortModelName } from './scanners/util.js'

describe('shortModelName', () => {
  it('folds Claude ids to TIER + version, dropping vendor + date', () => {
    expect(shortModelName('claude-opus-4-1-20250805')).toBe('OPUS 4.1')
    expect(shortModelName('claude-sonnet-4-5-20250929')).toBe('SONNET 4.5')
    expect(shortModelName('claude-haiku-4-5')).toBe('HAIKU 4.5')
  })

  it('handles the legacy version-before-tier Claude format', () => {
    expect(shortModelName('claude-3-5-sonnet-20241022')).toBe('SONNET 3.5')
  })

  it('keeps a Claude tier with no version', () => {
    expect(shortModelName('claude-opus')).toBe('OPUS')
  })

  it('preserves non-Claude ids (no truncation of CODEX)', () => {
    expect(shortModelName('gpt-5.3-codex')).toBe('GPT-5.3-CODEX')
    expect(shortModelName('gpt-5.4')).toBe('GPT-5.4')
    expect(shortModelName('gemini-2.5-pro')).toBe('GEMINI-2.5-PRO')
  })

  it('caps very long non-Claude ids at 16 chars', () => {
    expect(shortModelName('some-extremely-long-model-id').length).toBe(16)
  })

  it('returns empty string for blank input', () => {
    expect(shortModelName('')).toBe('')
    expect(shortModelName('   ')).toBe('')
  })
})
