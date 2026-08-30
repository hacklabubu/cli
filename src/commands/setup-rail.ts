import { S_BAR, S_WARN } from '@clack/prompts'

import { bold, dim, displayWidth, gray, link, mint, yellow } from '../ui.js'
import type { DeviceCodeRenderer } from './login.js'

/**
 * The step rail `setup` is drawn on.
 *
 * Everything clack prints — prompts, `log.*`, spinners, `taskLog` — hangs off a
 * `│` gutter and leaves one `◇` line per finished step. Two beats of `setup`
 * can't be a clack widget (the device-code beat races an Enter-wait against a
 * poll; the agent offer waits on a bare Enter), so they are drawn here by hand
 * in the same vocabulary and, like every other step, collapse to one line when
 * they are done.
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
   * Count a row drawn by something else that left the cursor parked on it — a
   * `waitForEnter` prompt, which deliberately prints no newline of its own.
   */
  prompt(plain: string): void {
    this.rows += rowsFor(plain)
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
 * ▲  first copy your one-time code: C98F-E695
 * │
 * │  Press Enter to open https://hacklab.so/cli/login in your browser...
 * ```
 *
 * The code is the one thing on screen the user has to act on, so it gets the
 * attention glyph and the mint. Once the approval lands, the block has served
 * its purpose and the caller replaces all four rows with one `◇ hacklab · …`
 * line.
 */
export function railDeviceCode(): DeviceCodeRenderer {
  const block = new RailBlock()
  let enterPlain = ''

  return {
    show({ userCode, verificationUri }) {
      block.line(gray(S_BAR))
      block.line(
        `${yellow(S_WARN)}  first copy your one-time code: ${mint(userCode)}`,
        `${S_WARN}  first copy your one-time code: ${userCode}`
      )
      block.line(gray(S_BAR))
      enterPlain = `${S_BAR}  Press Enter to open ${verificationUri} in your browser... `
      return `${gray(S_BAR)}  ${bold('Press Enter')} to open ${link(verificationUri)} in your browser... `
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
  settle(): void
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

  const plain = `${S_BAR}  Press Enter to hand off · anything else skips `
  return {
    prompt: `${gray(S_BAR)}  ${bold('Press Enter')} to hand off ${dim('· anything else skips')} `,
    settle() {
      // Reached only after a line was read, so the echoed newline has already
      // moved the cursor below the prompt row.
      block.prompt(plain)
      block.erase('below')
    },
  }
}
