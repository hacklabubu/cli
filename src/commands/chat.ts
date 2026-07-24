import readline from 'node:readline'
import { type HackerCardData, renderCompact } from '../card.js'
import { captureEvent } from '../posthog.js'
import { loadSession, resolveAppUrl, type Session } from '../session.js'
import {
  bold,
  dim,
  error,
  green,
  info,
  rankColor,
  red,
  stripControl,
  success,
} from '../ui.js'

// Re-exported for existing importers (chat.test.ts); the implementation moved
// to ui.ts so any command can strip control chars from untrusted output.
export { stripControl } from '../ui.js'

// The chat command is CLI-first: every subcommand takes --json so an AI agent
// can drive the channel and DMs programmatically, while the default output is a
// human-readable terminal view. Thin wrappers over the /api/chat/* routes.

const CHANNEL_BASE = '/api/chat/channel/main'

type ChannelMessage = {
  id: string
  content: string
  createdAt: string
  senderLevel: number | null
  senderHandle: string
  senderDisplayName: string | null
}

type DmMessage = {
  id: string
  senderId: string
  content: string
  createdAt: string
  senderHandle: string
}

type Conversation = {
  partner_handle: string
  last_message_content: string | null
  unread_count: number
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

// The session-aware backend resolver (see resolveAppUrl for the precedence).
// Kept as a thin named export so the chat call sites and tests read clearly.
export function baseUrl(session?: Session | null): string {
  return resolveAppUrl(session)
}

async function requireSession(): Promise<Session> {
  const session = await loadSession()
  if (!session) {
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }
  return session
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error ?? `request failed (${res.status})`
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i !== -1 && args[i + 1]) return args[i + 1]
  const eq = args.find((a) => a.startsWith(`${name}=`))
  return eq ? eq.slice(name.length + 1) : undefined
}

// Universal, locale-independent labels — we never want American month/day
// ordering or localized names sneaking in. Lowercase to match the terminal's
// quiet aesthetic. Indexed by Date.getDay() (0 = Sunday) / Date.getMonth().
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// A calendar-day index in *local* time: the count of days since the epoch using
// the date's local Y/M/D. Computing it via Date.UTC on the local components
// strips the time-of-day entirely, so subtracting two of these gives an exact
// whole-day difference that is immune to DST (a local "day" can be 23 or 25
// hours, but we never look at hours) and to leap years (Date.UTC normalizes
// real calendar dates). This is the basis for "today vs yesterday vs N days
// ago" — never a raw millisecond/24h subtraction.
function localDayNumber(d: Date): number {
  return Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
  )
}

// The date prefix shown before a message's HH:MM, by how many *local calendar
// days* ago it was sent (relative to `now`):
//   - today (or future/clock-skew): no prefix
//   - 1 day ago: "yest"
//   - 2–6 days ago: short weekday ("mon".."sun"). This range can never collide
//     with today's weekday or with yesterday, so the day name is unambiguous.
//   - 7+ days ago: a date. "the same weekday last week" is 7 days ago, so it
//     lands here (a date, not a weekday) — exactly the ambiguity we want to
//     avoid. This-year dates render "mmm-dd"; other years render "yyyy-mm-dd".
export function datePrefix(when: Date, now: Date): string {
  const diff = localDayNumber(now) - localDayNumber(when)
  if (diff <= 0) return ''
  if (diff === 1) return 'yest'
  if (diff <= 6) return WEEKDAYS[when.getDay()]
  if (when.getFullYear() === now.getFullYear()) {
    return `${MONTHS[when.getMonth()]}-${pad2(when.getDate())}`
  }
  return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
}

// A message timestamp: 24h local HH:MM, with a relative date prefix once the
// message is no longer from today. `now` is injectable so the live view can
// re-derive every prefix when the local day rolls over.
export function formatTimestamp(
  when: string | Date,
  now: Date = new Date()
): string {
  const d = typeof when === 'string' ? new Date(when) : when
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const prefix = datePrefix(d, now)
  return prefix ? `${prefix} ${time}` : time
}

type RenderableMessage = {
  createdAt: string
  senderHandle: string
  content: string
  senderLevel?: number | null
}

export function formatLine(
  m: RenderableMessage,
  now: Date = new Date()
): string {
  const lvl = m.senderLevel != null ? dim(` lv${m.senderLevel}`) : ''
  // Colour the author's handle in their belt/rank colour (see rankColor).
  // Strip control chars from the handle too, not just content: it's untrusted
  // (user-registered) and gets wrapped in ANSI colour codes before printing, so
  // an embedded escape sequence would otherwise hijack the viewer's terminal.
  const handle = rankColor(m.senderLevel, stripControl(m.senderHandle))
  return `${dim(formatTimestamp(m.createdAt, now))} ${handle}${lvl}: ${stripControl(m.content)}`
}

