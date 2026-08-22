import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Session } from '../session.js'
import { loadSession } from '../session.js'

vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return {
    ...actual,
    loadSession: vi.fn(),
  }
})
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn().mockResolvedValue(undefined),
}))

import { essay, formatEssayDate, parseViewTarget, readError } from './essay.js'

const ESSAY = {
  id: '3f9c1ab0-1234-5678-9abc-def012345678',
  title: 'Why I built this',
  excerpt: 'A short note.',
  contentText: '# Why I built this\n\nA terminal for hacklab.',
  readingTimeMinutes: 4,
  source: 'cli',
  publishedAt: '2026-07-12T10:00:00.000Z',
  authorHandle: 'alice',
  authorDisplayName: 'Alice',
  path: '/alice/writes/why-i-built-this',
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

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
  vi.mocked(loadSession).mockResolvedValue({
    token: 't',
    appUrl: 'https://hacklab.so',
    handle: 'isomiki',
  } as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && href.endsWith('/api/essays')) {
        return jsonResponse(
          {
            id: ESSAY.id,
            title: ESSAY.title,
            path: ESSAY.path,
          },
          201
        )
      }
      if (method === 'PATCH') {
        return jsonResponse({
          id: ESSAY.id,
          title: ESSAY.title,
          path: ESSAY.path,
        })
      }
      if (method === 'DELETE') {
        return jsonResponse({ id: ESSAY.id, title: ESSAY.title })
      }
      if (href.includes('/api/essays?user=')) {
        const user = new URL(href).searchParams.get('user')
        if (user === 'nope') {
          return jsonResponse({ error: 'Hacker not found' }, 404)
        }
        return jsonResponse({
          kind: 'user',
          author: { handle: user, displayName: null },
          items: [
            {
              id: ESSAY.id,
              title: ESSAY.title,
              excerpt: ESSAY.excerpt,
              readingTimeMinutes: 4,
              source: 'cli',
              publishedAt: ESSAY.publishedAt,
              path: ESSAY.path,
            },
          ],
          total: 1,
          page: 1,
          totalPages: 1,
        })
      }
      if (href.includes('/api/essays/')) {
        const id = href.split('/api/essays/')[1] ?? ''
        if (id.startsWith('dead') || id.startsWith('nope')) {
          return jsonResponse({ error: 'Essay not found' }, 404)
        }
        return jsonResponse({ essay: ESSAY })
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const output = () => out.join('\n')

describe('parseViewTarget', () => {
  it('treats a handle as their list', () => {
    expect(parseViewTarget('alice')).toEqual({
      kind: 'list',
      handle: 'alice',
    })
  })

  it('strips a leading @', () => {
    expect(parseViewTarget('@alice')).toEqual({
      kind: 'list',
      handle: 'alice',
    })
  })

  it('treats a uuid prefix as one essay', () => {
    expect(parseViewTarget('3f9c1ab0')).toEqual({
      kind: 'one',
      id: '3f9c1ab0',
    })
  })

  it('is missing when empty', () => {
    expect(parseViewTarget(undefined)).toEqual({ kind: 'missing' })
  })
})

describe('essay command — help', () => {
  it('prints the agent help and exits 0 when run bare', async () => {
    await expect(essay([])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(0)
    expect(output()).toContain('hacklab essay post --title')
    expect(output()).toContain('--content')
    expect(output()).toContain('--file')
    expect(output()).toContain('hacklab essay update <id>')
    expect(output()).toContain('hacklab essay view <id>')
    expect(output()).toContain('hacklab essay view <handle>')
    expect(output()).toContain('hacklab essay delete <id>')
    expect(output()).not.toContain('essays on your profile')
    expect(output()).not.toContain('--web')
    expect(output()).not.toContain('--yes')
    expect(output()).not.toContain('hacklab essay list')
  })

  it('exits 1 on an unknown subcommand and still prints help', async () => {
    await expect(essay(['list'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
    expect(output()).toContain('hacklab essay post --title')
  })
})

describe('essay post', () => {
  it('exits 1 without a --title', async () => {
    await expect(essay(['post', '--content', '# hi'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(output()).toContain('needs a title')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('exits 1 without --content or --file', async () => {
    await expect(essay(['post', '--title', 'Why'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('--content')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('publishes from --content', async () => {
    await essay([
      'post',
      '--title',
      'Why I built this',
      '--content',
      '# Why I built this\n\nA terminal.',
    ])
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.title).toBe('Why I built this')
    expect(body.markdown).toContain('A terminal.')
    expect(output()).toContain('published')
    expect(output()).toContain('Why I built this')
  })

  it('publishes from --file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'essay-'))
    const file = join(dir, 'note.md')
    await writeFile(file, '# Why I built this\n\nFrom disk.')
    await essay(['post', '--title', 'Why I built this', '--file', file])
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.markdown).toContain('From disk.')
  })

  it('rejects --content and --file together', async () => {
    await expect(
      essay(['post', '--title', 'Why', '--content', '# hi', '--file', 'x.md'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('either --content or --file')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('--json prints a published envelope', async () => {
    await essay([
      'post',
      '--title',
      'Why I built this',
      '--content',
      '# hi',
      '--json',
    ])
    const printed = JSON.parse(output())
    expect(printed.schemaVersion).toBe(1)
    expect(printed.id).toBe(ESSAY.id)
    expect(printed.path).toBe(ESSAY.path)
  })

  it('rejects an unknown flag', async () => {
    await expect(
      essay(['post', '--title', 'Why', '--content', '# hi', '--web'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('unknown flag')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})

describe('essay update', () => {
  it('replaces content and keeps the path', async () => {
    await essay(['update', '3f9c1ab0', '--content', '# new'])
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/essays/3f9c1ab0')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body)).markdown).toBe('# new')
    expect(output()).toContain('updated')
  })

  it('exits 1 without an id', async () => {
    await expect(essay(['update', '--content', '# new'])).rejects.toThrow(
      '__exit__'
    )
    expect(output()).toContain('hacklab essay update')
  })
})

describe('essay view', () => {
  it('renders one essay including its body', async () => {
    await essay(['view', '3f9c1ab0'])
    expect(output()).toContain('Why I built this')
    expect(output()).toContain('A terminal for hacklab')
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      '/api/essays/3f9c1ab0'
    )
  })

  it('lists someone else essays', async () => {
    await essay(['view', 'alice'])
    expect(output()).toContain('Why I built this')
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('user=alice')
  })

  it('falls a hex 404 through to a handle list', async () => {
    await essay(['view', 'dead'])
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/api/essays/dead'))).toBe(true)
    expect(urls.some((u) => u.includes('user=dead'))).toBe(true)
    expect(output()).toContain('Why I built this')
  })

  it('--json prints the essay envelope', async () => {
    await essay(['view', '3f9c1ab0', '--json'])
    const printed = JSON.parse(output())
    expect(printed.essay.title).toBe('Why I built this')
    expect(printed.essay.contentText).toContain('A terminal for hacklab')
  })

  it('exits 1 without a target', async () => {
    await expect(essay(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab essay view')
  })
})

describe('essay delete', () => {
  it('deletes by id without a confirm', async () => {
    await essay(['delete', '3f9c1ab0'])
    const call = vi
      .mocked(fetch)
      .mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
      )
    expect(String(call?.[0])).toContain('/api/essays/3f9c1ab0')
    expect(output()).toContain('deleted')
  })

  it('--json prints a deleted envelope', async () => {
    await essay(['delete', '3f9c1ab0', '--json'])
    const printed = JSON.parse(output())
    expect(printed.deleted).toBe(true)
    expect(printed.id).toBe(ESSAY.id)
  })
})

describe('readError', () => {
  const session: Session = {
    token: 't',
    email: 'user@example.com',
    appUrl: 'https://app.example.com',
    savedAt: '2026-01-01T00:00:00Z',
  }

  it('turns a 401 into the backend-mismatch hint when a session is given', async () => {
    vi.stubEnv('HACKLAB_APP_URL', 'http://localhost:3000')
    const res = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    })
    const msg = await readError(res, session)
    expect(msg).toContain('hacklab login --env development')
    expect(msg).not.toBe('Unauthorized')
  })

  it('keeps the server text for a 401 on a public read (no session)', async () => {
    const res = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    })
    expect(await readError(res)).toBe('Unauthorized')
  })
})

describe('formatEssayDate', () => {
  it('renders an absolute lowercase date', () => {
    expect(formatEssayDate('2026-07-12T10:00:00.000Z')).toMatch(
      /^jul 1[12] 2026$/
    )
  })

  it('falls back to the raw string when unparseable', () => {
    expect(formatEssayDate('not-a-date')).toBe('not-a-date')
  })
})
