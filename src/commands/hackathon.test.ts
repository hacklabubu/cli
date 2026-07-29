import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))
vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
  unauthorizedHint: () =>
    'unauthorized — your session may have expired. run `hacklab login` to sign in again.',
}))
vi.mock('../sync.js', () => ({ fetchApi: vi.fn() }))

import { hackathon } from './hackathon.js'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

const SESSION = { token: 't', appUrl: 'https://hacklab.so', handle: 'ada' }

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
  vi.spyOn(process.stdout, 'write').mockImplementation(((m: unknown) => {
    out.push(String(m))
    return true
  }) as never)
  vi.mocked(loadSession).mockResolvedValue(SESSION as never)
})

const output = () => out.join('\n')

describe('hackathon dispatch', () => {
  it('bare hackathon lists events', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, hackathons: [] })
    )
    await hackathon([])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons',
      expect.anything()
    )
  })

  it('exits 1 on an unknown subcommand', async () => {
    await expect(hackathon(['frobnicate'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('unknown subcommand')
  })

  it('exits 1 on an ambiguous subcommand ("t" -> team | track)', async () => {
    await expect(hackathon(['t'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('ambiguous')
  })

  it('resolves the "v" prefix to "view"', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathon: { slug: 'summer', title: 'Summer Jam' },
      })
    )
    await hackathon(['v', 'summer'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer',
      expect.anything()
    )
  })
})

describe('hackathon list', () => {
  it('prints hackathons as JSON', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathons: [
          { slug: 'summer', title: 'Summer Jam', phase: 'rsvp_open' },
        ],
      })
    )
    await hackathon(['list', '--json'])
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      hackathons: [{ slug: 'summer', title: 'Summer Jam', phase: 'rsvp_open' }],
    })
  })

  it('requests the past view with --past', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, hackathons: [] })
    )
    await hackathon(['list', '--past'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons?view=past',
      expect.anything()
    )
  })

  it('prints slug, title, dates, and phase for humans', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathons: [
          {
            slug: 'summer',
            title: 'Summer Jam',
            phase: 'rsvp_open',
            startsAt: '2026-08-01T00:00:00.000Z',
            endsAt: '2026-08-03T00:00:00.000Z',
          },
        ],
      })
    )
    await hackathon(['list'])
    expect(output()).toContain('summer')
    expect(output()).toContain('Summer Jam')
    expect(output()).toContain('rsvp_open')
  })

  it('prints a friendly empty message with no results', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, hackathons: [] })
    )
    await hackathon(['list'])
    expect(output()).toContain('no upcoming hackathons')
  })

  it('not logged in -> --json unauthorized envelope, exit 1', async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(hackathon(['list', '--json'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'unauthorized', message: 'not logged in' },
    })
  })

  it('network failure -> friendly message, exit 1', async () => {
    vi.mocked(fetchApi).mockRejectedValue(new Error("couldn't reach hacklab"))
    await expect(hackathon(['list'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain("couldn't reach hacklab")
  })
})

describe('hackathon view', () => {
  it('requires a slug', async () => {
    await expect(hackathon(['view'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab hackathon view <slug>')
  })

  it('highlights the next upcoming deadline', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathon: {
          slug: 'summer',
          title: 'Summer Jam',
          phase: 'teams_open',
          rsvpClosesAt: past,
          teamsLockAt: future,
          tracksLockAt: null,
          submissionsDueAt: null,
        },
      })
    )
    await hackathon(['view', 'summer'])
    expect(output()).toContain('RSVP closes')
    expect(output()).toContain('teams lock')
    expect(output()).toContain('← next')
  })

  it('--json relays the server envelope verbatim', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathon: { slug: 'summer', title: 'Summer Jam' },
      })
    )
    await hackathon(['view', 'summer', '--json'])
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      hackathon: { slug: 'summer', title: 'Summer Jam' },
    })
  })

  it('404 relays the server error envelope in --json', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        { schemaVersion: 1, error: { code: 'not_found', message: 'nope' } },
        404
      )
    )
    await expect(hackathon(['view', 'ghost', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'not_found', message: 'nope' },
    })
  })

  it('open mode: says there is no theme or tracks', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathon: {
          slug: 'summer',
          title: 'Summer Jam',
          challengeMode: 'open',
          challengeVisible: true,
        },
      })
    )
    await hackathon(['view', 'summer'])
    expect(output()).toContain('no theme or tracks')
    // open mode never needs the tracks endpoint.
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })

  it('hidden before reveal: says it is announced when the hackathon starts, not empty', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        hackathon: {
          slug: 'summer',
          title: 'Summer Jam',
          challengeMode: 'tracks',
          challengeVisible: false,
        },
      })
    )
    await hackathon(['view', 'summer'])
    expect(output()).toContain('Tracks')
    expect(output()).toContain('announced when the hackathon starts')
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })

  it('visible theme: labels it Theme and lists it', async () => {
    vi.mocked(fetchApi).mockImplementation((_session, path) => {
      if (path === '/api/hackathons/summer') {
        return Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            hackathon: {
              slug: 'summer',
              title: 'Summer Jam',
              challengeMode: 'theme',
              challengeVisible: true,
            },
          })
        )
      }
      return Promise.resolve(
        jsonResponse({
          schemaVersion: 1,
          challengeMode: 'theme',
          challengeVisible: true,
          tracks: [{ slug: 'ai-for-good', name: 'AI for good' }],
        })
      )
    })
    await hackathon(['view', 'summer'])
    expect(output()).toContain('Theme')
    expect(output()).toContain('AI for good')
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/tracks',
      expect.anything()
    )
  })

  it('visible tracks: labels it Tracks and lists every entry', async () => {
    vi.mocked(fetchApi).mockImplementation((_session, path) => {
      if (path === '/api/hackathons/summer') {
        return Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            hackathon: {
              slug: 'summer',
              title: 'Summer Jam',
              challengeMode: 'tracks',
              challengeVisible: true,
            },
          })
        )
      }
      return Promise.resolve(
        jsonResponse({
          schemaVersion: 1,
          challengeMode: 'tracks',
          challengeVisible: true,
          tracks: [
            { slug: 'ai', name: 'AI' },
            { slug: 'climate', name: 'Climate' },
          ],
        })
      )
    })
    await hackathon(['view', 'summer'])
    expect(output()).toContain('Tracks')
    expect(output()).toContain('AI')
    expect(output()).toContain('Climate')
  })
})

