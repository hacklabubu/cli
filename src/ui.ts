import chalk from 'chalk'
import stringWidth from 'string-width'
import { type BeltColor, getBeltColor } from './belt.js'

export const dim = chalk.dim
export const bold = chalk.bold
export const green = chalk.green
export const red = chalk.red
export const yellow = chalk.yellow
export const white = chalk.whiteBright
// GitHub's link blue. chalk degrades the hex to the nearest ANSI colour on
// terminals without truecolor support.
export const linkBlue = chalk.hex('#79b8ff')

/** Clickable OSC-8 hyperlink. Visible text is the URL so a copy still works. */
export function link(url: string): string {
  return `\u001b]8;;${url}\u001b\\${linkBlue(url)}\u001b]8;;\u001b\\`
}
// Phosphor Mint (DESIGN.md --primary #82F5C6): the "active and alive" signal —
// the open-to-work status dot and lit activity cells. chalk degrades the hex on
// terminals without truecolor.
export const mint = chalk.hex('#82F5C6')

// Map a belt colour to the nearest standard ANSI terminal colour name. We use
// chalk's *named* colours (not the hex values from share-card-colors) on
// purpose: named colours resolve to each viewer's own terminal theme, so the
// rank hue approximates our brand palette while still respecting individual
// colour configs. ANSI has no orange/lime/pink, so we pick the closest hue and
// lean on the bright variants to keep all eleven belts visually distinct.
const BELT_ANSI: Record<BeltColor, typeof chalk.red> = {
  white: chalk.white,
  orange: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
  cyan: chalk.cyan,
  yellow: chalk.yellowBright,
  lime: chalk.greenBright,
  green: chalk.green,
  pink: chalk.magentaBright,
  purple: chalk.magenta,
  // Black belt is rendered as white (#FFFFFF) in our palette; a literal black
  // would be invisible on a dark terminal, so bright white reads as the top rank.
  black: chalk.whiteBright,
}

/**
 * Colour a string in the terminal colour for the rank at `level`. A null/unknown
 * level (e.g. older messages without a sender level) falls back to plain bold.
 */
export function rankColor(
  level: number | null | undefined,
  text: string
): string {
  // Guard non-finite levels too (NaN/Infinity): `== null` misses NaN, and
  // getBeltColor(NaN) would silently fall through to white. Plain bold is the
  // honest fallback for an unknown rank.
  if (level == null || !Number.isFinite(level)) return bold(text)
  return BELT_ANSI[getBeltColor(level)].bold(text)
}

// --- Display-width primitives ----------------------------------------------
// The hacker card has a fixed column budget, and its content is user-supplied
// (handles, bios) that can contain CJK, emoji, and ANSI. `.length` is wrong for
// all three. Render order everywhere is: strip → truncate → measure → colorize
// LAST — colorizing before truncation would slice an ANSI escape mid-byte, and
// stringWidth counts ANSI as zero so a coloured string would measure short and
// truncate into corruption. These helpers therefore operate on PLAIN text.

// Ambiguous-width characters (⬤, box-drawing) count as 1 column — pinned per
// DESIGN.md so the card's rules and content agree with a standard terminal.
const WIDTH_OPTS = { ambiguousIsNarrow: true } as const

/** Display columns a plain string occupies (ANSI stripped, CJK/emoji aware). */
export function displayWidth(s: string): number {
  return stringWidth(s, WIDTH_OPTS)
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * Truncate a PLAIN string to at most `max` display columns, cutting on grapheme
 * boundaries (never mid-emoji / mid-surrogate) and adding a 1-column ellipsis
 * when anything was dropped. Must run before colorizing.
 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(s) <= max) return s
  const budget = max - 1 // reserve one column for the … ellipsis
  let out = ''
  let width = 0
  for (const { segment } of graphemeSegmenter.segment(s)) {
    const w = displayWidth(segment)
    if (width + w > budget) break
    out += segment
    width += w
  }
  return `${out}…`
}

/** Right-pad a PLAIN string with spaces to exactly `width` display columns. */
export function padEndTo(s: string, width: number): string {
  const gap = width - displayWidth(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

// Strip C0 control characters + DEL from untrusted text before printing it to
// the terminal. Without this, a hacker could embed ANSI escape sequences in a
// handle, bio, message, or any user-supplied field to clear/garble or hijack
// any viewer's terminal. Lives here (not in a command module) so every renderer
// — chat, the hacker card — can reach it without a circular import.
export function stripControl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to remove them
  return s.replace(/[\x00-\x1f\x7f]/g, '')
}

export function banner() {
  console.log('')
  console.log(bold('  ☠︎  hacklab'))
  console.log(dim('  information wants to be free'))
}

export function success(msg: string) {
  console.log(green('  ✓ ') + msg)
}

export function error(msg: string) {
  console.error(red('  ✗ ') + msg)
}

export function info(msg: string) {
  console.log(dim('  → ') + msg)
}

// Like info(), but on stderr. For companion hints printed alongside an error()
// so that `--json` stdout stays pure (the envelope and nothing else).
export function hint(msg: string) {
  console.error(dim('  → ') + msg)
}
