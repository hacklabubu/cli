import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseBookArgs } from './book.js'

// parseBookArgs reports usage errors by exiting, so the failure paths need
// process.exit stubbed to something that actually stops execution — otherwise
// the function would run on past the exit and throw somewhere unrelated.
class ExitError extends Error {}

function stubExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new ExitError('exit')
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseBookArgs', () => {
  it('joins free words into the title', () => {
    expect(
      parseBookArgs(['The', 'Mythical', 'Man-Month', '-a', 'Brooks'])
    ).toEqual({ title: 'The Mythical Man-Month', author: 'Brooks' })
  })

  it('takes a quoted title as a single arg', () => {
    expect(
      parseBookArgs(['The Pragmatic Programmer', '--author', 'Hunt'])
    ).toEqual({ title: 'The Pragmatic Programmer', author: 'Hunt' })
  })

  it('accepts takeaways via either flag spelling', () => {
    expect(
      parseBookArgs(['Dune', '-a', 'Herbert', '-t', 'spice is a supply chain'])
    ).toEqual({
      title: 'Dune',
      author: 'Herbert',
      takeaways: 'spice is a supply chain',
    })
    expect(
      parseBookArgs(['Dune', '--author', 'Herbert', '--takeaways', 'worms.'])
    ).toEqual({ title: 'Dune', author: 'Herbert', takeaways: 'worms.' })
  })

  it('keeps interior newlines in takeaways so paragraphs survive', () => {
    const takeaways = 'first para.\n\nsecond para.'
    expect(parseBookArgs(['X', '-a', 'Y', '-t', takeaways]).takeaways).toBe(
      takeaways
    )
  })

  it('omits takeaways when the flag is absent or blank', () => {
    expect(parseBookArgs(['X', '-a', 'Y'])).not.toHaveProperty('takeaways')
    expect(parseBookArgs(['X', '-a', 'Y', '-t', '   '])).not.toHaveProperty(
      'takeaways'
    )
  })

  it('trims surrounding whitespace off every field', () => {
    expect(
      parseBookArgs(['  Dune  ', '-a', '  Herbert  ', '-t', '  worms.  '])
    ).toEqual({ title: 'Dune', author: 'Herbert', takeaways: 'worms.' })
  })

  it('exits when the title is missing', () => {
    const exit = stubExit()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => parseBookArgs(['-a', 'Brooks'])).toThrow(ExitError)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits when the author is missing', () => {
    const exit = stubExit()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => parseBookArgs(['Dune'])).toThrow(ExitError)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits on an unknown flag rather than swallowing it into the title', () => {
    const exit = stubExit()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => parseBookArgs(['Dune', '--rating', '5'])).toThrow(ExitError)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
