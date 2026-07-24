import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Only the constrained shared sandbox box throttles vitest: pin it to a single
// thread (no file parallelism) so one `pnpm test` can't saturate CPU and freeze
// other agents or the human terminal. A box is the sandbox only if it's marked
// with HACKLAB_SANDBOX=1 or ~/.hacklab-sandbox. Personal laptops and CI are
// unmarked, so they run fully parallel.
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
