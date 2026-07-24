import { afterEach, describe, expect, it } from 'vitest'

import type { Session } from '../session.js'
import { rankColor } from '../ui.js'
import {
  baseUrl,
  datePrefix,
  formatLine,
  formatPendingLine,
  formatTimestamp,
  parseLine,
} from './chat.js'

describe('parseLine — slash / escape semantics', () => {
  it('treats a plain line as a message', () => {
    expect(parseLine('hello world')).toEqual({
      kind: 'message',
      content: 'hello world',
    })
  })

  it('treats blank input as empty', () => {
    expect(parseLine('   ')).toEqual({ kind: 'empty' })
  })

  it('parses a single-slash line as a local command', () => {
    expect(parseLine('/who isomiki')).toEqual({
      kind: 'command',
      cmd: 'who',
      args: ['isomiki'],
    })
    expect(parseLine('/help')).toEqual({
      kind: 'command',
      cmd: 'help',
      args: [],
    })
  })

  it('posts a doubled-slash line verbatim (both slashes) so it reconciles and the server allows it', () => {
    // Nothing stripped: placeholder == POST body == server echo, and the
    // server's single-slash guard (^/(?!/)) lets the doubled form through.
    expect(parseLine('//ship is broken')).toEqual({
      kind: 'message',
      content: '//ship is broken',
    })
    expect(parseLine('//who')).toEqual({ kind: 'message', content: '//who' })
  })

  it('never lets a mistyped command fall through to a post', () => {
    const intent = parseLine('/wo isomiki')
    expect(intent.kind).toBe('command') // handled locally, not broadcast
  })
})

const ORIGINAL = process.env.HACKLAB_APP_URL

afterEach(() => {
  if (ORIGINAL === undefined) {
    process.env.HACKLAB_APP_URL = undefined
    delete process.env.HACKLAB_APP_URL
  } else {
    process.env.HACKLAB_APP_URL = ORIGINAL
  }
})

const session = (appUrl: string) => ({ appUrl }) as Session

describe('baseUrl backend precedence', () => {
  it('lets an explicit --env override (HACKLAB_APP_URL) win over the session', () => {
    process.env.HACKLAB_APP_URL = 'https://app.example.com'
    expect(baseUrl(session('http://localhost:3000'))).toBe(
      'https://app.example.com'
    )
  })

  it('falls back to the logged-in session backend when there is no override', () => {
    delete process.env.HACKLAB_APP_URL
    expect(baseUrl(session('http://localhost:3000'))).toBe(
      'http://localhost:3000'
    )
  })

  it('strips a trailing slash from the override', () => {
    process.env.HACKLAB_APP_URL = 'https://app.example.com/'
    expect(baseUrl(null)).toBe('https://app.example.com')
  })
})

describe('formatLine', () => {
  const at = '2026-01-01T12:00:00Z'

  it('colours the handle in the sender rank colour', () => {
    const line = formatLine({
      createdAt: at,
      senderHandle: 'neo',
      content: 'hi',
      senderLevel: 30, // blue belt
    })
    // The handle segment is rendered via rankColor — compare against the same
    // helper so the assertion holds regardless of the test env's colour level.
    expect(line).toContain(rankColor(30, 'neo'))
    expect(line).toContain('hi')
  })

  it('falls back to a bold (uncoloured) handle when senderLevel is null', () => {
    const line = formatLine({
      createdAt: at,
      senderHandle: 'neo',
      content: 'hi',
      senderLevel: null,
    })
    expect(line).toContain(rankColor(null, 'neo'))
  })

  it('strips control characters from untrusted message content', () => {
    const line = formatLine({
      createdAt: at,
      senderHandle: 'neo',
      content: 'a\x1b[2Jb',
      senderLevel: 0,
    })
    expect(line).not.toContain('\x1b')
  })

  it('strips control characters from the untrusted handle, not just content', () => {
    // A malicious handle must not smuggle the ESC byte (\x1b) — which starts
    // every ANSI escape sequence — into the viewer's terminal. stripControl
    // drops the ESC, leaving the surrounding printable text.
    const line = formatLine({
      createdAt: at,
      senderHandle: 'ev\x1bil',
      content: 'hi',
      senderLevel: 0,
    })
    expect(line).toContain('evil')
    expect(line).not.toContain('\x1b')
  })
})

