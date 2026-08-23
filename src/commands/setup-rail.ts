import {
  log,
  S_BAR,
  S_STEP_CANCEL,
  S_STEP_SUBMIT,
  S_SUCCESS,
  S_WARN,
} from '@clack/prompts'

import { bold, dim, displayWidth, gray, link, mint, yellow } from '../ui.js'
import type { DeviceCodeRenderer } from './login.js'

/**
 * The step rail `setup` is drawn on.
 *
 * Everything clack prints — prompts, `log.*`, spinners, `taskLog` — hangs off a
 * `│` gutter and leaves one `◇` line per finished step. Two beats of `setup`
 * can't be a clack widget (the GitHub code beat races an Enter-wait against a
 * poll; the agent offer waits on a bare Enter), so they are drawn here by hand
 * in the same vocabulary and, like every other step, collapse to one line when
 * they are done. Two more beats *are* clack widgets that fold up wrong on their
 * own — the consent disclosure above a `confirm`, and `taskLog`'s hardcoded
 * closing glyph — so the rail finishes those too.
 */

/** Columns to wrap at. 80 is what a terminal that won't say implies. */
function width(): number {
  const cols = process.stdout.columns
  return typeof cols === 'number' && cols > 0 ? cols : 80
}

/**
 * True when the cursor can be walked back over what we printed: a real terminal
 * that reports a width. Down a pipe the escape codes are litter, and a pty that
 * reports zero columns turns row arithmetic — ours and clack's `taskLog` — into
 * a divide by zero.
 */
export function canRedraw(): boolean {
  return (
    process.stdout.isTTY === true &&
    typeof process.stdout.columns === 'number' &&
    process.stdout.columns > 0
  )
}

/** Terminal rows a plain, unstyled line occupies at the current width. */
function rowsFor(plain: string): number {
  return Math.max(1, Math.ceil(displayWidth(plain) / width()))
}

/**
 * Rows a `readline` prompt row has taken, counting whatever the user typed onto
 * it before Enter.
 *
 * Not `rowsFor`. A terminal leaves the wrap *pending* when text lands exactly on
 * the right edge, and node's readline settles that ambiguity by flushing the row
 * with a newline of its own — so a prompt row that exactly fills the width has
 * already cost two rows. `floor + 1` says that; `ceil` says one, and the block
 * comes off a row short of where it started, leaving a stray `│` behind. The
 * miss is invisible until the terminal happens to be exactly as wide as the
 * prompt plus what was typed into it: 50 columns, for the agent offer answered
 * with `n`.
 */
function promptRowsFor(plain: string): number {
  return Math.floor(displayWidth(plain) / width()) + 1
}

const ERASE_LINE = '\u001b[2K'
const CURSOR_UP = '\u001b[1A'

/** Erase `count` rows, ending on the topmost one with the cursor at column 1. */
function eraseRows(count: number): string {
  let out = ERASE_LINE
  for (let i = 1; i < count; i++) out += CURSOR_UP + ERASE_LINE
  return `${out}\r`
}

/**
 * A run of rail lines that can rub itself out.
 *
 * Accounting is in terminal *rows*, not lines printed: a narrow window wraps a
 * long verification URL onto two, and erasing one row too few leaves a stripe
 * of the old block behind while one too many eats the step above it. Styled
 * text is measured through its plain twin, since ANSI and OSC-8 escapes occupy
 * no columns.
 */
export class RailBlock {
  private rows = 0

  /** Print one line. `plain` is the same text stripped of styling. */
  line(styled: string, plain: string = styled): void {
    console.log(styled)
    this.rows += rowsFor(plain)
  }

  /**
   * Count a row that something else drew and we are on the hook for erasing —
   * a `waitForEnter` prompt, or the frame a settled clack widget leaves below
   * the block.
   */
  foreign(plain: string): void {
    this.rows += rowsFor(plain)
  }

