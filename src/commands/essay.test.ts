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
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: (v: unknown) => typeof v === 'symbol',
}))

import * as clack from '@clack/prompts'

import {
  essay,
  formatEssayDate,
  parseListTarget,
  parseViewTarget,
  readError,
} from './essay.js'

const originalIsTTY = process.stdin.isTTY

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  })
}

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

function listResponse(over?: Partial<Record<string, unknown>>) {
  return {
    kind: 'user',
    author: { handle: 'alice', displayName: null },
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
    ...over,
  }
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
      if (href.includes('/api/essays?')) {
        const params = new URL(href).searchParams
        const org = params.get('org')
        if (org) {
          return jsonResponse(
            listResponse({
              kind: 'org',
              author: undefined,
              org: { name: 'Homebrew', slug: org },
            })
          )
        }
        const user = params.get('user')
        if (user === 'nope') {
          return jsonResponse({ error: 'Hacker not found' }, 404)
        }
        return jsonResponse(
          listResponse({ author: { handle: user, displayName: null } })
        )
      }
      if (href.includes('/api/essays/')) {
        const id = href.split('/api/essays/')[1] ?? ''
        if (id.startsWith('dead') || id.startsWith('cafe')) {
          return jsonResponse({ error: 'Essay not found' }, 404)
        }
        return jsonResponse({ essay: ESSAY })
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
  )
  // Default to the agent/CI shape: no TTY, so a missing --yes refuses rather
  // than hanging on a prompt.
  setTTY(false)
  vi.mocked(clack.confirm).mockResolvedValue(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  setTTY(originalIsTTY as boolean)
})

const output = () => out.join('\n')

describe('parseViewTarget', () => {
  it('treats a uuid prefix as one essay', () => {
    expect(parseViewTarget('3f9c1ab0')).toEqual({
      kind: 'one',
      id: '3f9c1ab0',
    })
  })

  it('flags a handle as not an id', () => {
    expect(parseViewTarget('alice')).toEqual({
      kind: 'not-an-id',
      token: 'alice',
    })
    expect(parseViewTarget('@alice')).toEqual({
      kind: 'not-an-id',
      token: 'alice',
    })
  })

  it('is missing when empty', () => {
    expect(parseViewTarget(undefined)).toEqual({ kind: 'missing' })
  })
})

