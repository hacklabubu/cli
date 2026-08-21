import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (s: { appUrl?: string }) => s?.appUrl ?? 'https://hacklab.so',
  unauthorizedHint: () => 'unauthorized — run `hacklab login`.',
}))
vi.mock('../sync.js', () => ({ fetchApi: vi.fn() }))
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../utils/openBrowser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(true),
}))
// Keep the real pure helpers; only stub the network probe so tests stay offline.
vi.mock('../project-infer.js', async () => {
  const actual = await vi.importActual<typeof import('../project-infer.js')>(
    '../project-infer.js'
  )
  return { ...actual, probeRepoPrivate: vi.fn().mockResolvedValue(false) }
})

import {
  extractOgImage,
  parseProjectDocument,
  parseTags,
  project,
} from './project.js'

const PROJECT = {
  slug: 'my-app',
  title: 'My App',
  description: 'does things',
  content: '# My App\n\nreadme body',
  tags: ['cli'],
  repoUrl: 'https://github.com/acme/my-app',
  liveUrl: null,
  private: false,
  source: 'cli',
  screenshots: [],
  publishedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  path: '/isomiki/my-app',
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

let exitCode: number | undefined
let out: string[]

function mockList(projects: unknown[]) {
  vi.mocked(fetchApi).mockImplementation((async (
    _s: unknown,
    _path: string,
    init?: RequestInit
  ) => {
    if (init?.method === 'POST') return jsonResponse(PROJECT, 201)
    if (init?.method === 'DELETE') return jsonResponse({ deleted: PROJECT })
    return jsonResponse({ schemaVersion: 1, handle: 'isomiki', projects })
  }) as never)
}

function postBody(): Record<string, unknown> {
  const call = vi
    .mocked(fetchApi)
    .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'POST')
  return JSON.parse((call?.[2] as RequestInit).body as string)
}

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
  vi.mocked(loadSession).mockResolvedValue({
    token: 't',
    appUrl: 'https://hacklab.so',
    handle: 'isomiki',
  } as never)
  mockList([PROJECT])
})

const output = () => out.join('\n')

