import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: () => 'https://hacklab.so',
  unauthorizedHint: () => 'unauthorized — run hacklab login',
}))

import { org } from './org.js'
import {
  extractJobOptions,
  hasJobFlags,
  jobStatusHint,
  jobStatusLabel,
  jobsErrorHint,
  type OrgJob,
} from './org-jobs.js'

// `hacklab org jobs` — a company's listings over /api/cli/org/jobs. Same
// harness as org-access.test.ts: stdout and stderr captured separately, since
// `--json` promises exactly one JSON object on stdout and hints on stderr.

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

const JOB_ID = 'c0000000-0000-4000-8000-000000000003'

const LIVE_JOB: OrgJob = {
  id: JOB_ID,
  roleTitle: 'Staff Engineer',
  companyName: 'Acme',
  status: 'active',
  salaryRange: '$200K-$260K',
  remoteOnsite: 'remote',
  beltRankMin: 20,
  atsUrl: 'https://acme.com/careers/1',
  reviewNote: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

let exitCode: number | undefined
let stdout: string[]
let stderr: string[]
let fetchMock: ReturnType<typeof vi.fn>
let jobsHandler: (method: string, url: URL, body: unknown) => Response
/** What GET /api/cli/org answers — drives which company `org jobs` resolves. */
let orgState: unknown

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

  orgState = {
    organizations: [ACME],
    postable: [{ ...ACME, yourRole: 'admin' }],
    claimable: [],
  }
  jobsHandler = () =>
    jsonResponse({
      organization: ACME,
      yourRole: 'admin',
      jobs: [LIVE_JOB],
    })

  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const href = String(input)
    if (href.includes('/api/cli/org/jobs')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      return jobsHandler(method, new URL(href), body)
    }
    if (href.endsWith('/api/cli/org') && method === 'GET') {
      return jsonResponse(orgState)
    }
    throw new Error(`unexpected fetch: ${method} ${href}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

const out = () => stdout.join('\n')
const err = () => stderr.join('\n')
const parsed = () => JSON.parse(out()) as Record<string, unknown>
const jobsCall = () =>
  fetchMock.mock.calls.find((c) => String(c[0]).includes('/jobs'))

// --- pure helpers -----------------------------------------------------------

describe('jobStatusLabel', () => {
  it('translates the enum into what it means to whoever paid', () => {
    expect(jobStatusLabel('pending_payment', null)).toBe('unpaid')
    expect(jobStatusLabel('pending_review', null)).toBe('in review')
    expect(jobStatusLabel('active', null)).toBe('live')
    expect(jobStatusLabel('rejected', null)).toBe('rejected')
  })

  // Expiry is what makes a listing stop showing, so an aged-out `active` row
  // must not read as live — that is the whole bug expiry was added to fix.
  it('reads an aged-out active listing as expired', () => {
    expect(jobStatusLabel('active', '2020-01-01T00:00:00.000Z')).toBe('expired')
    expect(jobStatusLabel('active', '2099-01-01T00:00:00.000Z')).toBe('live')
  })
})

describe('jobStatusHint', () => {
  it('tells an unpaid listing it never finished checkout', () => {
    expect(jobStatusHint({ ...LIVE_JOB, status: 'pending_payment' })).toContain(
      'checkout'
    )
  })

  it('surfaces the reviewer’s reason on a rejection', () => {
    expect(
      jobStatusHint({
        ...LIVE_JOB,
        status: 'rejected',
        reviewNote: 'not a real role',
      })
    ).toContain('not a real role')
  })

  it('has nothing to add about a live listing', () => {
    expect(jobStatusHint(LIVE_JOB)).toBeNull()
  })
})

describe('extractJobOptions', () => {
  it('pulls known field flags out and leaves everything else', () => {
    const { options, rest } = extractJobOptions([
      '--role',
      'Staff Engineer',
      '--json',
      '--salary',
      '$200K',
    ])
    expect(options).toEqual({ role: 'Staff Engineer', salary: '$200K' })
    expect(rest).toEqual(['--json'])
  })

  it('leaves an unknown flag alone rather than eating its value', () => {
    const { options, rest } = extractJobOptions(['--nope', 'x'])
    expect(options).toEqual({})
    expect(rest).toEqual(['--nope', 'x'])
  })
})

describe('hasJobFlags', () => {
  it('separates the agent path from the interactive one', () => {
    expect(hasJobFlags(['--role', 'x'])).toBe(true)
    expect(hasJobFlags([])).toBe(false)
    expect(hasJobFlags(['--org', 'acme'])).toBe(false)
  })
})

describe('jobsErrorHint', () => {
  it('points someone with no access at the grant they need', () => {
    expect(jobsErrorHint('forbidden')).toContain('--role recruiter')
  })

  it('has nothing to add for a generic failure', () => {
    expect(jobsErrorHint('error')).toBeNull()
  })
})

// --- list -------------------------------------------------------------------

describe('org jobs list', () => {
  it('is what bare `org jobs` does', async () => {
    await org(['jobs'])
    expect(jobsCall()?.[1]?.method ?? 'GET').toBe('GET')
    expect(out()).toContain('Staff Engineer')
    expect(out()).toContain('live')
  })

  it('scopes the request to the resolved company', async () => {
    await org(['jobs', 'list', '--json'])
    expect(String(jobsCall()?.[0])).toContain('orgSlug=acme')
    expect(parsed().jobs).toHaveLength(1)
  })

  // A recruiter has no editable org at all, so resolving against the editable
  // set would leave them unable to reach the one thing their role is for.
  it('resolves a company where the caller is only a recruiter', async () => {
    orgState = {
      organizations: [],
      postable: [{ ...BETA, yourRole: 'recruiter' }],
      claimable: [],
    }
    jobsHandler = () =>
      jsonResponse({ organization: BETA, yourRole: 'recruiter', jobs: [] })

    await org(['jobs', 'list', '--json'])
    expect(String(jobsCall()?.[0])).toContain('orgSlug=beta')
  })

  it('names the company with --org when several are postable', async () => {
    orgState = {
      organizations: [ACME, BETA],
      postable: [
        { ...ACME, yourRole: 'admin' },
        { ...BETA, yourRole: 'recruiter' },
      ],
      claimable: [],
    }
    await org(['jobs', '--org', 'beta', 'list', '--json'])
    expect(String(jobsCall()?.[0])).toContain('orgSlug=beta')
  })

  it('refuses without --org when several are postable', async () => {
    orgState = {
      organizations: [ACME, BETA],
      postable: [
        { ...ACME, yourRole: 'admin' },
        { ...BETA, yourRole: 'recruiter' },
      ],
      claimable: [],
    }
    await expect(org(['jobs', 'list', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('ambiguous_org')
    expect(jobsCall()).toBeUndefined()
  })
})

// --- post -------------------------------------------------------------------

describe('org jobs post', () => {
  beforeEach(() => {
    jobsHandler = () =>
      jsonResponse({
        job: { ...LIVE_JOB, status: 'pending_payment' },
        checkoutUrl: 'https://checkout.stripe.com/x',
      })
  })

  const FLAGS = [
    '--role',
    'Staff Engineer',
    '--description',
    'Build things.',
    '--apply-url',
    'acme.com/careers/1',
    '--contact',
    'hiring@acme.com',
  ]

  it('posts the fields and hands back a checkout url', async () => {
    await org(['jobs', 'post', ...FLAGS, '--json'])
    const call = jobsCall()
    expect(call?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      orgSlug: 'acme',
      fields: {
        roleTitle: 'Staff Engineer',
        description: 'Build things.',
        // A bare host gets https:// so the server's URL check passes.
        atsUrl: 'https://acme.com/careers/1',
        contactEmail: 'hiring@acme.com',
        companyName: 'Acme',
      },
    })
    expect(parsed().checkoutUrl).toBe('https://checkout.stripe.com/x')
  })

  it('refuses locally when a required field is missing, without a request', async () => {
    await expect(
      org(['jobs', 'post', '--role', 'Staff Engineer', '--json'])
    ).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('invalid_fields')
    expect(jobsCall()).toBeUndefined()
  })

  it('rejects a work style that is not one of the three', async () => {
    await expect(
      org(['jobs', 'post', ...FLAGS, '--work-style', 'lunar', '--json'])
    ).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).message).toContain('work-style')
    expect(jobsCall()).toBeUndefined()
  })

  it('relays a server refusal with its code, hinting on stderr only', async () => {
    jobsHandler = () =>
      jsonResponse(
        {
          error: 'You do not have permission to post jobs for Acme.',
          code: 'forbidden',
        },
        403
      )
    await expect(org(['jobs', 'post', ...FLAGS])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(err()).toContain('--role recruiter')
    expect(out()).toBe('')
  })
})

// --- close ------------------------------------------------------------------

describe('org jobs close', () => {
  it('deletes by id, scoped to the company', async () => {
    jobsHandler = () => jsonResponse({ job: { ...LIVE_JOB, status: 'closed' } })
    await org(['jobs', 'close', JOB_ID, '--json'])
    const call = jobsCall()
    expect(call?.[1]?.method).toBe('DELETE')
    expect(String(call?.[0])).toContain(`jobId=${JOB_ID}`)
    expect(String(call?.[0])).toContain('orgSlug=acme')
  })

  it('needs an id', async () => {
    await expect(org(['jobs', 'close', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('invalid_args')
  })

  it('explains that only live listings close', async () => {
    jobsHandler = () =>
      jsonResponse(
        {
          error: 'No live listing with that id on this company.',
          code: 'not_closable',
        },
        404
      )
    await expect(org(['jobs', 'close', JOB_ID])).rejects.toThrow('__exit__')
    expect(err()).toContain('only live listings')
  })
})
