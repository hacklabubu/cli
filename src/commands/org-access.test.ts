import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: () => 'https://hacklab.so',
  unauthorizedHint: () => 'unauthorized — run hacklab login',
}))

import {
  accessErrorCode,
  accessErrorHint,
  claimantLabel,
  grantedByLabel,
  normalizeHandle,
  org,
} from './org.js'

// `hacklab org access` — list/grant/revoke over /api/cli/org/access. Same
// harness as org-verbs.test.ts, except stdout and stderr are captured
// separately: `--json` promises exactly one JSON object on stdout and hints on
// stderr, and that's only checkable if the two streams stay apart.

const ACME = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Acme',
  slug: 'acme',
}
const BETA = {
  id: 'b0000000-0000-4000-8000-000000000002',
  name: 'Beta',
  slug: 'beta',
}

const ORG_SUMMARY = { id: ACME.id, name: 'Acme', slug: 'acme' }

const YOU = {
  handle: 'marin',
  displayName: 'Marin Belec',
  email: 'marin@hacklab.so',
  grantedBy: null,
  since: '2026-06-12T10:00:00.000Z',
  isYou: true,
}
const COLLEAGUE = {
  handle: 'kasia',
  displayName: 'Kasia Nowak',
  email: 'kasia@hacklab.so',
  grantedBy: 'user_3f9c1a2b4d5e6f70',
  since: '2026-07-14T10:00:00.000Z',
  isYou: false,
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

let exitCode: number | undefined
let stdout: string[]
let stderr: string[]
let fetchMock: ReturnType<typeof vi.fn>
/** Overrides the access route's answer for one test. */
let accessHandler: (method: string, url: URL, body: unknown) => Response

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  stdout = []
  stderr = []
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    stdout.push(String(m))
  })
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    stderr.push(String(m))
  })
  vi.mocked(loadSession).mockResolvedValue({
    token: 't',
    appUrl: 'https://hacklab.so',
    handle: 'marin',
  } as never)

  accessHandler = () =>
    jsonResponse({ organization: ORG_SUMMARY, claimants: [YOU, COLLEAGUE] })

  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const href = String(input)
    if (href.endsWith('/api/cli/org') && method === 'GET') {
      return jsonResponse({ organizations: [ACME], claimable: [] })
    }
    if (href.includes('/api/cli/org/access')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      return accessHandler(method, new URL(href), body)
    }
    throw new Error(`unexpected fetch: ${method} ${href}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

const out = () => stdout.join('\n')
const err = () => stderr.join('\n')
const parsed = () => JSON.parse(out()) as Record<string, unknown>
const accessCall = () =>
  fetchMock.mock.calls.find((c) => String(c[0]).includes('/access'))

// --- pure helpers -----------------------------------------------------------

describe('normalizeHandle', () => {
  it('drops a leading @ and surrounding whitespace', () => {
    expect(normalizeHandle('  @marin ')).toBe('marin')
    expect(normalizeHandle('marin')).toBe('marin')
    expect(normalizeHandle('@@marin')).toBe('marin')
  })

  it('returns empty for a bare @ or blank input', () => {
    expect(normalizeHandle('@')).toBe('')
    expect(normalizeHandle('   ')).toBe('')
  })
})

describe('accessErrorCode', () => {
  it('separates the three refusals that all arrive as 404', () => {
    expect(accessErrorCode(404, 'No Hacklab account for @ghost.')).toBe(
      'no_such_account'
    )
    expect(
      accessErrorCode(404, '@kasia does not control this organization.')
    ).toBe('not_a_claimant')
    expect(accessErrorCode(404, 'Organization not found.')).toBe(
      'org_not_found'
    )
  })

  it('maps the non-404 refusals by status', () => {
    expect(accessErrorCode(401, 'unauthorized')).toBe('unauthorized')
    expect(accessErrorCode(403, 'You do not control this organization.')).toBe(
      'forbidden'
    )
    expect(accessErrorCode(409, 'That is the only account…')).toBe(
      'last_claimant'
    )
    expect(accessErrorCode(400, 'orgSlug is required.')).toBe('invalid_args')
    expect(accessErrorCode(500, 'boom')).toBe('error')
  })
})

describe('accessErrorHint', () => {
  it('tells the last controller what to do instead', () => {
    expect(accessErrorHint('last_claimant')).toContain(
      'hacklab org access grant'
    )
  })

  it('has nothing to add for a generic failure', () => {
    expect(accessErrorHint('error')).toBeNull()
  })
})

describe('claimantLabel', () => {
  it('prefers the handle', () => {
    expect(claimantLabel({ handle: 'marin', email: 'm@x.test' })).toBe('@marin')
  })

  it('falls back to email when there is no hacker profile', () => {
    expect(claimantLabel({ handle: null, email: 'm@x.test' })).toBe('m@x.test')
  })

  it('strips control characters — handles are untrusted text', () => {
    const esc = String.fromCharCode(27)
    expect(claimantLabel({ handle: `ma${esc}[31min`, email: 'm@x.test' })).toBe(
      '@ma[31min'
    )
  })
})

describe('grantedByLabel', () => {
  it('names a null granter as the original claim', () => {
    expect(grantedByLabel(null)).toBe('original claim')
  })

  it('truncates a long user id', () => {
    expect(grantedByLabel('user_3f9c1a2b4d5e6f70')).toBe(
      'granted by user_3f9c1a2…'
    )
  })

  it('keeps a short id whole', () => {
    expect(grantedByLabel('u_123')).toBe('granted by u_123')
  })
})

// --- list -------------------------------------------------------------------

describe('org access list', () => {
  it('returns the claimants envelope in --json', async () => {
    await org(['access', 'list', '--json'])
    const data = parsed()
    expect(data.schemaVersion).toBe(1)
    expect(data.organization).toEqual(ORG_SUMMARY)
    expect(data.claimants).toEqual([YOU, COLLEAGUE])
    expect(String(accessCall()?.[0])).toContain('orgSlug=acme')
  })

  it('prints exactly one JSON object on stdout and nothing else', async () => {
    await org(['access', 'list', '--json'])
    expect(() => parsed()).not.toThrow()
    expect(err()).toBe('')
  })

  it('bare `org access` is the list', async () => {
    await org(['access', '--json'])
    expect(parsed().claimants).toEqual([YOU, COLLEAGUE])
  })

  it('renders each controller with who granted them', async () => {
    await org(['access'])
    expect(out()).toContain('@marin')
    expect(out()).toContain('Kasia Nowak')
    expect(out()).toContain('you · original claim')
    expect(out()).toContain('granted by user_3f9c1a2…')
  })

  it('--org picks among several managed orgs', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ organizations: [ACME, BETA], claimable: [] })
    )
    await org(['access', 'list', '--org', 'beta', '--json'])
    expect(String(accessCall()?.[0])).toContain('orgSlug=beta')
  })

  it('several orgs and no --org → ambiguous_org', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ organizations: [ACME, BETA], claimable: [] })
    )
    await expect(org(['access', 'list', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('ambiguous_org')
  })

  it('not logged in → unauthorized envelope', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(org(['access', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('unauthorized')
  })

  it('an expired token → unauthorized envelope', async () => {
    accessHandler = () => jsonResponse({ error: 'Unauthorized' }, 401)
    await expect(org(['access', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('unauthorized')
  })

  it('an org you no longer control → org_not_found with a way forward', async () => {
    accessHandler = () =>
      jsonResponse({ error: 'Organization not found.' }, 404)
    await expect(org(['access'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(err()).toContain('Organization not found.')
    expect(err()).toContain('hacklab org list')
  })
})

// --- grant ------------------------------------------------------------------

describe('org access grant', () => {
  beforeEach(() => {
    accessHandler = (_method, _url, body) =>
      jsonResponse({
        status: 'granted',
        handle: (body as { handle: string }).handle,
      })
  })

  it('posts the org slug and handle, and echoes the status', async () => {
    await org(['access', 'grant', 'kasia', '--json'])
    const call = accessCall()
    expect(call?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      orgSlug: 'acme',
      handle: 'kasia',
    })
    const data = parsed()
    expect(data.status).toBe('granted')
    expect(data.handle).toBe('kasia')
    expect(data.organization).toEqual(ORG_SUMMARY)
  })

  it('accepts a @-prefixed handle', async () => {
    await org(['access', 'grant', '@kasia', '--json'])
    expect(JSON.parse(String(accessCall()?.[1]?.body)).handle).toBe('kasia')
  })

  it('reports an existing controller as already_claimed, not an error', async () => {
    accessHandler = () =>
      jsonResponse({ status: 'already_claimed', handle: 'kasia' })
    await org(['access', 'grant', 'kasia', '--json'])
    expect(parsed().status).toBe('already_claimed')
  })

  it('confirms the grant in human mode', async () => {
    await org(['access', 'grant', 'kasia'])
    expect(out()).toContain('@kasia now controls')
  })

  it('a handle with no hacklab account → no_such_account', async () => {
    accessHandler = () =>
      jsonResponse({ error: 'No Hacklab account for @ghost.' }, 404)
    await expect(org(['access', 'grant', 'ghost', '--json'])).rejects.toThrow(
      '__exit__'
    )
    const error = parsed().error as { code: string; message: string }
    expect(error.code).toBe('no_such_account')
    expect(error.message).toContain('No Hacklab account for @ghost.')
  })

  it('losing control mid-flight → forbidden', async () => {
    accessHandler = () =>
      jsonResponse({ error: 'You do not control this organization.' }, 403)
    await expect(org(['access', 'grant', 'kasia', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('forbidden')
  })

  it('missing handle → invalid_args without calling the route', async () => {
    await expect(org(['access', 'grant', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('invalid_args')
    expect(accessCall()).toBeUndefined()
  })
})

// --- revoke -----------------------------------------------------------------

describe('org access revoke', () => {
  beforeEach(() => {
    accessHandler = (_method, url) =>
      jsonResponse({
        status: 'revoked',
        handle: url.searchParams.get('handle'),
      })
  })

  it('sends slug and handle as query params on DELETE', async () => {
    await org(['access', 'revoke', 'kasia', '--json'])
    const call = accessCall()
    expect(call?.[1]?.method).toBe('DELETE')
    const url = new URL(String(call?.[0]))
    expect(url.searchParams.get('orgSlug')).toBe('acme')
    expect(url.searchParams.get('handle')).toBe('kasia')
    expect(parsed().status).toBe('revoked')
  })

  it('confirms removing someone else', async () => {
    await org(['access', 'revoke', 'kasia'])
    expect(out()).toContain('@kasia no longer controls')
  })

  it('reads as self-removal when you revoke your own handle', async () => {
    await org(['access', 'revoke', '@marin'])
    expect(out()).toContain('you no longer control')
  })

  it('the only controller → last_claimant, explaining what to do instead', async () => {
    accessHandler = () =>
      jsonResponse(
        {
          error:
            'That is the only account controlling this organization. Grant access to someone else first.',
        },
        409
      )
    await expect(org(['access', 'revoke', 'marin', '--json'])).rejects.toThrow(
      '__exit__'
    )
    const error = parsed().error as { code: string; message: string }
    expect(error.code).toBe('last_claimant')
    expect(error.message).toContain('only account controlling')
  })

  it('the last_claimant hint goes to stderr, keeping stdout pure', async () => {
    accessHandler = () =>
      jsonResponse({ error: 'That is the only account…' }, 409)
    await expect(org(['access', 'revoke', 'marin'])).rejects.toThrow('__exit__')
    expect(err()).toContain('hacklab org access grant')
    expect(out()).toBe('')
  })

  it('an account that does not control the org → not_a_claimant', async () => {
    accessHandler = () =>
      jsonResponse({ error: '@kasia does not control this organization.' }, 404)
    await expect(org(['access', 'revoke', 'kasia', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('not_a_claimant')
  })

  it('distinguishes an unknown account from a non-controlling one', async () => {
    accessHandler = () =>
      jsonResponse({ error: 'No Hacklab account for @ghost.' }, 404)
    await expect(org(['access', 'revoke', 'ghost', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('no_such_account')
  })

  it('missing handle → invalid_args', async () => {
    await expect(org(['access', 'revoke', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect((parsed().error as { code: string }).code).toBe('invalid_args')
  })
})

// --- dispatch ---------------------------------------------------------------

describe('org access dispatch', () => {
  it('resolves verbs by unambiguous prefix', async () => {
    accessHandler = (_method, _url, body) =>
      jsonResponse({
        status: 'granted',
        handle: (body as { handle: string }).handle,
      })
    await org(['access', 'g', 'kasia', '--json'])
    expect(accessCall()?.[1]?.method).toBe('POST')
  })

  it('unknown verb → the access usage block', async () => {
    await expect(org(['access', 'frobnicate'])).rejects.toThrow('__exit__')
    expect(err()).toContain('usage: hacklab org access')
  })

  it('`org access` is reachable but `org a` is ambiguous with apply', async () => {
    await expect(org(['a'])).rejects.toThrow('__exit__')
    expect(err()).toContain('ambiguous')
  })
})