  /**
   * Count the row a `readline` prompt is sitting on. `plain` is the prompt plus
   * anything the user typed before Enter — both were echoed onto that one row,
   * and together they decide whether it wrapped.
   */
  prompt(plain: string): void {
    this.rows += promptRowsFor(plain)
  }

  /**
   * Erase the block. `cursor` is where the terminal left us: `below` when the
   * last thing written ended in a newline (including the one the user's Enter
   * echoed), `inline` when the cursor still sits on the block's last row.
   */
  erase(cursor: 'below' | 'inline'): void {
    const rows = this.rows + (cursor === 'below' ? 1 : 0)
    this.rows = 0
    if (rows > 0 && canRedraw()) process.stdout.write(eraseRows(rows))
  }
}

/**
 * `setup`'s device-code beat, modelled on GitHub's own CLI:
 *
 * ```
 * │
 * ▲  sign in, then come back here — first copy your one-time code: C98F-E695
 * │
 * │  press Enter to open https://github.com/login/device in your browser...
 * ```
 *
 * The code is the one thing on screen the user has to act on, so it gets the
 * attention glyph and the mint — bold too, because it is about to be typed into
 * another window. Saying up front that the terminal is where they come back to
 * is the difference between a finished setup and a browser tab left open. Once
 * GitHub answers, the block has served its purpose and the caller replaces all
 * four rows with one `◇ github · …` line.
 */
export function railDeviceCode(): DeviceCodeRenderer {
  const block = new RailBlock()
  let enterPlain = ''

  return {
    show({ userCode, verificationUri }) {
      block.line(gray(S_BAR))
      block.line(
        `${yellow(S_WARN)}  sign in, then come back here — first copy your one-time code: ${bold(mint(userCode))}`,
        `${S_WARN}  sign in, then come back here — first copy your one-time code: ${userCode}`
      )
      block.line(gray(S_BAR))
      enterPlain = `${S_BAR}  press Enter to open ${verificationUri} in your browser... `
      return `${gray(S_BAR)}  ${bold('press Enter')} to open ${link(verificationUri)} in your browser... `
    },
    done({ enterPressed }) {
      // No TTY means `waitForEnter` printed nothing and returned at once, so
      // there is no prompt row to account for.
      if (!process.stdin.isTTY) {
        block.erase('below')
        return
      }
      block.prompt(enterPlain)
      block.erase(enterPressed ? 'below' : 'inline')
    },
  }
}

/**
 * The agent-handoff offer, drawn as a block that clears once answered. Enter is
 * the accept here, so the prompt says so plainly and anything else is a no.
 */
export function railAgentOffer(agentName: string): {
  prompt: string
  settle(typed: string): void
} {
  const block = new RailBlock()
  block.line(gray(S_BAR))
  block.line(
    `${gray(S_BAR)}  found ${bold(agentName)} — it can set up your profile now`,
    `${S_BAR}  found ${agentName} — it can set up your profile now`
  )
  block.line(
    `${gray(S_BAR)}  ${dim('it runs here in your terminal, and you approve what it does')}`,
    `${S_BAR}  it runs here in your terminal, and you approve what it does`
  )

  const plain = `${S_BAR}  press Enter to hand off · anything else skips `
  return {
    prompt: `${gray(S_BAR)}  ${bold('press Enter')} to hand off ${dim('· anything else skips')} `,
    settle(typed: string) {
      // Reached only after a line was read, so the echoed newline has already
      // moved the cursor below the prompt row — and whatever was typed to
      // decline is still sitting on the end of it.
      block.prompt(`${plain}${typed}`)
      block.erase('below')
    },
  }
}

/**
 * Columns to keep clear of a clack prompt's question before trusting our own
 * measurement of it.
 *
 * Every other block on the rail is drawn by `console.log`, so the terminal wraps
 * it and `rowsFor` predicts that exactly. A clack widget wraps *itself* first:
 * `wrapTextWithPrefix` sizes the text against `columns - prefix.length`, and the
 * prefix it measures is the *styled* gutter — the colour escapes around a
 * one-column `│` are counted as if they took thirteen columns. So clack breaks
 * its question onto a second row well before the visible width says it must, and
 * a block that measured the question the honest way would erase a row short.
 *
 * Reproducing that number here would pin us to clack's internals. Instead the
 * rail only folds a disclosure away when the question clears this budget, which
 * is wider than the escapes can be — and leaves the block alone when it doesn't.
 * An uncompacted paragraph reads perfectly well; a mis-measured erase eats the
 * finished step above it.
 */