describe('hackathon rsvp', () => {
  it('requires a slug', async () => {
    await expect(hackathon(['rsvp'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab hackathon rsvp')
  })

  it('sends --token in the body', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, rsvped: true })
    )
    await hackathon(['rsvp', 'summer', '--token', 'abc123'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/rsvp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'abc123' }),
      })
    )
  })

  it('succeeds with a plain human message', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, rsvped: true })
    )
    await hackathon(['rsvp', 'summer'])
    expect(output()).toContain('RSVPed to summer')
  })

  it('not_invited: prints the server message verbatim plus a hint', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        {
          schemaVersion: 1,
          error: {
            code: 'not_invited',
            message: 'ada@example.com is not on the invite list for summer',
          },
        },
        403
      )
    )
    await expect(hackathon(['rsvp', 'summer'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain(
      'ada@example.com is not on the invite list for summer'
    )
    expect(output()).toContain('ask the organizer to add this address')
  })

  // A link is not a credential: holding one buys nothing if the address on the
  // account is not the invited one. This is the forwarded-link case.
  it('email_mismatch: relays the refusal and points at the organizer', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        {
          schemaVersion: 1,
          error: {
            code: 'email_mismatch',
            message:
              'This invite was sent to a different email address than the one on your account.',
          },
        },
        403
      )
    )
    await expect(
      hackathon(['rsvp', 'summer', '--token', 'forwarded-token'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('different email address')
    expect(output()).toContain('ask the organizer to add that address')
  })

  it('not_invited in --json mode relays the envelope verbatim (no extra hint text)', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        {
          schemaVersion: 1,
          error: { code: 'not_invited', message: 'nope, not invited' },
        },
        403
      )
    )
    await expect(hackathon(['rsvp', 'summer', '--json'])).rejects.toThrow(
      '__exit__'
    )
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'not_invited', message: 'nope, not invited' },
    })
  })
})

describe('hackathon invite', () => {
  it('requires --file or --emails', async () => {
    await expect(hackathon(['invite', 'summer'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('--file')
  })

  it('rejects passing both --file and --emails', async () => {
    await expect(
      hackathon(['invite', 'summer', '--file', 'a.txt', '--emails', 'a@b.com'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('use either --file or --emails')
  })

  it('reads --file and posts its contents as text', async () => {
    fsMocks.readFile.mockResolvedValue('a@b.com\nc@d.com\n')
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, invited: 2, skipped: 0, rejected: [] })
    )
    await hackathon(['invite', 'summer', '--file', 'invites.txt'])
    expect(fsMocks.readFile).toHaveBeenCalledWith('invites.txt', 'utf8')
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/invites',
      expect.objectContaining({
        body: JSON.stringify({ text: 'a@b.com\nc@d.com\n' }),
      })
    )
  })

  it('splits --emails on commas', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, invited: 2, skipped: 0, rejected: [] })
    )
    await hackathon(['invite', 'summer', '--emails', 'a@b.com,c@d.com'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/invites',
      expect.objectContaining({
        body: JSON.stringify({ emails: ['a@b.com', 'c@d.com'] }),
      })
    )
  })

  it('lists every rejected line, never hiding them', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        invited: 1,
        skipped: 2,
        rejected: ['not-an-email', 'also bad'],
      })
    )
    await hackathon(['invite', 'summer', '--emails', 'a@b.com'])
    expect(output()).toContain('not-an-email')
    expect(output()).toContain('also bad')
    expect(output()).toContain('rejected 2')
  })
})

