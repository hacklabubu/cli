import { loadSession, resolveAppUrl, unauthorizedHint } from '../session.js'
import {
  dim,
  displayWidth,
  error,
  info,
  mint,
  padEndTo,
  stripControl,
  success,
} from '../ui.js'

// `hacklab ping` — one round-trip to the backend. Without a saved session it
// only answers "is the server reachable". With one, it sends the session token
// so the server can record that *this* user's CLI checked in — the signal the
// app uses to show "your agent is setting up your profile" the moment an agent
// starts working, instead of making the user wait for full setup. The session
// token is the proof of identity: it's the per-user secret minted at login, so
// a ping can't be forged from just someone's username.
//
// Server contract (POST /api/cli/ping):
//   - no Authorization header → 2xx, nothing recorded (pure reachability).
//   - `Authorization: Bearer <token>` → 2xx and the ping is recorded for that
//     user; 401 when the token doesn't verify.

const PING_TIMEOUT_MS = 8000

export async function ping(): Promise<void> {
  const session = await loadSession()
  const server = resolveAppUrl(session)

  let res: Response
  const started = performance.now()
  try {
    res = await fetch(`${server}/api/cli/ping`, {
      method: 'POST',
      headers: session
        ? { Authorization: `Bearer ${session.token}` }
        : undefined,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
  } catch {
    error(`could not reach ${server}`)
    process.exit(1)
  }
  const ms = Math.round(performance.now() - started)

  // Any HTTP response proves the server is up; the status only matters for
  // whether the authenticated ping was recorded.
  success(`server reached — ${server} ${dim(`(${ms}ms)`)}`)

  if (!session) return

  if (res.ok) {
    info(`authenticated as ${session.handle ?? session.email} — ping recorded`)
    printHandoffBox()
  } else if (res.status === 401) {
    info(unauthorizedHint(session))
  } else {
    info(`server error (${res.status}) — ping not recorded`)
  }
}

/**
 * A recorded ping means an agent has just started profile setup, and `hacklab
 * ping` is step 1 of `hacklab rtfm profile-setup` — so this is the earliest
 * deterministic moment we can tell the user they are free to go.
 *
 * DESIGN.md forbids boxed notes, and this is the recorded exception to that
 * rule: the reader here is a human skimming an *agent's* transcript, where our
 * output is one more block of tool noise between file reads and command
 * outputs. A line would be scrolled past. The box exists to be seen, and only
 * ever prints on the authenticated ping — never on the anonymous reachability
 * probe, and never on an error path.
 */
const HANDOFF_MESSAGE =
  'Go back to your browser — you can use hacklab while your agent fills in your profile here in the background.'

/** Widest the box gets, however wide the terminal is. */
const BOX_MAX_WIDTH = 60
/** Narrowest it is allowed to shrink to before it stops making sense. */
const BOX_MIN_WIDTH = 24
/** Blank columns between the border and the text, each side. */
const BOX_PADDING = 3

function printHandoffBox(): void {
  // One column short of the window: a box that fills it exactly gets a spurious
  // wrap on terminals that auto-wrap at the last cell. A terminal that reports
  // no width is assumed wide enough for the full box.
  const cols = process.stdout.columns
  const fits = typeof cols === 'number' && cols > 0 ? cols - 1 : BOX_MAX_WIDTH
  const outer = Math.max(BOX_MIN_WIDTH, Math.min(BOX_MAX_WIDTH, fits))
  const inner = outer - 2 - BOX_PADDING * 2

  const pad = ' '.repeat(BOX_PADDING)
  const blank = `${mint('│')}${' '.repeat(outer - 2)}${mint('│')}`
  const rule = (left: string, right: string) =>
    mint(`${left}${'─'.repeat(outer - 2)}${right}`)

  console.log('')
  console.log(rule('┌', '┐'))
  console.log(blank)
  for (const line of wrapToWidth(stripControl(HANDOFF_MESSAGE), inner)) {
    console.log(`${mint('│')}${pad}${padEndTo(line, inner)}${pad}${mint('│')}`)
  }
  console.log(blank)
  console.log(rule('└', '┘'))
  console.log('')
}

/**
 * Greedy word wrap on display columns. A word too long for the line is broken
 * rather than allowed to punch through the border — the box has to keep its
 * shape on a narrow terminal.
 */
function wrapToWidth(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''

  const push = () => {
    if (current !== '') lines.push(current)
    current = ''
  }

  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (displayWidth(rest) > width) {
      push()
      let chunk = ''
      for (const char of rest) {
        if (displayWidth(chunk + char) > width) break
        chunk += char
      }
      // A single character wider than the whole line: emit it and move on
      // rather than spin forever.
      if (chunk === '') chunk = [...rest][0] ?? ''
      lines.push(chunk)
      rest = rest.slice(chunk.length)
    }
    if (rest === '') continue
    const candidate = current === '' ? rest : `${current} ${rest}`
    if (displayWidth(candidate) > width) push()
    current = current === '' ? rest : candidate
  }
  push()

  return lines.length > 0 ? lines : ['']
}
