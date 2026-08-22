import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { probeRepoPrivate } from '../project-fields.js'
import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: (v: unknown) => typeof v === 'symbol',
}))
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

import * as clack from '@clack/prompts'

import { project } from './project.js'

const originalIsTTY = process.stdin.isTTY

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  })
}

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

function mockApi(opts?: { own?: unknown[] }) {
  const own = opts?.own ?? [OWN]
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
  // Default to the agent/CI shape: no TTY, so a missing --yes refuses rather
  // than hanging on a prompt.
  setTTY(false)
  vi.mocked(clack.confirm).mockResolvedValue(true)
})

afterEach(() => {
  setTTY(originalIsTTY as boolean)
})

const output = () => out.join('\n')

describe('project command — help', () => {
  it('prints the agent help and exits 0 when run bare', async () => {
    await expect(project([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(0)
    expect(output()).toContain('hacklab project add --title')
    expect(output()).toContain('--repo')
    expect(output()).toContain('hacklab project list')
    expect(output()).toContain('hacklab project view <slug>')
    expect(output()).toContain('hacklab project edit <slug>')
    expect(output()).toContain('hacklab project delete <slug>')
    expect(output()).not.toContain('apply')
    expect(output()).not.toContain('<handle>/<slug>')
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

  it('exits 1 without a --repo or --url', async () => {
    await expect(project(['add', '--title', 'cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('needs a link')
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

  it('takes --repo on a non-github git host', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--repo',
      'https://gitlab.com/hacklabubu/cli.git',
    ])
    expect(postBody().repoUrl).toBe('https://gitlab.com/hacklabubu/cli')
    expect(postBody().liveUrl).toBeUndefined()
  })

  it('keeps a github --url as the live site when --repo is given', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--repo',
      'git@codeberg.org:hacklabubu/cli.git',
      '--url',
      'https://github.com/hacklabubu/cli',
    ])
    expect(postBody().repoUrl).toBe('https://codeberg.org/hacklabubu/cli')
    expect(postBody().liveUrl).toBe('https://github.com/hacklabubu/cli')
  })

  it('rejects a --url that is not http(s)', async () => {
    await expect(
      project(['add', '--title', 'cli', '--url', 'ftp://files.example.com'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('--url must be an http(s) URL')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
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

  it('does not read a leading-dash flag value as a flag', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      '-30 days of hacking',
      '--url',
      'https://x.dev',
      '--desc',
      '--not-a-flag',
    ])
    const body = postBody()
    expect(body.title).toBe('-30 days of hacking')
    expect(body.description).toBe('--not-a-flag')
    expect(output()).not.toContain('unknown flag')
  })

  it('probes the repo for visibility by default', async () => {
    mockApi({ own: [] })
    vi.mocked(probeRepoPrivate).mockResolvedValue(true)
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://github.com/hacklabubu/cli',
    ])
    expect(postBody().private).toBe(true)
  })

  it('--public overrides a probe that says private', async () => {
    mockApi({ own: [] })
    vi.mocked(probeRepoPrivate).mockResolvedValue(true)
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://github.com/hacklabubu/cli',
      '--public',
    ])
    expect(postBody().private).toBe(false)
  })

  it('--private wins without probing', async () => {
    mockApi({ own: [] })
    await project([
      'add',
      '--title',
      'cli',
      '--url',
      'https://cli.hacklab.so',
      '--private',
    ])
    expect(postBody().private).toBe(true)
    expect(vi.mocked(probeRepoPrivate)).not.toHaveBeenCalled()
  })
})

describe('project list', () => {
  it('lists your own projects', async () => {
    await project(['list'])
    expect(output()).toContain('cli')
    expect(output()).toContain('terminal for hacklab')
    expect(vi.mocked(fetchApi).mock.calls[0]?.[1]).toBe('/api/projects')
  })

  it('points an empty list at project add', async () => {
    mockApi({ own: [] })
    await project(['list'])
    expect(output()).toContain('no projects yet')
    expect(output()).toContain('hacklab project add')
  })

  it('--json prints the list envelope', async () => {
    await project(['list', '--json'])
    const printed = JSON.parse(output())
    expect(printed.schemaVersion).toBe(1)
    expect(printed.handle).toBe('isomiki')
    expect(printed.projects[0].slug).toBe('cli')
  })
})

describe('project view', () => {
  it('renders one of your projects including its long-form content', async () => {
    await project(['view', 'cli'])
    expect(output()).toContain('terminal for hacklab')
    expect(output()).toContain('the command')
    expect(output()).toContain('https://hacklab.so/isomiki/cli')
    expect(vi.mocked(fetchApi).mock.calls[0]?.[1]).toBe('/api/projects')
  })

  it('--json prints the full project', async () => {
    await project(['view', 'cli', '--json'])
    const printed = JSON.parse(output())
    expect(printed.project.slug).toBe('cli')
    expect(printed.project.content).toContain('the command')
  })

  it('404s a missing slug with a near-match suggestion, exit 1', async () => {
    await expect(project(['view', 'cl'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('no project named "cl"')
    expect(output()).toContain('hacklab project view cli')
  })

  it('rejects a handle/slug argument', async () => {
    await expect(project(['view', 'alice/cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab project view <slug>')
    expect(vi.mocked(fetchApi)).not.toHaveBeenCalled()
  })

  it('exits 1 without a slug', async () => {
    await expect(project(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab project view')
  })

  it('resolves the v prefix to view', async () => {
    await project(['v', 'cli'])
    expect(output()).toContain('the command')
  })
})

describe('project edit', () => {
  it('exits 1 with usage when no slug is given', async () => {
    await expect(project(['edit', '--title', 'x'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab project edit')
  })

  it('exits 1 when no field flags are passed', async () => {
    await expect(project(['edit', 'cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('nothing to edit')
  })

  it('merges only passed fields and round-trips the rest', async () => {
    await project(['edit', 'cli', '--title', 'Renamed', '--desc', 'new'])
    const body = postBody()
    expect(body.title).toBe('Renamed')
    expect(body.description).toBe('new')
    expect(body.slug).toBe('cli')
    expect(body.content).toBe(OWN.content)
    expect(body.repoUrl).toBe(OWN.repoUrl)
    expect(body.liveUrl).toBe(OWN.liveUrl)
  })

  it('takes --repo on any git host', async () => {
    await project(['edit', 'cli', '--repo', 'git@gitlab.com:acme/next.git'])
    expect(postBody().repoUrl).toBe('https://gitlab.com/acme/next')
    expect(postBody().liveUrl).toBe(OWN.liveUrl)
  })

  it('routes a github --url to repoUrl and a plain --url to liveUrl', async () => {
    await project(['edit', 'cli', '--url', 'https://example.com'])
    expect(postBody().liveUrl).toBe('https://example.com')
    expect(postBody().repoUrl).toBe(OWN.repoUrl)

    vi.mocked(fetchApi).mockClear()
    mockApi()
    await project(['edit', 'cli', '--url', 'https://github.com/acme/next'])
    expect(postBody().repoUrl).toBe('https://github.com/acme/next')
  })

  it('404s a missing slug with a suggestion, exit 1', async () => {
    await expect(project(['edit', 'cl', '--title', 'x'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(output()).toContain('no project named "cl"')
    expect(output()).toContain('hacklab project edit cli')
  })

  it('--json prints an edited envelope', async () => {
    await project(['edit', 'cli', '--title', 'Renamed', '--json'])
    const printed = JSON.parse(output())
    expect(printed.edited).toBe(true)
    expect(printed.slug).toBe('cli')
    expect(printed.path).toBe('/isomiki/cli')
  })

  it('resolves the e prefix to edit', async () => {
    await project(['e', 'cli', '--title', 'Renamed'])
    expect(postBody().title).toBe('Renamed')
  })

  it('keeps the stored visibility when the repo is untouched', async () => {
    mockApi({ own: [{ ...OWN, private: true }] })
    await project(['edit', 'cli', '--title', 'Renamed'])
    expect(postBody().private).toBe(true)
    expect(vi.mocked(probeRepoPrivate)).not.toHaveBeenCalled()
  })

  it('re-probes visibility when the repo URL changes', async () => {
    mockApi({ own: [{ ...OWN, private: false }] })
    vi.mocked(probeRepoPrivate).mockResolvedValue(true)
    await project(['edit', 'cli', '--repo', 'https://github.com/acme/next'])
    expect(vi.mocked(probeRepoPrivate)).toHaveBeenCalledWith(
      'https://github.com/acme/next'
    )
    expect(postBody().private).toBe(true)
  })

  it('an explicit --public beats the re-probe', async () => {
    mockApi({ own: [{ ...OWN, private: true }] })
    vi.mocked(probeRepoPrivate).mockResolvedValue(true)
    await project([
      'edit',
      'cli',
      '--repo',
      'https://github.com/acme/next',
      '--public',
    ])
    expect(postBody().private).toBe(false)
  })

  it('accepts --private alone as an edit', async () => {
    await project(['edit', 'cli', '--private'])
    expect(postBody().private).toBe(true)
    expect(output()).not.toContain('nothing to edit')
  })

  it('refuses to edit a github-synced project without --yes', async () => {
    mockApi({ own: [{ ...OWN, source: 'github' }] })
    await expect(project(['edit', 'cli', '--title', 'x'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(output()).toContain('synced from GitHub')
    const call = vi
      .mocked(fetchApi)
      .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'POST')
    expect(call).toBeUndefined()
  })

  it('--json reports the synced refusal with a code', async () => {
    mockApi({ own: [{ ...OWN, source: 'github' }] })
    await expect(
      project(['edit', 'cli', '--title', 'x', '--json'])
    ).rejects.toThrow('__exit__')
    expect(JSON.parse(output()).error.code).toBe('synced')
  })

  it('edits a github-synced project with --yes', async () => {
    mockApi({ own: [{ ...OWN, source: 'github' }] })
    await project(['edit', 'cli', '--title', 'Renamed', '--yes'])
    expect(postBody().title).toBe('Renamed')
  })
})

describe('project delete', () => {
  it('deletes by slug with --yes', async () => {
    await project(['delete', 'cli', '--yes'])
    const call = vi
      .mocked(fetchApi)
      .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'DELETE')
    expect(call?.[1]).toBe('/api/projects/cli')
    expect(output()).toContain('deleted')
    expect(output()).toContain('cli')
    expect(vi.mocked(clack.confirm)).not.toHaveBeenCalled()
  })

  it('refuses without --yes when there is no TTY', async () => {
    await expect(project(['delete', 'cli'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('refusing to delete without confirmation')
    const call = vi
      .mocked(fetchApi)
      .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'DELETE')
    expect(call).toBeUndefined()
  })

  it('refuses without --yes in --json mode even on a TTY', async () => {
    setTTY(true)
    await expect(project(['delete', 'cli', '--json'])).rejects.toThrow(
      '__exit__'
    )
    const printed = JSON.parse(output())
    expect(printed.error.code).toBe('confirm')
    expect(vi.mocked(clack.confirm)).not.toHaveBeenCalled()
  })

  it('prompts on a TTY and keeps the project when declined', async () => {
    setTTY(true)
    vi.mocked(clack.confirm).mockResolvedValue(false)
    await project(['delete', 'cli'])
    expect(output()).toContain('kept.')
    const call = vi
      .mocked(fetchApi)
      .mock.calls.find((c) => (c[2] as RequestInit)?.method === 'DELETE')
    expect(call).toBeUndefined()
  })

  it('deletes after an accepted TTY prompt', async () => {
    setTTY(true)
    vi.mocked(clack.confirm).mockResolvedValue(true)
    await project(['delete', 'cli'])
    expect(vi.mocked(clack.confirm)).toHaveBeenCalled()
    expect(output()).toContain('deleted')
  })

  it('--json prints a deleted envelope', async () => {
    await project(['delete', 'cli', '--yes', '--json'])
    const printed = JSON.parse(output())
    expect(printed.deleted).toBe(true)
    expect(printed.slug).toBe('cli')
  })

  it('exits 1 without a slug', async () => {
    await expect(project(['delete', '--yes'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab project delete')
  })
})
