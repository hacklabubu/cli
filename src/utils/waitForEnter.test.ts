import { afterEach, expect, it, vi } from 'vitest'
import { waitForEnter } from './waitForEnter.js'

const originalTTY = process.stdin.isTTY

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  })
}

afterEach(() => {
  setTTY(originalTTY)
  vi.restoreAllMocks()
})

it('does not block when stdin is not a TTY', async () => {
  setTTY(undefined)
  const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

  // A piped/CI run has nobody to press Enter — it must return at once, and
  // without printing a prompt that would never be answered.
  await expect(waitForEnter('press Enter')).resolves.toBe(false)
  expect(log).not.toHaveBeenCalled()
})
