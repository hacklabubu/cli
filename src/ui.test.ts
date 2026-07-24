import chalk from 'chalk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  bold,
  displayWidth,
  padEndTo,
  rankColor,
  stripControl,
  truncateToWidth,
} from './ui.js'

describe('displayWidth', () => {
  it('counts ASCII one column per character', () => {
    expect(displayWidth('isomiki')).toBe(7)
  })

  it('counts CJK as two columns', () => {
    expect(displayWidth('道')).toBe(2)
    expect(displayWidth('ab道')).toBe(4)
  })

  it('counts an emoji as two columns (not its code-point length)', () => {
    // A ZWJ family emoji is many code points but two terminal columns.
    expect(displayWidth('👩‍👩‍👧')).toBe(2)
  })

  it('ignores ANSI escapes', () => {
    expect(displayWidth(bold('hello'))).toBe(5)
  })

  it('treats ambiguous-width box glyphs as one column', () => {
    expect(displayWidth('████')).toBe(4)
    expect(displayWidth('▁▂▅█')).toBe(4)
  })
})

describe('truncateToWidth', () => {
  it('leaves a string that already fits untouched', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello')
    expect(truncateToWidth('hello', 5)).toBe('hello')
  })

  it('cuts to the budget and appends a one-column ellipsis', () => {
    const out = truncateToWidth('hello world', 8)
    expect(displayWidth(out)).toBeLessThanOrEqual(8)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never splits a multi-codepoint grapheme', () => {
    // Budget lands mid-emoji; the emoji must be dropped whole, not halved.
    const out = truncateToWidth('a👩‍👩‍👧b', 3)
    expect(out).not.toContain('‍') // no dangling ZWJ
    expect(displayWidth(out)).toBeLessThanOrEqual(3)
  })

  it('returns empty for a non-positive budget', () => {
    expect(truncateToWidth('hello', 0)).toBe('')
  })
})

describe('padEndTo', () => {
  it('pads a short string to the target width', () => {
    expect(padEndTo('hi', 5)).toBe('hi   ')
    expect(displayWidth(padEndTo('道', 5))).toBe(5)
  })

  it('leaves a string at or over the width unchanged', () => {
    expect(padEndTo('hello', 5)).toBe('hello')
    expect(padEndTo('hello', 3)).toBe('hello')
  })
})

describe('stripControl', () => {
  it('removes ANSI escape / control sequences from untrusted content', () => {
    // \x1b = ESC (ANSI), \x07 = BEL, \x00 = NUL — all must be dropped.
    const malicious = 'hi\x1b[2Jthere\x07\x00'
    const cleaned = stripControl(malicious)
    expect(cleaned).toBe('hi[2Jthere')
    expect(cleaned).not.toContain('\x1b')
  })

  it('leaves normal text untouched', () => {
    expect(stripControl('hello world 123 @handle')).toBe(
      'hello world 123 @handle'
    )
  })
})

describe('rankColor', () => {
  let original: typeof chalk.level

  beforeAll(() => {
    original = chalk.level
    // Force basic 16-colour ANSI output so the mapping is deterministic
    // regardless of the (non-TTY) test environment's detected colour support.
    chalk.level = 1
  })

  afterAll(() => {
    chalk.level = original
  })

  it('falls back to plain bold for a null/unknown level', () => {
    expect(rankColor(null, 'neo')).toBe(bold('neo'))
    expect(rankColor(undefined, 'neo')).toBe(bold('neo'))
  })

  it('falls back to plain bold for non-finite levels (NaN/Infinity)', () => {
    // `level == null` misses NaN, so guard finiteness explicitly — otherwise
    // getBeltColor(NaN) silently falls through to white. (A finite negative is
    // in-range for getBeltColor and validly maps to the lowest belt.)
    expect(rankColor(Number.NaN, 'neo')).toBe(bold('neo'))
    expect(rankColor(Number.POSITIVE_INFINITY, 'neo')).toBe(bold('neo'))
  })

  it('always preserves the handle text', () => {
    for (const lvl of [0, 15, 25, 55, 65, 85, 95, 120]) {
      expect(rankColor(lvl, 'morpheus')).toContain('morpheus')
    }
  })

  it('renders different belt tiers in different colours', () => {
    const white = rankColor(0, 'x') // white belt
    const red = rankColor(20, 'x') // red belt
    const blue = rankColor(30, 'x') // blue belt
    expect(new Set([white, red, blue]).size).toBe(3)
  })

  it('renders the black belt (level >= 100) as bright white, distinct from white belt', () => {
    // The black-belt branch is a deliberate special case: a literal black would
    // be invisible on a dark terminal, so it maps to whiteBright. Guard that the
    // level>=100 mapping is brightWhite-bold and is NOT the same as plain white.
    const black = rankColor(100, 'neo')
    expect(black).toBe(chalk.whiteBright.bold('neo'))
    expect(black).toBe(rankColor(250, 'neo')) // grand-master still black belt
    expect(black).not.toBe(rankColor(0, 'neo')) // != white belt
  })

  it('pins the black-belt threshold at level 100', () => {
    // Level 99 is still purple belt; 100 crosses into black belt. Guard the cutoff.
    expect(rankColor(99, 'x')).not.toBe(rankColor(100, 'x'))
  })

  it('maps every belt tier to its own ANSI colour with no collisions', () => {
    // One representative level inside each of the eleven belt tiers (min-level
    // of each band, plus 100 for black). Every rendered handle must be unique —
    // catches any two tiers being accidentally mapped to the same chalk colour.
    const tierLevels = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const rendered = tierLevels.map((lvl) => rankColor(lvl, 'x'))
    expect(new Set(rendered).size).toBe(tierLevels.length)
  })
})