const CLACK_PROMPT_GUTTER = 16

/** What a settled `clack.confirm` leaves on screen, so the rail can erase it. */
export type SettledConfirm = {
  /** The question, exactly as it was passed to `confirm`. */
  message: string
  /** The label clack printed under it — `Yes` / `No`. */
  value: string
  /** True when the widget was cancelled: clack's frame gains a trailing `│`. */
  cancelled?: boolean
}

/**
 * A disclosure paragraph that has to be on screen while the question under it is
 * answered, and gone the moment it is.
 *
 * The paragraph is the only thing on the rail that outlives its own step:
 * `confirm` folds itself into `◇ question / │ Yes`, but the six lines above it
 * are a plain `log.message` and stay. They can't be erased before the answer —
 * that is what the user is reading — and they can't be erased from underneath
 * a widget that owns the rows below them. So the whole run comes off together
 * once the confirm settles, and the one line it was entitled to is printed
 * fresh: `log.step` + a dim value line is byte-for-byte the frame clack draws.
 *
 * Below `canRedraw()` there is nothing to redraw, and below
 * `CLACK_PROMPT_GUTTER` there is no way to be sure how tall the widget came out,
 * so in both cases the paragraph is printed the ordinary way and left alone.
 */
export function railDisclosure(lines: string[]): {
  settle(confirm: SettledConfirm): void
} {
  if (!canRedraw()) {
    log.message(lines)
    return {
      settle() {
        // Nothing to undo: the paragraph is meant to stay on screen.
      },
    }
  }

  const block = new RailBlock()
  block.line(gray(S_BAR))
  // `displayWidth` ignores ANSI, so styled lines measure as their own plain
  // twins here — no separate copy to keep in step.
  for (const styled of lines) {
    block.line(styled === '' ? gray(S_BAR) : `${gray(S_BAR)}  ${styled}`)
  }

  return {
    settle({ message, value, cancelled }) {
      // Too narrow to say with certainty how tall clack drew the question, so
      // nothing is erased and nothing is reprinted — the paragraph and the
      // widget's own compacted line both stay exactly as they are.
      if (displayWidth(message) + CLACK_PROMPT_GUTTER > width()) return

      // clack's settled confirm frame, top to bottom: a gutter row, the
      // question behind its glyph, the answer. A cancel adds one more gutter
      // row, and `close()` always leaves the cursor on the line below.
      block.foreign(S_BAR)
      block.foreign(`${cancelled ? S_STEP_CANCEL : S_STEP_SUBMIT}  ${message}`)
      block.foreign(`${S_BAR}  ${value}`)
      if (cancelled) block.foreign(S_BAR)
      block.erase('below')

      log.step(message)
      log.message(dim(value), { spacing: 0 })
    },
  }
}

/**
 * Close a finished `taskLog` on the rail's terms.
 *
 * `taskLog.success()` does the right thing — erase the working notes, leave one
 * line where they were — with the wrong glyph: it hardcodes the filled `◆` this
 * flow reserves for the final "you're in", and takes no option for it. So the
 * line it prints is un-printed and printed again as a `◇` step. The two rows it
 * occupies (clack's gutter row, then the line itself) are measured the same way
 * every other rail erase is.
 */
export function railTaskDone(
  task: { success(message: string): void },
  summary: string
): void {
  task.success(summary)
  if (!canRedraw()) return

  const block = new RailBlock()
  block.foreign(S_BAR)
  block.foreign(`${S_SUCCESS}  ${summary}`)
  block.erase('below')
  log.step(summary)
}
