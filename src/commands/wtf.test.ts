import { describe, expect, it, vi } from 'vitest'

import { WTF_GUIDE, wtf } from './wtf.js'

describe('wtf', () => {
  it('prints a substantial standalone agent handbook', () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      output.push(String(value))
    })

    wtf()

    expect(output).toEqual([WTF_GUIDE])
    expect(WTF_GUIDE.length).toBeGreaterThan(12_000)
    expect(WTF_GUIDE).toContain('# Hacklab CLI agent handbook')
    expect(WTF_GUIDE).toContain('## Machine-readable behavior')
    expect(WTF_GUIDE).toContain('## Events and hackathons')
    expect(WTF_GUIDE).toContain('hacklab event add')
    expect(WTF_GUIDE).toContain('## Reliability rules for agents')
    expect(WTF_GUIDE).toContain('Never expose session tokens')
  })
})