// Optimistic "sending" line: the just-typed message rendered faded with a
// status tag, shown the instant you hit enter and rewritten in place once the
// server confirms it (or it fails). Handle/time are best-effort — we don't know
// our own rank level locally, so the confirmed line from the server is what
// applies the proper belt colour. `tag` is passed pre-styled by the caller
// (dim for sending, red for failed).
export function formatPendingLine(
  handle: string,
  content: string,
  tag: string,
  at: string = new Date().toISOString(),
  now: Date = new Date()
): string {
  const ts = formatTimestamp(at, now)
  const base = `${ts} ${stripControl(handle)}: ${stripControl(content)}`
  return `${dim(base)} ${tag}`
}

// API returns newest-first; print oldest-first like a chat log.
function renderMessages(messages: RenderableMessage[]) {
  if (messages.length === 0) {
    console.log(dim('(no messages yet)'))
    return
  }
  for (const m of [...messages].reverse()) {
    console.log(formatLine(m))
  }
}

async function chatTail(json: boolean) {
  // Public endpoint — no auth required (the whole point of the cached tail), but
  // still resolve the backend the same way so --env and your logged-in env work.
  const session = await loadSession()
  const res = await fetch(`${baseUrl(session)}${CHANNEL_BASE}/tail`)
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = (await res.json()) as { messages: ChannelMessage[] }
  if (json) {
    printJson(data)
    return
  }
  renderMessages(data.messages)
}

