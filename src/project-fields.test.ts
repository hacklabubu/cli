import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractOgImage, parseTags } from './commands/project.js'
import {
  isGithubRepoUrl,
  normalizeRepoUrl,
  probeRepoPrivate,
  slugFromName,
} from './project-fields.js'

describe('normalizeRepoUrl', () => {
  it('normalizes every common remote spelling to one https URL', () => {
    for (const remote of [
      'git@github.com:acme/hacklab.git',
      'https://github.com/acme/hacklab.git',
      'https://github.com/acme/hacklab',
      'ssh://git@github.com/acme/hacklab.git',
      'https://user@github.com/acme/hacklab.git',
    ]) {
      expect(normalizeRepoUrl(remote)).toEqual({
        url: 'https://github.com/acme/hacklab',
        owner: 'acme',
        name: 'hacklab',
      })
    }
  })

  it('handles non-github hosts and missing owners', () => {
    expect(normalizeRepoUrl('git@gitlab.com:group/sub/repo.git')).toEqual({
      url: 'https://gitlab.com/group/sub/repo',
      owner: 'sub',
      name: 'repo',
    })
    expect(normalizeRepoUrl('')).toBeNull()
    expect(normalizeRepoUrl('not a remote')).toBeNull()
  })
})

describe('slugFromName', () => {
  it('produces server-valid slugs', () => {
    expect(slugFromName('My_Cool.Repo')).toBe('my-cool-repo')
    expect(slugFromName('--weird--')).toBe('weird')
    expect(slugFromName('***')).toBe('project')
  })
})

describe('parseTags', () => {
  it('splits, trims, lowercases, and drops empties', () => {
    expect(parseTags(' AI, terminal ,,cli ')).toEqual(['ai', 'terminal', 'cli'])
  })
})

describe('isGithubRepoUrl', () => {
  it('recognizes github.com hosts only', () => {
    expect(isGithubRepoUrl('https://github.com/acme/hacklab')).toBe(true)
    expect(isGithubRepoUrl('https://www.github.com/acme/hacklab')).toBe(true)
    expect(isGithubRepoUrl('https://gitlab.com/acme/hacklab')).toBe(false)
    expect(isGithubRepoUrl('https://example.com')).toBe(false)
    expect(isGithubRepoUrl('not a url')).toBe(false)
  })
})

describe('probeRepoPrivate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports private on a 404 and public on a 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeRepoPrivate('https://github.com/acme/secret')).toBe(true)
    expect(await probeRepoPrivate('https://github.com/acme/public')).toBe(false)
  })

  it('fails open to public on network errors and non-github/empty URLs', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeRepoPrivate('https://github.com/acme/repo')).toBe(false)
    // Non-github + empty never hit the network at all.
    expect(await probeRepoPrivate('https://gitlab.com/acme/repo')).toBe(false)
    expect(await probeRepoPrivate(null)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('extractOgImage', () => {
  it('finds og:image in either attribute order and resolves relative URLs', () => {
    expect(
      extractOgImage(
        '<meta property="og:image" content="https://x.dev/og.png"/>',
        'https://x.dev'
      )
    ).toBe('https://x.dev/og.png')
    expect(
      extractOgImage(
        "<meta content='/og.png' property='og:image'>",
        'https://x.dev/page'
      )
    ).toBe('https://x.dev/og.png')
    expect(extractOgImage('<html>nope</html>', 'https://x.dev')).toBeNull()
  })
})
