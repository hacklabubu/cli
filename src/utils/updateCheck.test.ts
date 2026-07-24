import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isNewerVersion, notifyIfOutdated } from './updateCheck.js'

describe('isNewerVersion', () => {
  it('detects a newer published version across each segment', () => {
    expect(isNewerVersion('0.6.3', '0.6.2')).toBe(true)
    expect(isNewerVersion('0.7.0', '0.6.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    // the real bug that started all this: published 0.6.x vs a stale 0.5.0
    expect(isNewerVersion('0.6.1', '0.5.0')).toBe(true)
  })

  it('is false when equal or when the running version is ahead', () => {
    expect(isNewerVersion('0.6.2', '0.6.2')).toBe(false)
    expect(isNewerVersion('0.6.1', '0.6.2')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
  })

  it('compares numerically, not lexically (10 > 9)', () => {
    expect(isNewerVersion('0.6.10', '0.6.9')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
  })

  it('treats differing segment counts as zero-padded', () => {
    expect(isNewerVersion('0.6.1', '0.6')).toBe(true)
    expect(isNewerVersion('0.6.0', '0.6')).toBe(false)
  })

  it('never reports newer for a non-numeric (prerelease) segment', () => {
    expect(isNewerVersion('0.6.3-beta.1', '0.6.2')).toBe(false)
    expect(isNewerVersion('latest', '0.6.2')).toBe(false)
  })
})

describe('notifyIfOutdated', () => {
  let dir: string
  let cacheFile: string
  let errSpy: ReturnType<typeof vi.spyOn>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const originalTTY = process.stdout.isTTY
  const originalSessionPath = process.env.HACKLAB_SESSION_PATH
  const originalOptOut = process.env.HACKLAB_NO_UPDATE_CHECK

  function setTTY(v: boolean) {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: v,
      configurable: true,
    })
  }
  function ok(version: string) {
    return { ok: true, json: async () => ({ version }) } as unknown as Response
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hacklab-update-'))
    cacheFile = join(dir, 'update-check.json')
    process.env.HACKLAB_SESSION_PATH = join(dir, 'session.json')
    process.env.HACKLAB_NO_UPDATE_CHECK = ''
    setTTY(true)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Default: any fetch that slips through a gate fails loudly rather than
    // hitting the real registry, so a missing gate shows up as an assertion.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in test'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalTTY,
      configurable: true,
    })
    process.env.HACKLAB_SESSION_PATH = originalSessionPath
    process.env.HACKLAB_NO_UPDATE_CHECK = originalOptOut
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('does nothing (no fetch, no output) when opted out', async () => {
    process.env.HACKLAB_NO_UPDATE_CHECK = '1'
    await notifyIfOutdated('0.6.2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('does nothing when stdout is not a TTY (piped / CI / --json)', async () => {
    setTTY(false)
    await notifyIfOutdated('0.6.2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('uses a fresh cache without hitting the network, and nudges', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ latest: '0.6.3', checkedAt: Date.now() })
    )
    await notifyIfOutdated('0.6.2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('0.6.3')
  })

  it('stays silent when a fresh cache says you are current', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ latest: '0.6.2', checkedAt: Date.now() })
    )
    await notifyIfOutdated('0.6.2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('refetches a stale cache, nudges, and rewrites the cache', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        latest: '0.6.2',
        checkedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      })
    )
    fetchSpy.mockResolvedValue(ok('0.7.0'))
    await notifyIfOutdated('0.6.3')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('0.7.0')
    const written = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    expect(written.latest).toBe('0.7.0')
  })

  it('treats a malformed cache file as a miss and refetches', async () => {
    await fs.writeFile(cacheFile, 'not json {')
    fetchSpy.mockResolvedValue(ok('0.7.0'))
    await notifyIfOutdated('0.6.2')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('0.7.0')
  })

  it('never throws when the fetch fails and there is no cache', async () => {
    await expect(notifyIfOutdated('0.6.2')).resolves.toBeUndefined()
    expect(errSpy).not.toHaveBeenCalled()
  })
})
