import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { railAgentOffer, railDisclosure, railTaskDone } from './setup-rail.js'

// The rail's whole job is row arithmetic: erase one row too few and a stripe of
// the old block survives, one too many and it eats the finished step above.
// These tests read the escape stream the block writes and count the cursor
// walks in it, at a couple of widths — including one narrow enough to wrap.

const ESC = String.fromCharCode(27)
const CURSOR_UP = `${ESC}[1A`

const originalIsTTY = process.stdout.isTTY
const originalColumns = process.stdout.columns

function setTerminal(opts: { isTTY: boolean; columns: number }) {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: opts.isTTY,
  })
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: opts.columns,
  })
}

let written: string
let logged: string[]

beforeEach(() => {
  written = ''
  logged = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    written += String(chunk)
    return true
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    logged.push(String(value ?? ''))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  setTerminal({
    isTTY: originalIsTTY === true,
    columns: (originalColumns as number) ?? 80,
  })
})

/** How many rows the block walked back over. */
const rowsErased = () => written.split(CURSOR_UP).length

describe('railDisclosure', () => {
  const LINES = ['share your prompts?', 'a second line', 'a third line']
  const SETTLED = { message: 'share a sample of your prompts?', value: 'Yes' }

  it('erases the paragraph and the confirm frame together, then reprints one step', () => {
    setTerminal({ isTTY: true, columns: 80 })

    const disclosure = railDisclosure(LINES)
    // A gutter row plus one row per disclosure line, all on the rail.
    expect(logged).toHaveLength(1 + LINES.length)

    disclosure.settle(SETTLED)

    // 4 printed rows + clack's 3-row settled confirm + the newline `close()`
    // leaves the cursor on.
    expect(rowsErased()).toBe(4 + 3 + 1)
  })

  it('counts the extra gutter row a cancelled confirm leaves', () => {
    setTerminal({ isTTY: true, columns: 80 })

    railDisclosure(LINES).settle({ ...SETTLED, cancelled: true })

    expect(rowsErased()).toBe(4 + 4 + 1)
  })

  it('counts wrapped rows, not printed lines', () => {
    // At 50 columns the second disclosure line takes two rows: the erase has to
    // be in rows or the block only half comes off.
    const long = 'x'.repeat(60)
    setTerminal({ isTTY: true, columns: 50 })

    railDisclosure(['short', long]).settle(SETTLED)

    // gutter + 'short' + two rows of `long` + the 3-row confirm + the newline.
    expect(rowsErased()).toBe(1 + 1 + 2 + 3 + 1)
  })

  it('prints the paragraph plainly and erases nothing when there is no terminal', () => {
    setTerminal({ isTTY: false, columns: 80 })

    railDisclosure(LINES).settle(SETTLED)

    // Down a pipe the cursor walks would be litter in the transcript.
    expect(written).not.toContain(CURSOR_UP)
  })

  it('leaves the block alone on a terminal too narrow to measure the widget', () => {
    // clack wraps its own question against the *styled* gutter, so below a
    // margin we cannot predict how tall the settled widget is. Erasing on a
    // guess would eat the finished step above it; leaving the paragraph up
    // costs nothing but rows.
    setTerminal({ isTTY: true, columns: 34 })

    railDisclosure(LINES).settle(SETTLED)

    expect(written).not.toContain(CURSOR_UP)
  })

  it('still compacts at the narrowest width it can vouch for', () => {
    // 31 columns of question + the 16-column budget.
    setTerminal({ isTTY: true, columns: 47 })

    railDisclosure(['short']).settle(SETTLED)

    expect(rowsErased()).toBe(1 + 1 + 3 + 1)
  })
})

describe('railAgentOffer', () => {
  // The offer is three printed rows plus the prompt row the answer was typed
  // onto. `press Enter to hand off · anything else skips ` behind its gutter is
  // 49 columns, so a one-character decline lands on column 50 exactly.
  const OFFER_ROWS = 3

  it('erases the offer and the prompt row a bare Enter left', () => {
    setTerminal({ isTTY: true, columns: 80 })

    railAgentOffer('Claude Code').settle('')

    expect(rowsErased()).toBe(OFFER_ROWS + 1 + 1)
  })

  it('counts the row a decline filled to the last column', () => {
    // The bug this pins: at exactly 50 columns the echoed `n` fills the prompt
    // row, readline flushes the pending wrap with a newline of its own, and a
    // block that counted one row leaves a stray gutter line behind.
    setTerminal({ isTTY: true, columns: 50 })

    railAgentOffer('Claude Code').settle('n')

    // Two rows for each of the two wrapped body lines, one gutter, then a
    // prompt row that has already cost two.
    expect(rowsErased()).toBe(1 + 2 + 2 + 2 + 1)
  })

  it('leaves the same decline at one row when it clears the edge', () => {
    setTerminal({ isTTY: true, columns: 51 })

    railAgentOffer('Claude Code').settle('n')

    expect(rowsErased()).toBe(1 + 2 + 2 + 1 + 1)
  })
})

describe('railTaskDone', () => {
  it('takes back the line taskLog closed with and reprints it as a step', () => {
    setTerminal({ isTTY: true, columns: 80 })
    const task = { success: vi.fn() }

    railTaskDone(task, 'scanned · 11.8B tokens')

    expect(task.success).toHaveBeenCalledWith('scanned · 11.8B tokens')
    // clack's gutter row + the closing line + the newline below it.
    expect(rowsErased()).toBe(1 + 1 + 1)
  })

  it('leaves the filled glyph alone when there is no terminal to redraw', () => {
    setTerminal({ isTTY: false, columns: 80 })
    const task = { success: vi.fn() }

    railTaskDone(task, 'scanned · 11.8B tokens')

    expect(task.success).toHaveBeenCalledOnce()
    expect(written).not.toContain(CURSOR_UP)
  })
})
