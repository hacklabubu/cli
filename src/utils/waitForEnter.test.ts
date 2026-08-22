import { describe, expect, it } from 'vitest'

import { waitForEnter } from './waitForEnter.js'

describe('waitForEnter', () => {
  it('does not wait when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    })
    try {
      await expect(waitForEnter('press Enter')).resolves.toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: original,
      })
    }
  })

  it('resolves false when aborted', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    const abort = new AbortController()
    try {
      const pending = waitForEnter('press Enter', abort.signal)
      abort.abort()
      await expect(pending).resolves.toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: original,
      })
    }
  })
})
