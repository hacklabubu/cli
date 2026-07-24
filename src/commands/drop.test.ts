import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { captureEvent } from '../posthog.js'
import { loadSession } from '../session.js'

vi.mock('../posthog.js', () => ({ captureEvent: vi.fn() }))
vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
}))

import { drop, parseDropArgs } from './drop.js'

// parseDropArgs turns `hacklab drop` argv into { text, url }. Only the success
// paths are covered here: the error paths call process.exit(), which the
// codebase convention leaves untested.
describe('parseDropArgs', () => {
  it('joins free words into the message text', () => {
    expect(parseDropArgs(['hello', 'world'])).toEqual({
      text: 'hello world',
      url: undefined,
      json: false,
    })
  })

  it('attaches a url via -u and drops the flag pair from the message', () => {
    expect(parseDropArgs(['shipping', 'this', '-u', 'https://x.test'])).toEqual(
      {
        text: 'shipping this',
        url: 'https://x.test',
        json: false,
      }
    )
  })

  it('accepts the long --url flag in any position', () => {
    expect(parseDropArgs(['--url', 'https://x.test', 'done'])).toEqual({
      text: 'done',
      url: 'https://x.test',
      json: false,
    })
  })

  it('keeps --json out of the message', () => {
    expect(parseDropArgs(['hello', '--json'])).toEqual({
      text: 'hello',
      url: undefined,
      json: true,
    })
  })
})

describe('drop output', () => {
  const result = {
    id: 'drop_1',
    path: '/bratos?tab=drops#drop-drop_1',
    url: 'https://hacklab.so/bratos?tab=drops#drop-drop_1',
  }

  beforeEach(() => {
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
      handle: 'bratos',
    } as never)
    vi.mocked(captureEvent).mockResolvedValue(undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => result }))
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns id, path, and URL in JSON mode', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value))
    })

    await drop('hello', undefined, true)

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      ...result,
    })
  })

  it('prints the drop URL for humans', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value))
    })

    await drop('hello')

    expect(output.join('\n')).toContain(result.url)
  })

  it('degrades gracefully when an older server returns only { id }', async () => {
    // Deploy/publish skew: the drop succeeded server-side, so this must not
    // read as a failure — construct path/url from the session instead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ id: 'drop_1' }) }))
    )
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value))
    })

    await drop('hello', undefined, true)

    expect(JSON.parse(output.join('\n'))).toEqual({
      schemaVersion: 1,
      id: 'drop_1',
      path: '/bratos?tab=drops#drop-drop_1',
      url: 'https://hacklab.so/bratos?tab=drops#drop-drop_1',
    })
  })
})

// Every --json failure prints a {schemaVersion, error:{code,message}} envelope
// via emitJsonError and exits 1; non-json mode keeps the human strings.
describe('drop failures', () => {
  let exitCode: number | undefined
  let out: string[]

  beforeEach(() => {
    exitCode = undefined
    out = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as never)
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      out.push(String(value))
    })
    vi.mocked(loadSession).mockResolvedValue({
      token: 'token',
      appUrl: 'https://hacklab.so',
      handle: 'bratos',
    } as never)
    vi.mocked(captureEvent).mockResolvedValue(undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const output = () => out.join('\n')

  it('--json with no session → unauthorized envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(drop('hello', undefined, true)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unauthorized', message: 'not logged in' },
    })
  })

  it('--json with >1000 chars → invalid_fields envelope, exit 1', async () => {
    await expect(drop('x'.repeat(1001), undefined, true)).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'invalid_fields', message: 'too long — 1001/1000 chars' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('--json on !res.ok → request_failed envelope with the server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'nope' }),
      }))
    )
    await expect(drop('hello', undefined, true)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'request_failed', message: 'nope' },
    })
  })

  it('--json on !res.ok with an unreadable body falls back to failed (status)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('not json')
        },
      }))
    )
    await expect(drop('hello', undefined, true)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'request_failed', message: 'failed (502)' },
    })
  })

  it('--json on a malformed 200 body → bad_response envelope, exit 1', async () => {
    // ok response missing id/path/url
    await expect(drop('hello', undefined, true)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: {
        code: 'bad_response',
        message: 'got a malformed response from hacklab',
      },
    })
  })

  it('non-json with no session prints the human error', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(drop('hello')).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('not logged in')
    expect(output()).toContain('hacklab login')
    expect(output()).not.toContain('schemaVersion')
  })

  it('non-json with >1000 chars prints the human error', async () => {
    await expect(drop('x'.repeat(1001))).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('too long — 1001/1000 chars')
    expect(output()).not.toContain('schemaVersion')
  })

  it('non-json on !res.ok prints the server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'nope' }),
      }))
    )
    await expect(drop('hello')).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('nope')
    expect(output()).not.toContain('schemaVersion')
  })

  it('non-json on a malformed 200 body prints the human error', async () => {
    await expect(drop('hello')).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('got a malformed response from hacklab')
    expect(output()).not.toContain('schemaVersion')
  })
})
