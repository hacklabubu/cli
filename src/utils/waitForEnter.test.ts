import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { waitForBareEnter, waitForEnter } from './waitForEnter.js'

/** Run `fn` with a writable fake TTY stdin, then put the real one back. */
async function withFakeStdin(
  fn: (stdin: PassThrough) => Promise<void>
): Promise<void> {
  const original = process.stdin
  const fake = new PassThrough() as PassThrough & { isTTY: boolean }
  fake.isTTY = true
  Object.defineProperty(process, 'stdin', { configurable: true, value: fake })
  try {
    await fn(fake)
  } finally {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: original,
    })
  }
}

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

  it('accepts any line, typed or bare', async () => {
    await withFakeStdin(async (stdin) => {
      const pending = waitForEnter('press Enter ')
      stdin.write('n\n')
      await expect(pending).resolves.toBe(true)
    })
  })
})

describe('waitForBareEnter', () => {
  it('says yes to a bare Enter', async () => {
    await withFakeStdin(async (stdin) => {
      const pending = waitForBareEnter('press Enter ')
      stdin.write('\n')
      await expect(pending).resolves.toBe(true)
    })
  })

  it('says no to anything typed before Enter', async () => {
    await withFakeStdin(async (stdin) => {
      const pending = waitForBareEnter('press Enter ')
      stdin.write('n\n')
      await expect(pending).resolves.toBe(false)
    })
  })

  it('does not wait when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    })
    try {
      await expect(waitForBareEnter('press Enter ')).resolves.toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: original,
      })
    }
  })
})