async function chatPost(words: string[], json: boolean) {
  const content = words.join(' ').trim()
  if (!content) {
    error('usage: hacklab chat post <message>')
    process.exit(1)
  }
  const session = await requireSession()
  const res = await fetch(`${baseUrl(session)}${CHANNEL_BASE}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = await res.json()
  if (json) {
    printJson(data)
    return
  }
  success('posted.')

  await captureEvent(session.handle, 'cli_chat_message_posted', {
    content_length: content.length,
  })
}

async function chatHistory(args: string[], json: boolean) {
  const before = flagValue(args, '--before')
  const session = await requireSession()
  const url = new URL(`${baseUrl(session)}${CHANNEL_BASE}/history`)
  if (before) url.searchParams.set('before', before)
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = (await res.json()) as {
    messages: ChannelMessage[]
    nextCursor: string | null
  }
  if (json) {
    printJson(data)
    return
  }
  renderMessages(data.messages)
  if (data.nextCursor) {
    console.log(
      dim(`\nolder → hacklab chat history --before ${data.nextCursor}`)
    )
  }
}

async function chatDms(json: boolean) {
  const session = await requireSession()
  const res = await fetch(`${baseUrl(session)}/api/chat/dms`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = (await res.json()) as {
    conversations: Conversation[]
    unread: number
  }
  if (json) {
    printJson(data)
    return
  }
  if (data.conversations.length === 0) {
    console.log(dim('(no conversations yet)'))
    return
  }
  for (const c of data.conversations) {
    const unread =
      c.unread_count > 0 ? ` ${green(`(${c.unread_count} new)`)}` : ''
    // Both the partner handle and the last-message preview are untrusted user
    // input wrapped in ANSI before printing — strip control chars so a crafted
    // handle or DM body can't inject escape sequences into the viewer's terminal.
    const preview = c.last_message_content
      ? dim(` — ${stripControl(c.last_message_content)}`)
      : ''
    console.log(
      `${bold(`@${stripControl(c.partner_handle)}`)}${unread}${preview}`
    )
  }
}

async function chatDm(args: string[], json: boolean) {
  const handle = args[0]
  if (!handle) {
    error('usage: hacklab chat dm <handle> [message]')
    process.exit(1)
  }
  const message = args.slice(1).join(' ').trim()
  const session = await requireSession()
  const base = `${baseUrl(session)}/api/chat/dm/${encodeURIComponent(handle)}`

  if (message) {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ content: message }),
    })
    if (!res.ok) {
      error(await readError(res))
      process.exit(1)
    }
    const data = await res.json()
    if (json) {
      printJson(data)
      return
    }
    success(`sent to @${handle}.`)

    await captureEvent(session.handle, 'cli_dm_sent', {
      content_length: message.length,
    })
    return
  }

  const res = await fetch(base, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = (await res.json()) as { messages: DmMessage[] }
  if (json) {
    printJson(data)
    return
  }
  renderMessages(data.messages)
}

async function chatFlag(args: string[], json: boolean) {
  const targetId = args[0]
  const reason = args[1]
  if (!targetId || !reason) {
    error(
      'usage: hacklab chat flag <messageId> <off_topic|personal_attack|spam|other>'
    )
    process.exit(1)
  }
  const session = await requireSession()
  const res = await fetch(`${baseUrl(session)}/api/chat/flag`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ targetId, reason }),
  })
  if (!res.ok) {
    error(await readError(res))
    process.exit(1)
  }
  const data = await res.json()
  if (json) {
    printJson(data)
    return
  }
  success('flagged for review.')
}

export type LineIntent =
  | { kind: 'empty' }
  | { kind: 'command'; cmd: string; args: string[] }
  | { kind: 'message'; content: string }

/**
 * Decide what a typed line means. A single leading slash is a local command and
 * never posts. A DOUBLED leading slash is how you post a message that starts with
 * a slash: it posts (and displays) verbatim, both slashes intact. Nothing is
 * stripped, so the optimistic placeholder, the POST body, and the server echo all
 * agree (reconcile-by-content) — and the server can reject single-leading-slash
 * content (a stale client posting a command it doesn't know is local) without
 * catching the doubled form. Pure + exported so these semantics are unit-tested
 * without driving readline.
 */
export function parseLine(input: string): LineIntent {
  const content = input.trim()
  if (!content) return { kind: 'empty' }
  if (content.startsWith('//')) return { kind: 'message', content }
  if (content.startsWith('/')) {
    const [cmd, ...args] = content.slice(1).trim().split(/\s+/)
    return { kind: 'command', cmd: cmd ?? '', args }
  }
  return { kind: 'message', content }
}

// Interactive live channel: short-poll the public tail and print new messages
// above a readline prompt; press enter to post. CLI-first design means this is a
// thin loop over the same endpoints the agent subcommands use.
async function chatLive() {
  const session = await requireSession()
  const base = baseUrl(session)
  const seen = new Set<string>()
  let started = false
  // We learn our own handle from the first confirmed send (or the session) and
  // use it to match incoming messages back to our optimistic placeholders.
  let myHandle = session.handle
  // The local calendar day we last rendered against. When it changes (midnight,
  // or waking from sleep across midnight), every message's relative date prefix
  // may be stale, so we repaint the whole transcript.
  let dayKey = localDayNumber(new Date())

  // The full in-memory transcript, in display order (oldest first, prompt at the
  // bottom). Keeping it lets us (a) derive each line's row offset from its index
  // for in-place rewrites and (b) repaint everything with fresh date prefixes
  // when the day rolls over. A `pending` entry is an optimistic send still in
  // flight; it's replaced by a `msg` entry once the server confirms it.
  type Entry =
    | { kind: 'msg'; m: ChannelMessage }
    | { kind: 'pending'; content: string; at: string; failed?: string }
    // A local, one-row line (slash-command output: /who card rows, /help, errors).
    // Never posted, never rewritten — it's here so it counts as one log row and
    // keeps rowsUpOf's one-row-per-entry invariant true.
    | { kind: 'text'; text: string }
  const log: Entry[] = []

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: dim('> '),
  })

  function renderEntry(e: Entry, now: Date): string {
    if (e.kind === 'msg') return formatLine(e.m, now)
    if (e.kind === 'text') return e.text
    const tag = e.failed ? red(`[failed: ${e.failed}]`) : dim('[sending]')
    return formatPendingLine(myHandle ?? 'you', e.content, tag, e.at, now)
  }

  // How many terminal rows above the prompt an entry sits (1 = directly above).
  // Derived from its index in `log`: the last entry is one row up, and every
  // later line pushes earlier ones further up. Assumes one row per entry, as the
  // rest of this view does.
  function rowsUpOf(e: Entry): number {
    const i = log.indexOf(e)
    return i === -1 ? 0 : log.length - i
  }

  // Append a new entry as a line above the prompt without clobbering whatever
  // the user is mid-typing: clear the prompt line, write the entry, then redraw
  // the prompt + the in-progress input buffer.
  function appendEntry(e: Entry) {
    log.push(e)
    const inProgress = rl.line
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
    process.stdout.write(`${renderEntry(e, new Date())}\n`)
    process.stdout.write(rl.getPrompt() + inProgress)
  }

  // Append a local one-row line (slash-command output). Goes through appendEntry
  // as a `text` entry, so it counts as exactly one log row.
  function appendText(text: string) {
    appendEntry({ kind: 'text', text })
  }

  const SLASH_HELP = [
    dim('/who <handle>   look up a hacker'),
    dim('/help           this list'),
    dim(
      '//<text>        post a message that starts with a slash (shown as //)'
    ),
    dim('(dm someone with `hacklab chat dm <handle> <message>`)'),
  ]

  // Dispatch a `/command`. Runs locally, never posts. Async commands (/who)
  // append their rows when the fetch lands — the prompt was already restored by
  // the caller, so the user keeps typing while the lookup is in flight.
  async function handleSlash(cmd: string, args: string[]): Promise<void> {
    if (cmd === 'who') return whoLookup(args[0])
    if (cmd === 'help') {
      for (const line of SLASH_HELP) appendText(line)
      return
    }
    appendText(dim(`unknown command: /${stripControl(cmd)}. try /help`))
  }

  // `/who <handle>` — the compact card, appended one row per line. Prints
  // nothing while the fetch is in flight (no placeholder to rewrite).
  async function whoLookup(rawHandle: string | undefined): Promise<void> {
    const handle = rawHandle?.replace(/^@/, '')
    if (!handle) {
      appendText(dim('usage: /who <handle>'))
      return
    }
    const safe = stripControl(handle)
    try {
      const res = await fetch(
        `${base}/api/hackers/${encodeURIComponent(handle)}?src=chat`,
        { headers: { Authorization: `Bearer ${session.token}` } }
      )
      if (res.status === 404) {
        appendText(dim(`no hacker named "${safe}"`))
        return
      }
      if (!res.ok) {
        appendText(dim(`could not look up ${safe} (${res.status})`))
        return
      }
      const data = (await res.json()) as { hacker?: HackerCardData }
      if (!data.hacker) {
        appendText(dim(`no hacker named "${safe}"`))
        return
      }
      for (const line of renderCompact(data.hacker)) appendText(line)
    } catch {
      appendText(dim('could not reach hacklab'))
    }
  }

  // Rewrite an entry's existing line in place (it must still be on screen), then
  // restore the prompt + in-progress input. Used to swap an optimistic
  // placeholder for the confirmed (or failed) message with no second line.
  function rewriteEntry(e: Entry) {
    const rowsUp = rowsUpOf(e)
    if (rowsUp < 1) return
    const inProgress = rl.line
    readline.moveCursor(process.stdout, 0, -rowsUp)
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
    process.stdout.write(renderEntry(e, new Date()))
    readline.cursorTo(process.stdout, 0)
    readline.moveCursor(process.stdout, 0, rowsUp)
    readline.clearLine(process.stdout, 0)
    process.stdout.write(rl.getPrompt() + inProgress)
  }

  // Repaint the entire transcript with fresh date prefixes. Clears the screen
  // *and* scrollback (\x1b[3J) so the rolled-over timestamps don't leave a stale
  // duplicate above. Rare — at most once per local-day change.
  function repaint() {
    const now = new Date()
    const inProgress = rl.line
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H')
    for (const e of log) process.stdout.write(`${renderEntry(e, now)}\n`)
    process.stdout.write(rl.getPrompt() + inProgress)
  }

  // Render a confirmed message exactly once. If it matches one of our pending
  // optimistic sends (same author + content), swap that placeholder in place;
  // otherwise append it. Dedupes whether the message arrives via the POST
  // response or the poll, whichever wins the race.
  function commitMessage(m: ChannelMessage) {
    if (seen.has(m.id)) return
    seen.add(m.id)
    const idx = log.findIndex(
      (e) =>
        e.kind === 'pending' &&
        e.content === m.content &&
        (myHandle ? m.senderHandle === myHandle : true)
    )
    if (idx !== -1) {
      log[idx] = { kind: 'msg', m }
      rewriteEntry(log[idx])
    } else {
      appendEntry({ kind: 'msg', m })
    }
  }

  // A send failed: flip its placeholder to a red [failed] tag instead of leaving
  // it stuck on [sending]. No-op if the poll already confirmed it (the
  // placeholder object is no longer in `log`).
  function failPending(placeholder: Entry, reason: string) {
    if (placeholder.kind !== 'pending' || placeholder.failed) return
    if (!log.includes(placeholder)) return
    placeholder.failed = reason
    rewriteEntry(placeholder)
  }

  async function poll() {
    // Day-rollover check runs every tick, independent of the network, so the
    // relative prefixes advance even while the fetch is failing.
    const k = localDayNumber(new Date())
    if (started && k !== dayKey) {
      dayKey = k
      repaint()
    }
    try {
      const res = await fetch(`${base}${CHANNEL_BASE}/tail`)
      if (!res.ok) return
      const data = (await res.json()) as { messages: ChannelMessage[] }
      const ordered = [...data.messages].reverse()
      if (!started) {
        const now = new Date()
        for (const m of ordered) {
          seen.add(m.id)
          const e: Entry = { kind: 'msg', m }
          log.push(e)
          console.log(renderEntry(e, now))
        }
        started = true
        rl.prompt()
        return
      }
      for (const m of ordered) commitMessage(m)
    } catch {
      // Transient network error — keep polling silently.
    }
  }

  console.log(
    dim(
      'hacklab channel — live. type a message + enter to post, ctrl-c to quit.'
    )
  )
  await poll()
  const timer = setInterval(poll, 1500)

  rl.on('line', async (input) => {
    const intent = parseLine(input)
    if (intent.kind === 'empty') {
      rl.prompt()
      return
    }

    // Replace readline's echo of the typed line ("> message") with a faded
    // optimistic line. Without this the echo plus the confirmed message read as
    // a duplicate. clearScreenDown also handles a long line that wrapped.
    const PROMPT_WIDTH = 2 // visible width of "> "
    const cols = process.stdout.columns ?? 80
    const echoRows = Math.max(
      1,
      Math.ceil((PROMPT_WIDTH + input.length) / cols)
    )
    readline.moveCursor(process.stdout, 0, -echoRows)
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)

    // A local command never posts. Restore the prompt first, then let the
    // (possibly async) command append its rows via appendEntry — one row per
    // entry, so rowsUpOf stays correct even mid optimistic-send.
    if (intent.kind === 'command') {
      rl.prompt()
      void handleSlash(intent.cmd, intent.args)
      return
    }
    // parseLine already stripped the escaping slash from a `//` message, so the
    // placeholder and the POST body agree — the poll reconciles optimistic sends
    // by exact content match, and a mismatch sticks the placeholder on [sending].
    const postContent = intent.content

    // Faded placeholder, one row above the freshly drawn prompt. Written inline
    // (not via appendEntry) so we can hand control back with rl.prompt(), which
    // keeps readline's cursor model correct for the next keystroke.
    const placeholder: Entry = {
      kind: 'pending',
      content: postContent,
      at: new Date().toISOString(),
    }
    log.push(placeholder)
    process.stdout.write(`${renderEntry(placeholder, new Date())}\n`)
    rl.prompt()

    try {
      const res = await fetch(`${base}${CHANNEL_BASE}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ content: postContent }),
      })
      if (!res.ok) {
        failPending(placeholder, await readError(res))
        return
      }
      const data = (await res.json()) as { message?: ChannelMessage }
      const m = data.message
      if (m?.id) {
        myHandle ??= m.senderHandle
        commitMessage(m)
      } else {
        failPending(placeholder, 'no message returned')
      }
    } catch {
      failPending(placeholder, 'network error')
    }
  })

  rl.on('SIGINT', () => {
    clearInterval(timer)
    rl.close()
    process.stdout.write('\n')
    process.exit(0)
  })
}

function printChatHelp() {
  console.log(bold('hacklab chat'))
  console.log('')
  console.log(
    `  ${dim('(no args)')}             open the live channel (type to post)`
  )
  console.log(
    `  ${dim('live')}                  open the live channel (same as no args)`
  )
  console.log(
    `  ${dim('tail')}                  read the latest channel messages`
  )
  console.log(`  ${dim('post <message>')}        post to the channel`)
  console.log(`  ${dim('history [--before C]')}  older channel messages`)
  console.log(
    `  ${dim('dms')}                   list your direct-message threads`
  )
  console.log(
    `  ${dim('dm <handle> [msg]')}     read a DM thread, or send if msg given`
  )
  console.log(
    `  ${dim('flag <id> <reason>')}    report a message to moderation`
  )
  console.log('')
  console.log(
    `  ${dim('--json')}                machine-readable output (non-interactive subcommands)`
  )
}

export async function chat(args: string[]) {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')
  const sub = rest[0]
  const subArgs = rest.slice(1)

  // Explicit help only — a bare `hacklab chat` is the human entry point and
  // drops you straight into the live channel. The tail/post/history/dms/dm/flag
  // subcommands stay for scripting and agents (pair them with --json).
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printChatHelp()
    return
  }

  switch (sub) {
    case undefined:
    case 'live':
      return chatLive()
    case 'tail':
      return chatTail(json)
    case 'post':
      return chatPost(subArgs, json)
    case 'history':
      return chatHistory(subArgs, json)
    case 'dms':
      return chatDms(json)
    case 'dm':
      return chatDm(subArgs, json)
    case 'flag':
      return chatFlag(subArgs, json)
    default:
      printChatHelp()
      process.exit(1)
  }
}
