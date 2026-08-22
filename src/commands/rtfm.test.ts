import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rtfm } from './rtfm.js'

describe('rtfm', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the available manuals', () => {
    rtfm([])

    const out = logs.join('\n')
    expect(out).toContain('profile-setup')
    expect(out).toContain('build a complete profile')
    expect(out).not.toContain('coming soon')
  })

  it('prints help as the manual list', () => {
    rtfm(['--help'])
    expect(logs.join('\n')).toContain('profile-setup')
  })

  it('prints the profile setup manual', () => {
    rtfm(['profile-setup'])

    const out = logs.join('\n')
    expect(out).toContain('objective')
    expect(out).toContain('prerequisites')
    expect(out).toContain('hacklab whoami')
    expect(out).toContain('hacklab ping')
    expect(out).toContain('hacklab profile --json')
    expect(out).toContain('hacklab profile set --help')
    expect(out).toContain('hacklab profile apply <file> --json')
    expect(out).toContain('Hugging Face')
    expect(out).toContain('Goodreads')
    expect(out).toContain('done when')
    expect(out).toContain('do not')
    expect(out).toContain('Do not put social links in the bio or README')
  })

  it('fails clearly for an unknown manual', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)

    expect(() => rtfm(['unknown'])).toThrow('exit 1')
    const out = logs.join('\n')
    expect(out).toContain('manual not found: unknown')
    expect(out).toContain('hacklab rtfm')
  })
})