describe('project command — dispatch', () => {
  it('exits 1 on an unknown subcommand', async () => {
    await expect(project(['frobnicate'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
  })

  it('prints the help and exits 0 when run bare', async () => {
    await expect(project([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(0)
    expect(output()).toContain(
      'usage: hacklab project [add|apply|list|view|edit|delete]'
    )
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('prints the help and exits 0 for help/--help/-h', async () => {
    for (const token of ['help', '--help', '-h']) {
      out = []
      await expect(project([token])).rejects.toThrow('__exit__')
      expect(exitCode).toBe(0)
      expect(output()).not.toContain('unknown subcommand')
      expect(output()).toContain(
        'usage: hacklab project [add|apply|list|view|edit|delete]'
      )
    }
  })

  it('prints the usage header only once on an unknown subcommand', async () => {
    await expect(project(['frobnicate'])).rejects.toThrow('__exit__')
    const headers = out.filter((line) =>
      line.includes('usage: hacklab project [add|apply|list|view|edit|delete]')
    )
    expect(headers).toHaveLength(1)
  })

  it('resolves the "v" prefix to "view"', async () => {
    await project(['v', 'my-app'])
    expect(output()).toContain('My App')
  })

  it('resolves the "e" prefix to "edit"', async () => {
    await project(['e', 'my-app', '--title', 'Renamed'])
    expect(postBody().title).toBe('Renamed')
  })
})

describe('project view', () => {
  it('renders the project card for a known slug', async () => {
    await project(['view', 'my-app'])
    expect(output()).toContain('My App')
    expect(output()).toContain('my-app')
    expect(output()).toContain('github.com/acme/my-app')
  })

  it('--json prints the envelope and no card', async () => {
    await project(['view', 'my-app', '--json'])
    const printed = JSON.parse(output())
    expect(printed.project.slug).toBe('my-app')
  })

  it('404s a missing slug with a near-match suggestion, exit 1', async () => {
    await expect(project(['view', 'my-ap'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('no project named "my-ap"')
    expect(output()).toContain('hacklab project view my-app')
  })

  it('exits 1 when not logged in', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(project(['view', 'my-app'])).rejects.toThrow('__exit__')
    expect(output()).toContain('not logged in')
  })
})

describe('project edit', () => {
  it('exits 1 with usage when no slug is given', async () => {
    await expect(project(['edit'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab project edit')
  })

  it('exits 1 when no field flags are passed', async () => {
    await expect(project(['edit', 'my-app'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('nothing to edit')
  })

  it('merges only passed fields and preserves content + slug', async () => {
    await project(['edit', 'my-app', '--title', 'Renamed', '--desc', 'new'])
    const body = postBody()
    expect(body.title).toBe('Renamed')
    expect(body.description).toBe('new')
    expect(body.slug).toBe('my-app')
    // Untouched fields round-trip.
    expect(body.content).toBe(PROJECT.content)
    expect(body.private).toBe(false)
  })

  it('routes a github --url to repoUrl and a plain --url to liveUrl', async () => {
    await project(['edit', 'my-app', '--url', 'https://example.com'])
    expect(postBody().liveUrl).toBe('https://example.com')

    vi.mocked(fetchApi).mockClear()
    await project(['edit', 'my-app', '--url', 'https://github.com/acme/next'])
    expect(postBody().repoUrl).toBe('https://github.com/acme/next')
  })

  it('--clear-live nulls the live URL', async () => {
    mockList([{ ...PROJECT, liveUrl: 'https://example.com' }])
    await project(['edit', 'my-app', '--clear-live'])
    expect(postBody().liveUrl).toBeUndefined()
  })

  it('404s a missing slug with a suggestion, exit 1', async () => {
    await expect(project(['edit', 'my-ap', '--title', 'x'])).rejects.toThrow(
      '__exit__'
    )
    expect(output()).toContain('no project named "my-ap"')
  })

  it('--json prints an edited envelope', async () => {
    await project(['edit', 'my-app', '--title', 'Renamed', '--json'])
    const printed = JSON.parse(output())
    expect(printed.edited).toBe(true)
    expect(printed.slug).toBe('my-app')
  })

  it('refuses to edit a github-synced project without --yes (non-TTY)', async () => {
    mockList([{ ...PROJECT, source: 'github' }])
    await expect(project(['edit', 'my-app', '--title', 'x'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(output()).toContain('synced from GitHub')
  })
})

describe('parseProjectDocument', () => {
  it('accepts long content and URL screenshots', () => {
    const parsed = parseProjectDocument({
      title: 'Hacklab',
      description: 'A short summary.',
      content: '# Hacklab\n\nA much longer project story.',
      repoUrl: 'https://github.com/acme/hacklab',
      liveUrl: 'https://hacklab.so',
      tags: ['NextJS', 'AI'],
      screenshots: [
        'https://cdn.example.com/home.webp',
        {
          url: 'https://cdn.example.com/profile.png',
          caption: 'Hacker profile',
        },
      ],
    })

    expect(parsed).toEqual({
      ok: true,
      project: {
        title: 'Hacklab',
        slug: 'hacklab',
        description: 'A short summary.',
        content: '# Hacklab\n\nA much longer project story.',
        repoUrl: 'https://github.com/acme/hacklab',
        liveUrl: 'https://hacklab.so/',
        tags: ['nextjs', 'ai'],
        // Manifests never declare privacy; `publishProject` probes the repo.
        private: false,
        screenshots: [
          { url: 'https://cdn.example.com/home.webp', caption: '' },
          {
            url: 'https://cdn.example.com/profile.png',
            caption: 'Hacker profile',
          },
        ],
      },
    })
  })

  it('derives title and slug from a repo URL', () => {
    expect(
      parseProjectDocument({ repoUrl: 'git@github.com:acme/cool-tool.git' })
    ).toMatchObject({
      ok: true,
      project: {
        title: 'cool-tool',
        slug: 'cool-tool',
        repoUrl: 'https://github.com/acme/cool-tool',
      },
    })
  })

  it('does not replace screenshots when the field is omitted', () => {
    const parsed = parseProjectDocument({ title: 'No screenshots' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.project.screenshots).toBeUndefined()
  })

  it('rejects unknown fields and more than five screenshots', () => {
    expect(parseProjectDocument({ title: 'Nope', thumbnail: 'x' })).toEqual({
      ok: false,
      error: 'unknown field "thumbnail"',
    })
    expect(
      parseProjectDocument({
        title: 'Nope',
        screenshots: Array.from(
          { length: 6 },
          (_, index) => `https://example.com/${index}.png`
        ),
      })
    ).toEqual({
      ok: false,
      error: 'screenshots supports at most 5 images',
    })
    expect(
      parseProjectDocument({ title: 'Nope', screenshots: [{ caption: 'x' }] })
    ).toEqual({
      ok: false,
      error: 'screenshots[0].url is required',
    })
  })
})

describe('project helpers', () => {
  it('parses comma-separated tags', () => {
    expect(parseTags(' NextJS, AI, , TypeScript ')).toEqual([
      'nextjs',
      'ai',
      'typescript',
    ])
  })

  it('resolves a relative og:image URL', () => {
    expect(
      extractOgImage(
        '<meta property="og:image" content="/share.png">',
        'https://example.com/project'
      )
    ).toBe('https://example.com/share.png')
  })
})