describe('hackathon team', () => {
  it('team create requires --name', async () => {
    await expect(hackathon(['team', 'create', 'summer'])).rejects.toThrow(
      '__exit__'
    )
    expect(output()).toContain('--name')
  })

  it('team create posts name/summary/max/closed', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, team: { slug: 'rocket' } })
    )
    await hackathon([
      'team',
      'create',
      'summer',
      '--name',
      'Rocket',
      '--summary',
      'we build fast',
      '--max',
      '4',
      '--closed',
    ])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'Rocket',
          summary: 'we build fast',
          maxSize: 4,
          closed: true,
        }),
      })
    )
  })

  it('team join posts a request action', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, requested: true })
    )
    await hackathon(['team', 'join', 'summer', 'rocket'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams/rocket/requests',
      expect.objectContaining({
        body: JSON.stringify({ action: 'request' }),
      })
    )
  })

  it('team accept posts the applicant handle', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, accepted: true })
    )
    await hackathon(['team', 'accept', 'summer', 'rocket', 'isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams/rocket/requests',
      expect.objectContaining({
        body: JSON.stringify({ action: 'accept', applicantHandle: 'isomiki' }),
      })
    )
  })

  it('team reject posts the applicant handle', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, rejected: true })
    )
    await hackathon(['team', 'reject', 'summer', 'rocket', 'isomiki'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams/rocket/requests',
      expect.objectContaining({
        body: JSON.stringify({ action: 'reject', applicantHandle: 'isomiki' }),
      })
    )
  })

  it('team list fetches the teams for a slug', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        teams: [{ slug: 'rocket', name: 'Rocket', closed: false }],
      })
    )
    await hackathon(['team', 'list', 'summer'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams',
      expect.anything()
    )
    expect(output()).toContain('Rocket')
  })

  it('unknown team subcommand exits 1', async () => {
    await expect(hackathon(['team', 'frobnicate', 'summer'])).rejects.toThrow(
      '__exit__'
    )
    expect(exitCode).toBe(1)
  })
})

describe('hackathon track', () => {
  it('requires slug, teamSlug, and trackSlug', async () => {
    await expect(hackathon(['track', 'summer'])).rejects.toThrow('__exit__')
    expect(output()).toContain(
      'usage: hacklab hackathon track <slug> <teamSlug> <trackSlug>'
    )
  })

  it('posts the trackSlug', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, track: 'ai' })
    )
    await hackathon(['track', 'summer', 'rocket', 'ai'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams/rocket/track',
      expect.objectContaining({
        body: JSON.stringify({ trackSlug: 'ai' }),
      })
    )
  })

  it('track_locked: hints that this hackathon has no tracks (mode is not "tracks")', async () => {
    vi.mocked(fetchApi).mockImplementation((_session, path) => {
      if (path === '/api/hackathons/summer/teams/rocket/track') {
        return Promise.resolve(
          jsonResponse(
            {
              schemaVersion: 1,
              error: { code: 'track_locked', message: 'tracks are locked' },
            },
            409
          )
        )
      }
      return Promise.resolve(
        jsonResponse({
          schemaVersion: 1,
          hackathon: {
            slug: 'summer',
            title: 'Summer Jam',
            challengeMode: 'open',
            challengeVisible: true,
          },
        })
      )
    })
    await expect(
      hackathon(['track', 'summer', 'rocket', 'ai'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('tracks are locked')
    expect(output()).toContain('there are no tracks to pick')
  })

  it('track_locked: hints that tracks are not revealed yet (mode is "tracks" but hidden)', async () => {
    vi.mocked(fetchApi).mockImplementation((_session, path) => {
      if (path === '/api/hackathons/summer/teams/rocket/track') {
        return Promise.resolve(
          jsonResponse(
            {
              schemaVersion: 1,
              error: { code: 'track_locked', message: 'tracks are locked' },
            },
            409
          )
        )
      }
      return Promise.resolve(
        jsonResponse({
          schemaVersion: 1,
          hackathon: {
            slug: 'summer',
            title: 'Summer Jam',
            challengeMode: 'tracks',
            challengeVisible: false,
          },
        })
      )
    })
    await expect(
      hackathon(['track', 'summer', 'rocket', 'ai'])
    ).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('tracks are locked')
    expect(output()).toContain('not been revealed yet')
  })

  it('track_locked in --json mode relays the envelope verbatim (no extra hint text)', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse(
        {
          schemaVersion: 1,
          error: { code: 'track_locked', message: 'tracks are locked' },
        },
        409
      )
    )
    await expect(
      hackathon(['track', 'summer', 'rocket', 'ai', '--json'])
    ).rejects.toThrow('__exit__')
    expect(JSON.parse(output())).toEqual({
      schemaVersion: 1,
      error: { code: 'track_locked', message: 'tracks are locked' },
    })
  })
})

