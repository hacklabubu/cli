import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: () => 'https://hacklab.so',
  unauthorizedHint: () => 'unauthorized — run hacklab login',
}))

import { jobMeta, jobs } from './jobs.js'

// `hacklab jobs` — the public shop, read-only, over /api/jobshop.

const JOB_ID = 'c0000000-0000-4000-8000-000000000003'

const JOB = {
  id: JOB_ID,
  roleTitle: 'Staff Engineer',
  companyName: 'Acme',
  companyUrl: null,
  description: 'Build things.\nWith people.',
  salaryRange: '$200K-$260K',
  remoteOnsite: 'remote',
  beltRankMin: 20,
  atsUrl: 'https://acme.com/careers/1',
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

let exitCode: number | undefined
let stdout: string[]
let stderr: string[]
let fetchMock: ReturnType<typeof vi.fn>
let handler: (url: URL) => Response

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

  handler = (url) =>
    url.pathname === `/api/jobshop/${JOB_ID}`
      ? jsonResponse({ job: JOB })
      : jsonResponse({ jobs: [JOB] })

  fetchMock = vi.fn(async (input: string | URL) =>
    handler(new URL(String(input)))
  )
  vi.stubGlobal('fetch', fetchMock)
})

const out = () => stdout.join('\n')
const parsed = () => JSON.parse(out()) as Record<string, unknown>
const url = () => new URL(String(fetchMock.mock.calls[0]?.[0]))

describe('jobMeta', () => {
  it('joins what a role offers, skipping what it does not say', () => {
    expect(jobMeta(JOB)).toBe('remote · $200K-$260K · lv.20+')
    expect(
      jobMeta({ ...JOB, remoteOnsite: null, salaryRange: null, beltRankMin: 0 })
    ).toBe('—')
  })
})

describe('hacklab jobs list', () => {
  it('is what the bare command does', async () => {
    await jobs([])
    expect(url().pathname).toBe('/api/jobshop')
    expect(out()).toContain('Staff Engineer')
    expect(out()).toContain('Acme')
  })

  it('passes --limit through', async () => {
    await jobs(['list', '--limit', '5', '--json'])
    expect(url().searchParams.get('limit')).toBe('5')
    expect(parsed().jobs).toHaveLength(1)
  })

  it('rejects a limit outside 1-100 without a request', async () => {
    await expect(jobs(['list', '--limit', '500', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so plainly when the shop is empty', async () => {
    handler = () => jsonResponse({ jobs: [] })
    await jobs([])
    expect(out()).toContain('nothing on the shop')
  })
})

describe('hacklab jobs view', () => {
  it('fetches one listing by id and prints its description', async () => {
    await jobs(['view', JOB_ID])
    expect(url().pathname).toBe(`/api/jobshop/${JOB_ID}`)
    expect(out()).toContain('Build things.')
    expect(out()).toContain('https://acme.com/careers/1')
  })

  it('needs an id', async () => {
    await expect(jobs(['view', '--json'])).rejects.toThrow('__exit__')
    expect((parsed().error as { code: string }).code).toBe('invalid_args')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A listing that is pending, rejected or expired is a 404 to the public, so
  // the CLI must report "no such listing" rather than leaking that it exists.
  it('reports a 404 as not_found', async () => {
    handler = () => jsonResponse({ error: 'Job not found.' }, 404)
    await expect(jobs(['view', JOB_ID, '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect((parsed().error as { code: string }).code).toBe('not_found')
  })
})

describe('hacklab jobs dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    await expect(jobs(['nope'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
  })

  it('resolves a unique prefix', async () => {
    await jobs(['v', JOB_ID, '--json'])
    expect(url().pathname).toBe(`/api/jobshop/${JOB_ID}`)
  })
})
