import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureFreshSession } from './sync.js'

// ensureFreshSession refreshes the CLI session only when it's within the last
// week of its 30-day window, so the daily background job never lapses without
// hammering the endpoint. It persists the refreshed session to disk.
const DAY = 24 * 60 * 60 * 1000
const base = {
  email: 'e@example.com',
  appUrl: 'https://hacklab.so',
  savedAt: '2026-06-01T00:00:00.000Z',
  token: 'old-token',
}

let dir: string
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hl-refresh-'))
  process.env.HACKLAB_SESSION_PATH = join(dir, 'session.json')
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env.HACKLAB_SESSION_PATH = undefined
})

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

describe('ensureFreshSession', () => {
  it('does not touch the network when expiry is comfortably far out', async () => {
    const expiresAt = new Date(Date.now() + 20 * DAY).toISOString()
    const result = await ensureFreshSession({ ...base, expiresAt })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.token).toBe('old-token')
  })

  it('refreshes and persists the new session when expiry is near', async () => {
    const near = new Date(Date.now() + 2 * DAY).toISOString()
    const newExpiry = new Date(Date.now() + 30 * DAY).toISOString()
    fetchSpy.mockResolvedValue(
      okResponse({ token: 'fresh-token', expiresAt: newExpiry })
    )

    const result = await ensureFreshSession({ ...base, expiresAt: near })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.token).toBe('fresh-token')
    expect(result.expiresAt).toBe(newExpiry)
    const saved = JSON.parse(
      await readFile(process.env.HACKLAB_SESSION_PATH as string, 'utf8')
    )
    expect(saved.token).toBe('fresh-token')
  })

  it('keeps the existing session if the refresh fails', async () => {
    const near = new Date(Date.now() + 2 * DAY).toISOString()
    fetchSpy.mockResolvedValue({ ok: false, status: 401 } as Response)
    const result = await ensureFreshSession({ ...base, expiresAt: near })
    expect(result.token).toBe('old-token')
  })
})