// The list-target grammar is the load-bearing design decision of `essay list`:
// user vs org is decided by ARGUMENT COUNT, never by whether the word "org"
// could be a username.
describe('parseListTarget', () => {
  it('no args → your own essays', () => {
    expect(parseListTarget([])).toEqual({ kind: 'self' })
  })

  it('one arg → a user handle', () => {
    expect(parseListTarget(['ada'])).toEqual({ kind: 'user', handle: 'ada' })
    expect(parseListTarget(['@ada'])).toEqual({ kind: 'user', handle: 'ada' })
  })

  it('`org <slug>` → an org', () => {
    expect(parseListTarget(['org', 'homebrew'])).toEqual({
      kind: 'org',
      slug: 'homebrew',
    })
  })

  it('`org/<slug>` mirrors the web URL form', () => {
    expect(parseListTarget(['org/homebrew'])).toEqual({
      kind: 'org',
      slug: 'homebrew',
    })
  })

  it('a bare `org` is the USER named org, not an org lookup', () => {
    expect(parseListTarget(['org'])).toEqual({ kind: 'user', handle: 'org' })
  })

  it('`org/` with no slug is invalid', () => {
    expect(parseListTarget(['org/'])).toEqual({ kind: 'invalid' })
  })

  it('three positionals are invalid', () => {
    expect(parseListTarget(['org', 'a', 'b'])).toEqual({ kind: 'invalid' })
  })

  it('two positionals not led by org are invalid', () => {
    expect(parseListTarget(['ada', 'lovelace'])).toEqual({ kind: 'invalid' })
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
    expect(output()).toContain('hacklab essay list')
    expect(output()).toContain('hacklab essay view <id>')
    expect(output()).toContain('hacklab essay delete <id>')
    expect(output()).toContain('--yes')
    expect(output()).not.toContain('essays on your profile')
    expect(output()).not.toContain('--web')
  })

  it('exits 1 on an unknown subcommand and still prints help', async () => {
    await expect(essay(['frobnicate'])).rejects.toThrow('__exit__')
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

  it('publishes from a positional file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'essay-'))
    const file = join(dir, 'note.md')
    await writeFile(file, '# Why I built this\n\nPositional.')
    await essay(['post', file, '--title', 'Why I built this'])
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.markdown).toContain('Positional.')
  })

  it('rejects a positional file alongside --content', async () => {
    await expect(
      essay(['post', 'note.md', '--title', 'Why', '--content', '# hi'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('use one markdown source')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
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

  it('does not read a leading-dash flag value as a flag', async () => {
    await essay([
      'post',
      '--title',
      '-30 days in',
      '--content',
      '- bullet\n- another',
    ])
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.title).toBe('-30 days in')
    expect(body.markdown).toBe('- bullet\n- another')
    expect(output()).not.toContain('unknown flag')
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

  it('takes the markdown from a positional file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'essay-'))
    const file = join(dir, 'note.md')
    await writeFile(file, '# Rewritten')
    await essay(['update', '3f9c1ab0', file])
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).markdown).toContain('# Rewritten')
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

  it('--json prints the essay envelope', async () => {
    await essay(['view', '3f9c1ab0', '--json'])
    const printed = JSON.parse(output())
    expect(printed.essay.title).toBe('Why I built this')
    expect(printed.essay.contentText).toContain('A terminal for hacklab')
  })

  it('rejects a handle that cannot be an id, pointing at list', async () => {
    await expect(essay(['view', 'alice'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab essay list alice')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('suggests list when a hex-looking handle 404s as an id', async () => {
    await expect(essay(['view', 'cafe'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('no essay named "cafe"')
    expect(output()).toContain('hacklab essay list cafe')
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('user=cafe'))).toBe(false)
  })

  it('exits 1 without a target', async () => {
    await expect(essay(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab essay view')
  })
})

describe('essay list', () => {
  it('lists your own essays with no argument', async () => {
    await essay(['list'])
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      'user=isomiki'
    )
    expect(output()).toContain('Why I built this')
  })

  it("lists a hacker's essays", async () => {
    await essay(['list', 'alice'])
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('user=alice')
    expect(output()).toContain('Why I built this')
    expect(output()).toContain('https://hacklab.so/alice')
  })

  it("lists an org's essays from both spellings", async () => {
    await essay(['list', 'org', 'homebrew'])
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      'org=homebrew'
    )

    vi.mocked(fetch).mockClear()
    await essay(['list', 'org/homebrew'])
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      'org=homebrew'
    )
  })

  it('passes --page through and hints at the next one', async () => {
    vi.mocked(fetch).mockImplementation((async () =>
      jsonResponse(
        listResponse({ page: 2, totalPages: 3, total: 30 })
      )) as never)
    await essay(['list', 'alice', '--page', '2'])
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('page=2')
    expect(output()).toContain('hacklab essay list alice --page 3')
  })

  it('rejects a non-numeric --page', async () => {
    await expect(essay(['list', 'alice', '--page', 'x'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(output()).toContain('--page must be a positive integer')
  })

  it('rejects two positionals not led by org', async () => {
    await expect(essay(['list', 'ada', 'lovelace'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('hacklab essay list')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('404s an unknown handle, exit 1', async () => {
    await expect(essay(['list', 'nope'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('no hacker named "nope"')
  })

  it('--json prints the list envelope', async () => {
    await essay(['list', 'alice', '--json'])
    const printed = JSON.parse(output())
    expect(printed.schemaVersion).toBe(1)
    expect(printed.items[0].title).toBe('Why I built this')
  })

  it('points an empty own list at essay post', async () => {
    vi.mocked(fetch).mockImplementation((async () =>
      jsonResponse(listResponse({ items: [], total: 0 }))) as never)
    await essay(['list'])
    expect(output()).toContain('no essays')
    expect(output()).toContain('hacklab essay post')
  })
})

describe('essay delete', () => {
  const deleteCall = () =>
    vi
      .mocked(fetch)
      .mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
      )

  it('deletes by id with --yes', async () => {
    await essay(['delete', '3f9c1ab0', '--yes'])
    expect(String(deleteCall()?.[0])).toContain('/api/essays/3f9c1ab0')
    expect(output()).toContain('deleted')
    expect(vi.mocked(clack.confirm)).not.toHaveBeenCalled()
  })

  it('accepts the -y spelling old scripts pass', async () => {
    await essay(['delete', '3f9c1ab0', '-y'])
    expect(output()).not.toContain('unknown flag')
    expect(String(deleteCall()?.[0])).toContain('/api/essays/3f9c1ab0')
  })

  it('refuses without --yes when there is no TTY', async () => {
    await expect(essay(['delete', '3f9c1ab0'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('refusing to delete without confirmation')
    expect(deleteCall()).toBeUndefined()
  })

  it('refuses without --yes in --json mode even on a TTY', async () => {
    setTTY(true)
    await expect(essay(['delete', '3f9c1ab0', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect(JSON.parse(output()).error.code).toBe('confirm')
    expect(deleteCall()).toBeUndefined()
  })

  it('names the essay in the TTY prompt and keeps it when declined', async () => {
    setTTY(true)
    vi.mocked(clack.confirm).mockResolvedValue(false)
    await essay(['delete', '3f9c1ab0'])
    expect(
      String(vi.mocked(clack.confirm).mock.calls[0]?.[0].message)
    ).toContain('Why I built this')
    expect(output()).toContain('kept.')
    expect(deleteCall()).toBeUndefined()
  })

  it('deletes after an accepted TTY prompt', async () => {
    setTTY(true)
    vi.mocked(clack.confirm).mockResolvedValue(true)
    await essay(['delete', '3f9c1ab0'])
    expect(deleteCall()).toBeDefined()
    expect(output()).toContain('deleted')
  })

  it('--json prints a deleted envelope', async () => {
    await essay(['delete', '3f9c1ab0', '--yes', '--json'])
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
