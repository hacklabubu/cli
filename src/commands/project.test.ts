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
vi.mock('../project-fields.js', async () => {
  const actual = await vi.importActual<typeof import('../project-fields.js')>(
    '../project-fields.js'
  )
  return { ...actual, probeRepoPrivate: vi.fn().mockResolvedValue(false) }
})

import { parseViewTarget, project } from './project.js'

const OWN = {
  slug: 'cli',
  title: 'cli',
  description: 'terminal for hacklab',
  content: '# cli\n\nthe command',
  tags: [],
  repoUrl: 'https://github.com/hacklabubu/cli',
  liveUrl: 'https://cli.hacklab.so',
  private: false,
  source: 'cli',
  screenshots: [],
  publishedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  path: '/isomiki/cli',
}

const THEIRS = {
  slug: 'cli',
  title: 'cli',
  description: 'terminal for hacklab',
  content: '# Why I built it\n\nA terminal for hacklab.',
  tags: ['typescript'],
  repoUrl: 'https://github.com/alice/cli',
  liveUrl: 'https://cli.hacklab.so',
  path: '/alice/cli',
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

let exitCode: number | undefined
let out: string[]

function postBody(): Record<string, unknown> {
  const call = vi
    .mocked(fetchApi)
    .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'POST')
  return JSON.parse((call?.[2] as RequestInit).body as string)
}

function mockApi(opts?: { own?: unknown[]; theirs?: unknown[] }) {
  const own = opts?.own ?? [OWN]
  const theirs = opts?.theirs ?? [THEIRS]
  vi.mocked(fetchApi).mockImplementation((async (
    _s: unknown,
    path: string,
    init?: RequestInit
  ) => {
    if (init?.method === 'POST') return jsonResponse(OWN, 201)
    if (init?.method === 'DELETE') {
      return jsonResponse({ schemaVersion: 1, deleted: OWN })
    }
    if (path === '/api/projects') {
      return jsonResponse({
        schemaVersion: 1,
        handle: 'isomiki',
        projects: own,
      })
    }
    const one = path.match(/^\/api\/hackers\/([^/]+)\/projects\/([^/]+)$/)
    if (one) {
      const slug = one[2] ? decodeURIComponent(one[2]) : ''
      const hit = (theirs as { slug: string }[]).find((p) => p.slug === slug)
      if (!hit) {
        return jsonResponse(
          {
            schemaVersion: 1,
            error: { code: 'not_found', message: `no project named "${slug}"` },
          },
          404
        )
      }
      return jsonResponse({ schemaVersion: 1, handle: one[1], project: hit })
    }
    const list = path.match(/^\/api\/hackers\/([^/]+)\/projects$/)
    if (list) {
      const handle = list[1] ? decodeURIComponent(list[1]) : ''
      return jsonResponse({
        schemaVersion: 1,
        handle,
        projects: theirs,
      })
    }
    return jsonResponse({ error: 'unexpected path' }, 500)
  }) as never)
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
  mockApi()
})

const output = () => out.join('\n')

describe('parseViewTarget', () => {
  it('treats a handle as their list', () => {
    expect(parseViewTarget('alice')).toEqual({ kind: 'list', handle: 'alice' })
  })

  it('strips a leading @', () => {
    expect(parseViewTarget('@alice/cli')).toEqual({
      kind: 'one',
      handle: 'alice',
      slug: 'cli',
    })
  })

  it('splits handle/slug', () => {
    expect(parseViewTarget('alice/cli')).toEqual({
      kind: 'one',
      handle: 'alice',
      slug: 'cli',
    })
  })

  it('is missing when empty or the slug is blank', () => {
    expect(parseViewTarget(undefined)).toEqual({ kind: 'missing' })
    expect(parseViewTarget('alice/')).toEqual({ kind: 'missing' })
  })
})

