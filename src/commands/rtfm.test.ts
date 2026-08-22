import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rtfm } from './rtfm.js'

describe('rtfm', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says the manuals are not available yet (bare and with a topic)', () => {
    rtfm([])
    rtfm(['onboarding'])
    const out = logs.join('\n')
    expect(out).toContain('rtfm is not available yet')
    expect(out).toContain('hacklab rtfm topics')
  })

  it('lists every planned topic under `rtfm topics`', () => {
    rtfm(['topics'])
    const out = logs.join('\n')
    for (const topic of [
      'onboarding',
      'wtf',
      'game',
      'post-job',
      'find-team',
      'org-setup',
      'drop-daily',
      'grow',
    ]) {
      expect(out).toContain(topic)
    }
    expect(out).not.toContain('not available')
  })
})