describe('formatPendingLine', () => {
  const at = '2026-01-01T12:00:00Z'

  it('renders the typed message with the status tag for the optimistic line', () => {
    const line = formatPendingLine('neo', 'hi there', '[sending]', at)
    expect(line).toContain('hi there')
    expect(line).toContain('neo')
    expect(line).toContain('[sending]')
  })

  it('strips control characters from the untrusted content and handle', () => {
    // The optimistic line echoes our own input back to the terminal, so the same
    // ANSI-injection guard formatLine uses applies here too.
    const line = formatPendingLine('ne\x1bo', 'a\x1b[2Jb', '[sending]', at)
    expect(line).not.toContain('\x1b')
  })
})

describe('datePrefix', () => {
  // Local weekday table, mirrored from chat.ts. Dates below are built with the
  // local `new Date(y, monthIndex, day, ...)` constructor and datePrefix reads
  // only local components, so these assertions hold in any machine timezone.
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  // Fixed "now": 18 June 2026, mid-afternoon, local.
  const now = new Date(2026, 5, 18, 15, 30)

  it('shows no prefix for messages from today (any time of day)', () => {
    expect(datePrefix(new Date(2026, 5, 18, 0, 1), now)).toBe('')
    expect(datePrefix(new Date(2026, 5, 18, 23, 59), now)).toBe('')
  })

  it('treats a future / clock-skewed message as today (no prefix)', () => {
    expect(datePrefix(new Date(2026, 5, 19, 0, 1), now)).toBe('')
  })

  it('says yest for yesterday regardless of time of day', () => {
    expect(datePrefix(new Date(2026, 5, 17, 23, 0), now)).toBe('yest')
    expect(datePrefix(new Date(2026, 5, 17, 0, 1), now)).toBe('yest')
  })

  it('uses the short weekday for 2-6 days ago', () => {
    for (let d = 2; d <= 6; d++) {
      const when = new Date(2026, 5, 18 - d)
      expect(datePrefix(when, now)).toBe(WD[when.getDay()])
    }
  })

  it('does NOT use a weekday for the same weekday last week (7 days ago)', () => {
    const when = new Date(2026, 5, 11) // exactly 7 days before `now`
    expect(datePrefix(when, now)).toBe('jun-11')
    expect(datePrefix(when, now)).not.toBe(WD[now.getDay()])
  })

  it('uses zero-padded mmm-dd for older dates in the current year', () => {
    expect(datePrefix(new Date(2026, 4, 15), now)).toBe('may-15')
    expect(datePrefix(new Date(2026, 4, 5), now)).toBe('may-05')
    expect(datePrefix(new Date(2026, 0, 1), now)).toBe('jan-01')
  })

  it('uses zero-padded yyyy-mm-dd for dates in a different year', () => {
    expect(datePrefix(new Date(2025, 3, 12), now)).toBe('2025-04-12')
    expect(datePrefix(new Date(2024, 11, 31), now)).toBe('2024-12-31')
  })

  it('counts calendar days correctly across a leap day', () => {
    const leapNow = new Date(2024, 2, 5, 12, 0) // 5 Mar 2024
    const feb29 = new Date(2024, 1, 29, 9, 0) // 5 calendar days earlier
    expect(datePrefix(feb29, leapNow)).toBe(WD[feb29.getDay()])
    const farNow = new Date(2024, 2, 8, 12, 0) // 8 days later → out of weekday window
    expect(datePrefix(feb29, farNow)).toBe('feb-29')
  })

  it('counts calendar days correctly across a year boundary', () => {
    const janNow = new Date(2026, 0, 2, 8, 0) // 2 Jan 2026
    const dec31 = new Date(2025, 11, 31, 20, 0) // 2 calendar days earlier
    expect(datePrefix(dec31, janNow)).toBe(WD[dec31.getDay()])
  })
})

describe('formatTimestamp', () => {
  const now = new Date(2026, 5, 18, 15, 30)

  it('is a bare 24h HH:MM for today', () => {
    expect(formatTimestamp(new Date(2026, 5, 18, 9, 5), now)).toBe('09:05')
    expect(formatTimestamp(new Date(2026, 5, 18, 23, 0), now)).toBe('23:00')
  })

  it('prefixes the relative date for older messages', () => {
    expect(formatTimestamp(new Date(2026, 5, 17, 20, 30), now)).toBe(
      'yest 20:30'
    )
    expect(formatTimestamp(new Date(2025, 3, 12, 8, 7), now)).toBe(
      '2025-04-12 08:07'
    )
  })
})
