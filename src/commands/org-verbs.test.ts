import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: () => 'https://hacklab.so',
  unauthorizedHint: () => 'unauthorized — run hacklab login',
}))

import { extractOption, org } from './org.js'

const ACME = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Acme',
  slug: 'acme',
  isHiring: false,
}
const BETA = {
  id: 'b0000000-0000-4000-8000-000000000002',
  name: 'Beta',
  slug: 'beta',
  isHiring: true,
}
const STRIPE_CLAIMABLE = {
  id: 'c0000000-0000-4000-8000-000000000003',
  name: 'Stripe',
  slug: 'stripe',
  via: 'member' as const,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response
}

let exitCode: number | undefined
let out: string[]
let fetchMock: ReturnType<typeof vi.fn>

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
  } as never)

  // Default backend: one managed org, one claimable; PATCH echoes the fields.
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.endsWith('/api/cli/org') && method === 'GET') {
      return jsonResponse({
        organizations: [ACME],
        claimable: [STRIPE_CLAIMABLE],
      })
    }
    if (url.endsWith('/api/cli/org') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as {
        orgId: string
        fields: Record<string, unknown>
      }
      return jsonResponse({ ...ACME, ...body.fields })
    }
    if (url.endsWith('/api/cli/org/claim')) {
      return jsonResponse({
        id: STRIPE_CLAIMABLE.id,
        name: 'Stripe',
        slug: 'stripe',
      })
    }
    if (url.endsWith('/api/cli/org/create')) {
      const body = JSON.parse(String(init?.body)) as {
        fields: Record<string, unknown>
      }
      return jsonResponse({ id: 'new-id', ...body.fields })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

const output = () => out.join('\n')
const parsed = () => JSON.parse(output()) as Record<string, unknown>

describe('extractOption', () => {
  it('pulls the flag value and leaves the rest', () => {
    expect(extractOption(['a', '--org', 'acme', 'b'], '--org')).toEqual({
      value: 'acme',
      rest: ['a', 'b'],
    })
  })

  it('returns undefined when the flag is absent or valueless', () => {
    expect(extractOption(['a'], '--org').value).toBeUndefined()
    expect(extractOption(['--org'], '--org')).toEqual({
      value: undefined,
      rest: ['--org'],
    })
  })
})

describe('org list --json', () => {
  it('prints the state envelope', async () => {
    await org(['list', '--json'])
    const data = parsed()
    expect(data.schemaVersion).toBe(1)
    expect(data.organizations).toEqual([ACME])
    expect(data.claimable).toEqual([STRIPE_CLAIMABLE])
  })
})

describe('org view --json', () => {
  it('targets the single managed org by default', async () => {
    await org(['view', '--json'])
    expect((parsed().organization as { slug: string }).slug).toBe('acme')
  })

  it('bare `org --json` is a view', async () => {
    await org(['--json'])
    expect((parsed().organization as { slug: string }).slug).toBe('acme')
  })

  it('ambiguous with several orgs → ambiguous_org naming the slugs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ organizations: [ACME, BETA], claimable: [] })
    )
    await expect(org(['view', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    const err = parsed().error as { code: string; message: string }
    expect(err.code).toBe('ambiguous_org')
    expect(err.message).toContain('acme, beta')
  })

  it('--org picks among several', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ organizations: [ACME, BETA], claimable: [] })
    )
    await org(['view', '--org', 'beta', '--json'])
    expect((parsed().organization as { slug: string }).slug).toBe('beta')
  })
})

describe('org set', () => {
  it('normalizes and PATCHes one field, echoing the update', async () => {
    await org(['set', 'hiring', 'yes', '--json'])
    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      orgId: ACME.id,
      fields: { isHiring: true },
    })
    expect(parsed().updated).toEqual(['isHiring'])
  })

  it('warns when the slug changes', async () => {
    await org(['set', 'slug', 'acme-robotics', '--json'])
    expect(parsed().warnings).toEqual([
      'old links to /o/acme will no longer resolve',
    ])
  })

  it('rejects unknown fields with the field list', async () => {
    await expect(org(['set', 'nope', 'x', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('invalid_fields')
  })
})

describe('org apply', () => {
  it('applies a yaml file and reports the updated keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'org-apply-'))
    const file = join(dir, 'org.yaml')
    await writeFile(
      file,
      'hiring: true\nteam-size: 12\nlocations: Warsaw, Remote\n'
    )
    await org(['apply', file, '--json'])
    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body)).fields).toEqual({
      isHiring: true,
      teamSize: 12,
      locations: ['Warsaw', 'Remote'],
    })
    expect(parsed().updated).toEqual(['isHiring', 'teamSize', 'locations'])
  })

  it('missing file → read_failed', async () => {
    await expect(org(['apply', '/nope/org.yaml', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('read_failed')
  })
})

describe('org claim <slug>', () => {
  it('claims a claimable slug', async () => {
    await org(['claim', 'stripe', '--json'])
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/org/claim')
    )
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      orgId: STRIPE_CLAIMABLE.id,
    })
    expect((parsed().organization as { slug: string }).slug).toBe('stripe')
  })

  it('is a no-op success on an org you already manage', async () => {
    await org(['claim', 'acme', '--json'])
    expect(parsed().alreadyClaimed).toBe(true)
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/org/claim'))
    ).toBe(false)
  })

  it('unknown slug → not_found listing what is claimable', async () => {
    await expect(org(['claim', 'ghost', '--json'])).rejects.toThrow('__exit__')
    const err = parsed().error as { code: string; message: string }
    expect(err.code).toBe('not_found')
    expect(err.message).toContain('stripe')
  })
})

describe('org create --name', () => {
  it('creates with a derived slug and schemed website', async () => {
    await org([
      'create',
      '--name',
      'Acme Robotics',
      '--website',
      'acme.com',
      '--json',
    ])
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/org/create')
    )
    expect(JSON.parse(String(post?.[1]?.body)).fields).toEqual({
      name: 'Acme Robotics',
      slug: 'acme-robotics',
      website: 'https://acme.com',
    })
    expect((parsed().organization as { slug: string }).slug).toBe(
      'acme-robotics'
    )
  })

  it('slug collision → slug_exists envelope with existing + claimable', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/org/create')) {
        return jsonResponse(
          {
            error: 'A company with the slug "acme" already exists.',
            existing: {
              id: ACME.id,
              name: 'Acme',
              slug: 'acme',
              claimed: false,
              isMember: true,
            },
            claimable: true,
          },
          409
        )
      }
      throw new Error('unexpected')
    })
    await expect(org(['create', '--name', 'Acme', '--json'])).rejects.toThrow(
      '__exit__'
    )
    const data = parsed()
    expect((data.error as { code: string }).code).toBe('slug_exists')
    expect((data.existing as { slug: string }).slug).toBe('acme')
    expect(data.claimable).toBe(true)
  })

  it('missing --name → invalid_args', async () => {
    await expect(org(['create', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('invalid_args')
  })
})

describe('org dispatch', () => {
  it('unknown subcommand → usage with the verb list', async () => {
    await expect(org(['frobnicate'])).rejects.toThrow('__exit__')
    expect(output()).toContain('usage: hacklab org')
  })

  it('not logged in → json envelope on agent verbs', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(org(['list', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('unauthorized')
  })
})