describe('project command — help', () => {
  it('prints the agent help and exits 0 when run bare', async () => {
    await expect(project([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(0)
    expect(output()).toContain('hacklab project add --title')
    expect(output()).toContain('--url')
    expect(output()).toContain('hacklab project view <handle>/<slug>')
    expect(output()).toContain('hacklab project view <handle>')
    expect(output()).toContain('hacklab project delete <slug>')
    expect(output()).not.toContain('apply')
    expect(output()).not.toContain('edit')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('prints the same help for help/--help/-h', async () => {
    for (const token of ['help', '--help', '-h']) {
      out = []
      await expect(project([token])).rejects.toThrow('__exit__')
      expect(exitCode).toBe(0)
      expect(output()).toContain('hacklab project add --title')
    }
  })

  it('exits 1 on an unknown subcommand and still prints help', async () => {
    await expect(project(['frobnicate'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
    expect(output()).toContain('hacklab project add --title')
  })

  it('does not resolve a leftover edit verb', async () => {
    await expect(project(['edit', 'cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
  })
})

describe('project add', () => {
  it('exits 1 without a --title', async () => {
    await expect(
      project(['add', '--url', 'https://cli.hacklab.so'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('needs a title')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('exits 1 without a --url', async () => {
    await expect(project(['add', '--title', 'cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('needs a url')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('publishes a live site, deriving the slug from the title', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://cli.hacklab.so',
      '--desc',
      'terminal for hacklab',
    ])
    const body = postBody()
    expect(body.title).toBe('cli')
    expect(body.slug).toBe('cli')
    expect(body.description).toBe('terminal for hacklab')
    expect(body.liveUrl).toBe('https://cli.hacklab.so')
    expect(body.repoUrl).toBeUndefined()
    expect(output()).toContain('published')
    expect(output()).toContain('https://hacklab.so/isomiki/cli')
  })

  it('routes a github --url to repoUrl', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://github.com/hacklabubu/cli',
    ])
    expect(postBody().repoUrl).toBe('https://github.com/hacklabubu/cli')
    expect(postBody().liveUrl).toBeUndefined()
  })

  it('refreshes an existing slug and keeps its publish date', async () => {
    await project(['add', '--title', 'cli', '--url', 'https://cli.hacklab.so'])
    const body = postBody()
    expect(body.slug).toBe('cli')
    expect(body.publishedAt).toBe(OWN.publishedAt)
    expect(output()).toContain('refreshed')
  })

  it('--json prints a published envelope', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://cli.hacklab.so',
      '--json',
    ])
    const printed = JSON.parse(output())
    expect(printed.schemaVersion).toBe(1)
    expect(printed.published).toBe(true)
    expect(printed.slug).toBe('cli')
    expect(printed.path).toBe('/isomiki/cli')
  })

  it('rejects an unknown flag', async () => {
    await expect(
      project([
        'add',
        '--title',
        'cli',
        '--url',
        'https://x.dev',
        '--tags',
        'x',
      ])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown flag')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('exits 1 when not logged in', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(
      project(['add', '--title', 'cli', '--url', 'https://x.dev'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('not logged in')
  })
})

describe('project view', () => {
  it('lists someone else projects', async () => {
    await project(['view', 'alice'])
    expect(output()).toContain('cli')
    expect(output()).toContain('terminal for hacklab')
    expect(vi.mocked(fetchApi).mock.calls[0]?.[1]).toBe(
      '/api/hackers/alice/projects'
    )
  })

  it('renders one project including its long-form content', async () => {
    await project(['view', 'alice/cli'])
    expect(output()).toContain('cli')
    expect(output()).toContain('terminal for hacklab')
    expect(output()).toContain('Why I built it')
    expect(output()).toContain('https://hacklab.so/alice/cli')
    expect(vi.mocked(fetchApi).mock.calls[0]?.[1]).toBe(
      '/api/hackers/alice/projects/cli'
    )
  })

  it('--json prints the list envelope', async () => {
    await project(['view', 'alice', '--json'])
    const printed = JSON.parse(output())
    expect(printed.handle).toBe('alice')
    expect(printed.projects[0].slug).toBe('cli')
  })

  it('--json prints the full project for handle/slug', async () => {
    await project(['view', 'alice/cli', '--json'])
    const printed = JSON.parse(output())
    expect(printed.project.slug).toBe('cli')
    expect(printed.project.content).toContain('Why I built it')
  })

  it('404s a missing slug, exit 1', async () => {
    await expect(project(['view', 'alice/nope'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('no project named "nope"')
  })

  it('exits 1 without a handle', async () => {
    await expect(project(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab project view')
  })

  it('resolves the v prefix to view', async () => {
    await project(['v', 'alice/cli'])
    expect(output()).toContain('Why I built it')
  })
})

describe('project delete', () => {
  it('deletes by slug without a confirm', async () => {
    await project(['delete', 'cli'])
    const call = vi
      .mocked(fetchApi)
      .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'DELETE')
    expect(call?.[1]).toBe('/api/projects/cli')
    expect(output()).toContain('deleted')
    expect(output()).toContain('cli')
  })

  it('--json prints a deleted envelope', async () => {
    await project(['delete', 'cli', '--json'])
    const printed = JSON.parse(output())
    expect(printed.deleted).toBe(true)
    expect(printed.slug).toBe('cli')
  })

  it('exits 1 without a slug', async () => {
    await expect(project(['delete'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab project delete')
  })
})
