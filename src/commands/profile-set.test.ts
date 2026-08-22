import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  readFile: vi.fn(),
  requireSession: vi.fn(),
  fetchApi: vi.fn(),
  captureEvent: vi.fn(),
  emitJsonError: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: m.readFile }))
vi.mock('../api-client.js', () => ({
  emitJsonError: m.emitJsonError,
  readApiError: vi.fn(),
  requireSession: m.requireSession,
}))
vi.mock('../sync.js', () => ({ fetchApi: m.fetchApi }))
vi.mock('../posthog.js', () => ({ captureEvent: m.captureEvent }))
vi.mock('../session.js', () => ({
  resolveAppUrl: () => 'https://hacklab.so',
}))
vi.mock('../ui.js', () => ({
  bold: (value: string) => value,
  dim: (value: string) => value,
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}))

import { PROFILE_FIELDS, profile } from './profile.js'

describe('profile set readme --file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    m.readFile.mockResolvedValue('# Builder\n\nShips useful things.\n')
    m.requireSession.mockResolvedValue({
      token: 'token',
      handle: 'ada',
      appUrl: 'https://hacklab.so',
    })
    m.fetchApi.mockResolvedValue(
      new Response(
        JSON.stringify({
          updated: ['profileReadme'],
          profile: {
            handle: 'ada',
            profileReadme: '# Builder\n\nShips useful things.',
          },
        })
      )
    )
  })

  it('reads multiline Markdown and sends it as profileReadme', async () => {
    await profile(['set', 'readme', '--file', 'profile.md', '--json'])

    expect(m.readFile).toHaveBeenCalledWith('profile.md', 'utf8')
    expect(m.fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackers/me?src=cli',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          profileReadme: '# Builder\n\nShips useful things.',
        }),
      })
    )
  })
})

// The mocked emitJsonError does not exit, so each path falls through to the
// (also asserted) process.exit(1). fetchApi must never fire on a bad flag mix.
describe('profile set --file negative paths', () => {
  let exitCode: number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as never)
    m.requireSession.mockResolvedValue({
      token: 'token',
      handle: 'ada',
      appUrl: 'https://hacklab.so',
    })
  })

  it('--file without a path → invalid_fields, no read, no fetch', async () => {
    await expect(
      profile(['set', 'readme', '--file', '--json'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'invalid_fields',
      '--file requires a path'
    )
    expect(m.readFile).not.toHaveBeenCalled()
    expect(m.fetchApi).not.toHaveBeenCalled()
  })

  it('--file with --clear → invalid_fields, no read, no fetch', async () => {
    await expect(
      profile(['set', 'readme', '--file', 'profile.md', '--clear', '--json'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'invalid_fields',
      'use either --file or --clear'
    )
    expect(m.readFile).not.toHaveBeenCalled()
    expect(m.fetchApi).not.toHaveBeenCalled()
  })

  it('--file with an inline value → invalid_fields, no read, no fetch', async () => {
    await expect(
      profile([
        'set',
        'readme',
        'inline text',
        '--file',
        'profile.md',
        '--json',
      ])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'invalid_fields',
      'pass either a value or --file, not both'
    )
    expect(m.readFile).not.toHaveBeenCalled()
    expect(m.fetchApi).not.toHaveBeenCalled()
  })

  it('ENOENT read failure → read_failed "file not found", no fetch', async () => {
    m.readFile.mockRejectedValue(
      Object.assign(new Error('no such file'), { code: 'ENOENT' })
    )
    await expect(
      profile(['set', 'readme', '--file', 'missing.md', '--json'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'read_failed',
      'file not found: missing.md'
    )
    expect(m.fetchApi).not.toHaveBeenCalled()
  })

  it('generic read failure → read_failed "could not read", no fetch', async () => {
    m.readFile.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )
    await expect(
      profile(['set', 'readme', '--file', 'locked.md', '--json'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'read_failed',
      'could not read locked.md'
    )
    expect(m.fetchApi).not.toHaveBeenCalled()
  })
})

// `set` with nothing to set is a help request, not a failure — except under
// --json, where a consumer needs an error envelope, not a human help page.
describe('profile set help', () => {
  let exitCode: number | undefined
  let lines: string[]

  beforeEach(async () => {
    vi.clearAllMocks()
    exitCode = undefined
    lines = []
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as never)
    const ui = await import('../ui.js')
    vi.mocked(ui.info).mockImplementation((msg: string) => {
      lines.push(msg)
    })
    vi.mocked(ui.error).mockImplementation((msg: string) => {
      lines.push(msg)
    })
  })

  it('bare `set` prints the help and exits 0', async () => {
    await expect(profile(['set'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(0)
    expect(lines[0]).toBe('usage: hacklab profile set <field> <value>')
    expect(lines.join('\n')).toContain('--clear')
    expect(m.requireSession).not.toHaveBeenCalled()
    expect(m.fetchApi).not.toHaveBeenCalled()
  })

  for (const flag of ['--help', '-h', 'help']) {
    it(`\`set ${flag}\` prints the help, exits 0, hits no network`, async () => {
      await expect(profile(['set', flag])).rejects.toThrow('__exit__')
      expect(exitCode).toBe(0)
      expect(lines[0]).toBe('usage: hacklab profile set <field> <value>')
      expect(m.requireSession).not.toHaveBeenCalled()
      expect(m.fetchApi).not.toHaveBeenCalled()
    })
  }

  // Loop over the table so a new field needs no test edit.
  it('lists every field with its hint', async () => {
    await expect(profile(['set'])).rejects.toThrow('__exit__')
    const output = lines.join('\n')
    for (const field of PROFILE_FIELDS) {
      expect(output).toContain(field.name)
      expect(output).toContain(field.hint)
    }
  })

  it('--json with no field → invalid_fields, exits 1', async () => {
    await expect(profile(['set', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(m.emitJsonError).toHaveBeenCalledWith(
      'invalid_fields',
      'usage: hacklab profile set <field> <value>'
    )
    expect(m.requireSession).not.toHaveBeenCalled()
    expect(m.fetchApi).not.toHaveBeenCalled()
  })
})