describe('hackathon tracks', () => {
  it('requires a slug', async () => {
    await expect(hackathon(['tracks'])).rejects.toThrow('__exit__')
    expect(exitCode).toBe(1)
    expect(output()).toContain('usage: hacklab hackathon tracks <slug>')
  })

  it('open mode: says there is no theme or tracks', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        challengeMode: 'open',
        challengeVisible: true,
        tracks: [],
      })
    )
    await hackathon(['tracks', 'summer'])
    expect(output()).toContain('no theme or tracks')
  })

  it('hidden before reveal: says it is announced when the hackathon starts', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        challengeMode: 'tracks',
        challengeVisible: false,
        tracks: [],
      })
    )
    await hackathon(['tracks', 'summer'])
    expect(output()).toContain('announced when the hackathon starts')
  })

  it('visible theme: labels it Theme and lists it', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        challengeMode: 'theme',
        challengeVisible: true,
        tracks: [{ slug: 'ai-for-good', name: 'AI for good' }],
      })
    )
    await hackathon(['tracks', 'summer'])
    expect(output()).toContain('Theme')
    expect(output()).toContain('AI for good')
  })

  it('visible tracks: labels it Tracks and lists every entry, and supports --json', async () => {
    const body = {
      schemaVersion: 1,
      challengeMode: 'tracks',
      challengeVisible: true,
      tracks: [
        { slug: 'ai', name: 'AI' },
        { slug: 'climate', name: 'Climate' },
      ],
    }
    vi.mocked(fetchApi).mockResolvedValue(jsonResponse(body))
    await hackathon(['tracks', 'summer', '--json'])
    expect(JSON.parse(output())).toEqual(body)
  })
})

describe('hackathon submit', () => {
  it('requires --title and --description', async () => {
    await expect(hackathon(['submit', 'summer', 'rocket'])).rejects.toThrow(
      '__exit__'
    )
    expect(output()).toContain('--title')
  })

  it('posts the submission fields', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      jsonResponse({ schemaVersion: 1, submitted: true })
    )
    await hackathon([
      'submit',
      'summer',
      'rocket',
      '--title',
      'Rocket App',
      '--description',
      'it flies',
      '--repo',
      'https://github.com/x/rocket',
      '--track',
      'ai',
    ])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/teams/rocket/submission',
      expect.objectContaining({
        body: JSON.stringify({
          title: 'Rocket App',
          description: 'it flies',
          repoUrl: 'https://github.com/x/rocket',
          videoUrl: undefined,
          siteUrl: undefined,
          trackSlug: 'ai',
        }),
      })
    )
  })
})

describe('hackathon export', () => {
  it('defaults to csv and streams to stdout with no --out', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'handle,email\nada,ada@example.com\n',
    } as never)
    await hackathon(['export', 'summer'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/export?format=csv',
      expect.anything()
    )
    expect(output()).toContain('handle,email')
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it('writes to --out and prints a personal-data notice', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'handle,email\nada,ada@example.com\n',
    } as never)
    await hackathon(['export', 'summer', '--out', 'participants.csv'])
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      'participants.csv',
      'handle,email\nada,ada@example.com\n',
      'utf8'
    )
    expect(output()).toContain('personal data')
    expect(output()).toContain('wrote csv export to participants.csv')
  })

  it('--json without --out defaults format to json', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '[]',
    } as never)
    await hackathon(['export', 'summer', '--json'])
    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/hackathons/summer/export?format=json',
      expect.anything()
    )
  })

  it('rejects an invalid --format', async () => {
    await expect(
      hackathon(['export', 'summer', '--format', 'xml'])
    ).rejects.toThrow('__exit__')
    expect(output()).toContain('--format must be csv or json')
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
