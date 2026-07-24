import { describe, expect, it } from 'vitest'

import { codexDateFromRelPath } from './index.js'

describe('codexDateFromRelPath', () => {
  it('extracts YYYY-MM-DD from a POSIX session path', () => {
    expect(codexDateFromRelPath('2026/07/09/rollout.jsonl')).toBe('2026-07-09')
  })

  it('extracts the same date from a Windows (backslash) session path', () => {
    expect(codexDateFromRelPath('2026\\07\\09\\rollout.jsonl')).toBe(
      '2026-07-09'
    )
  })

  it('zero-pads single-digit months and days', () => {
    expect(codexDateFromRelPath('2026/7/9/x.jsonl')).toBe('2026-07-09')
  })

  it('returns null when the path carries no date layout', () => {
    expect(codexDateFromRelPath('rollout.jsonl')).toBeNull()
    expect(codexDateFromRelPath('2026/07')).toBeNull()
  })
})
