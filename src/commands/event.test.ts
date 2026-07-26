import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSession } from '../session.js'
import { fetchApi } from '../sync.js'

vi.mock('../session.js', () => ({
  loadSession: vi.fn(),
  resolveAppUrl: (session: { appUrl: string }) => session.appUrl,
  unauthorizedHint: () => 'unauthorized — run `hacklab login`.',
}))
vi.mock('../sync.js', () => ({ fetchApi: vi.fn() }))
vi.mock('../posthog.js', () => ({
  captureEvent: vi.fn().mockResolvedValue(undefined),
}))

import { event, eventSlugFromTitle, parseEventAddArgs } from './event.js'

const ARGS = [
  'add',
  '--title',
  'Warsaw AI Hackathon',
  '--start',
  '2026-09-12T09:00:00+02:00',
  '--end',
  '2026-09-13T18:00:00+02:00',
  '--timezone',
  'Europe/Warsaw',
]

function jsonResponse(body: unknown, status = 201): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response
}

function postedBody() {
  const init = vi.mocked(fetchApi).mock.calls[0]?.[2] as RequestInit
  return JSON.parse(init.body as string)
}

let output: string[]

beforeEach(() => {
  vi.clearAllMocks()
  output = []
  vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    output.push(String(value))
  })
  vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
    output.push(String(value))
  })
  vi.mocked(loadSession).mockResolvedValue({
    token: 'token',
    appUrl: 'https://hacklab.so',
    handle: 'bratos',
  } as never)
  vi.mocked(fetchApi).mockResolvedValue(
    jsonResponse({
      schemaVersion: 1,
      created: true,
      event: {
        slug: 'warsaw-ai-hackathon',
        title: 'Warsaw AI Hackathon',
        path: '/events/warsaw-ai-hackathon',
      },
    })
  )
})

describe('parseEventAddArgs', () => {
  it('normalizes dates and derives the slug', () => {
    const parsed = parseEventAddArgs(ARGS.slice(1))
    expect(parsed.slug).toBe('warsaw-ai-hackathon')
    expect(parsed.startsAt).toBe('2026-09-12T07:00:00.000Z')
    expect(parsed.endsAt).toBe('2026-09-13T16:00:00.000Z')
  })

  it('normalizes accented titles into URL-safe slugs', () => {
    expect(eventSlugFromTitle('Łódź AI Jam')).toBe('lodz-ai-jam')
  })

  it('rejects invalid ranges and timezones', () => {
    const invalidRange = ARGS.slice(1)
    invalidRange[invalidRange.indexOf('--end') + 1] =
      '2026-09-11T18:00:00+02:00'
    expect(() => parseEventAddArgs(invalidRange)).toThrow('--end must be after')

    const invalidTimezone = ARGS.slice(1)
    invalidTimezone[invalidTimezone.indexOf('--timezone') + 1] = 'Warsaw-ish'
    expect(() => parseEventAddArgs(invalidTimezone)).toThrow('IANA timezone')
  })
})

describe('event add', () => {
  it('posts a personal event to the authenticated API', async () => {
    await event(ARGS)

    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/events',
      expect.objectContaining({ method: 'POST' })
    )
    expect(postedBody()).toMatchObject({
      slug: 'warsaw-ai-hackathon',
      timezone: 'Europe/Warsaw',
    })
    expect(postedBody()).not.toHaveProperty('organizerOrgSlug')
  })

  it('passes an organization slug and emits structured JSON', async () => {
    await event([
      ...ARGS,
      '--org',
      'hacklab',
      '--image',
      'https://images.example.com/hackathon.webp',
      '--json',
    ])

    expect(postedBody().organizerOrgSlug).toBe('hacklab')
    expect(postedBody().imageUrl).toBe(
      'https://images.example.com/hackathon.webp'
    )
    const body = JSON.parse(output.join('\n'))
    expect(body.schemaVersion).toBe(1)
    expect(body.event.path).toBe('/events/warsaw-ai-hackathon')
  })
})

describe('event participation and teams', () => {
  it('marks the authenticated hacker as looking for a team', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(
      jsonResponse({
        schemaVersion: 1,
        participation: { teamPreference: 'looking' },
      })
    )

    await event([
      'going',
      'hacklab-saturday-hackathon',
      '--status',
      'looking',
      '--json',
    ])

    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/events/hacklab-saturday-hackathon/participants',
      expect.objectContaining({ method: 'POST' })
    )
    expect(postedBody()).toEqual({ teamPreference: 'looking' })
  })

  it('lists teams as structured JSON', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(
      jsonResponse({
        schemaVersion: 1,
        teams: [
          {
            slug: 'terminal-goblins',
            name: 'Terminal Goblins',
            memberCount: 2,
            maxMembers: 4,
            availability: 'open',
          },
        ],
      })
    )

    await event(['teams', 'hacklab-saturday-hackathon', '--json'])

    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/events/hacklab-saturday-hackathon/teams',
      expect.anything()
    )
    expect(JSON.parse(output.join('\n')).teams[0].slug).toBe('terminal-goblins')
  })

  it('creates a team with agent-friendly flags', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(
      jsonResponse(
        {
          schemaVersion: 1,
          created: true,
          team: {
            name: 'Terminal Goblins',
            slug: 'terminal-goblins',
            path: '/events/hacklab-saturday-hackathon/teams/terminal-goblins',
          },
        },
        201
      )
    )

    await event([
      'team',
      'create',
      'hacklab-saturday-hackathon',
      '--name',
      'Terminal Goblins',
      '--summary',
      'We ship agents.',
      '--max-members',
      '5',
      '--json',
    ])

    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/events/hacklab-saturday-hackathon/teams',
      expect.objectContaining({ method: 'POST' })
    )
    expect(postedBody()).toMatchObject({
      name: 'Terminal Goblins',
      summary: 'We ship agents.',
      maxMembers: 5,
      recruitingStatus: 'open',
    })
  })

  it('sends captain decisions to the request endpoint', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(
      jsonResponse({ schemaVersion: 1, status: 'accepted' })
    )

    await event([
      'team',
      'accept',
      'hacklab-saturday-hackathon',
      'terminal-goblins',
      'adareyes',
      '--json',
    ])

    expect(fetchApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/events/hacklab-saturday-hackathon/teams/terminal-goblins/requests',
      expect.objectContaining({ method: 'POST' })
    )
    expect(postedBody()).toEqual({
      action: 'accept',
      applicantHandle: 'adareyes',
    })
  })
})
