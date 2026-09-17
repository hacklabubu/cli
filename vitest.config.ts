import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Opted-in machines run tests single-threaded to limit CPU use.
// HACKLAB_SANDBOX or ~/.hacklab-sandbox enables the cap; CI bypasses it.
const isSandbox =
  !!process.env.HACKLAB_SANDBOX ||
  existsSync(join(homedir(), '.hacklab-sandbox'))

const cappedTest =
  isSandbox && !process.env.CI
    ? {
        pool: 'threads' as const,
        poolOptions: { threads: { singleThread: true } },
        fileParallelism: false,
      }
    : {}

export default defineConfig({
  test: { ...cappedTest },
})
