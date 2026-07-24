import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession, type Session } from './session.js'

vi.mock('./session.js', () => ({
  loadSession: vi.fn(),
  unauthorizedHint: (session: Session) =>
    `unauthorized — hint for ${session.appUrl}`,
}))

import {
  apiErrorMessage,
  emitJsonError,
  readApiError,
  requireSession,
} from './api-client.js'

const SESSION = { token: 't', appUrl: 'https://hacklab.so' } as Session

let exitCode: number | undefined
let out: string[]

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  out = []
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
})

const output = () => out.join('\n')

describe('emitJsonError', () => {
  it('prints the versioned envelope and exits 1', () => {
    expect(() => emitJsonError('nope', 'broke')).toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'nope', message: 'broke' },
    })
  })
})

describe('requireSession', () => {
  it('returns the session when logged in', async () => {
    vi.mocked(loadSession).mockResolvedValue(SESSION)
    expect(await requireSession(false)).toBe(SESSION)
  })

  it('human mode: "not logged in" + login hint, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(requireSession(false)).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('not logged in')
    expect(output()).toContain('hacklab login')
  })

  it('json mode: unauthorized envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(requireSession(true)).rejects.toThrow('__exit__')
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unauthorized', message: 'not logged in' },
    })
  })
})

describe('apiErrorMessage', () => {
  it('401 → the per-backend unauthorized hint', () => {
    expect(apiErrorMessage(401, null, SESSION)).toBe(
      'unauthorized — hint for https://hacklab.so'
    )
  })

  it('429 → slow-down copy', () => {
    expect(apiErrorMessage(429, null, SESSION)).toContain('slow down')
  })

  it('relays the server message, falling back to the status', () => {
    expect(
      apiErrorMessage(400, { error: { message: 'bad bio' } }, SESSION)
    ).toBe('bad bio')
    expect(apiErrorMessage(500, null, SESSION)).toBe('request failed (500)')
  })
})

describe('readApiError', () => {
  it('parses the envelope body', async () => {
    const res = {
      status: 422,
      json: async () => ({ error: { message: 'too long' } }),
    } as Response
    expect(await readApiError(res, SESSION)).toBe('too long')
  })

  it('tolerates an unparseable body', async () => {
    const res = {
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response
    expect(await readApiError(res, SESSION)).toBe('request failed (502)')
  })
})
