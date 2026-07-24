import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// resolveCursorAuth is the one place the three ways of supplying Cursor
// credentials (--cursor-api-key flag, CURSOR_API_KEY env, ~/.hacklab/config.json)
// get ordered, so the precedence lives or dies here. The flag isn't exercised
// directly: index.ts applies it by setting the env var, so "env wins" covers it.

const m = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('node:fs/promises', () => ({
  readFile: m.readFile,
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

import { resolveCursorAuth } from './config.js'

function configFile(contents: Record<string, string> | null) {
  if (contents === null) {
    m.readFile.mockRejectedValue(new Error('ENOENT'))
  } else {
    m.readFile.mockResolvedValue(JSON.stringify(contents))
  }
}

const savedEnv = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CURSOR_API_KEY
  delete process.env.CURSOR_EMAIL
})

afterEach(() => {
  process.env = { ...savedEnv }
})

describe('resolveCursorAuth precedence', () => {
  it('uses the config file when nothing is in the environment', async () => {
    configFile({ cursorApiKey: 'file-key', cursorEmail: 'file@example.com' })

    const auth = await resolveCursorAuth()

    expect(auth).toMatchObject({
      apiKey: 'file-key',
      email: 'file@example.com',
      apiKeySource: 'config',
      emailSource: 'config',
    })
  })

  it('lets the environment (and therefore the flag) beat the config file', async () => {
    configFile({ cursorApiKey: 'file-key', cursorEmail: 'file@example.com' })
    process.env.CURSOR_API_KEY = 'env-key'
    process.env.CURSOR_EMAIL = 'env@example.com'

    const auth = await resolveCursorAuth()

    expect(auth).toMatchObject({
      apiKey: 'env-key',
      email: 'env@example.com',
      apiKeySource: 'env',
      emailSource: 'env',
    })
  })

  it('resolves key and email independently', async () => {
    // A team key on the command line, the email left in the config file: the
    // pair must not have to come from the same source, or a one-off
    // --cursor-api-key would silently drop the email scoping and pull in the
    // whole team's usage.
    configFile({ cursorApiKey: 'file-key', cursorEmail: 'file@example.com' })
    process.env.CURSOR_API_KEY = 'env-key'

    const auth = await resolveCursorAuth()

    expect(auth).toMatchObject({
      apiKey: 'env-key',
      apiKeySource: 'env',
      email: 'file@example.com',
      emailSource: 'config',
    })
  })

  it('ignores a blank env var instead of letting it shadow the config file', async () => {
    // `CURSOR_API_KEY=` in a sourced .env / CI environment must not mask a
    // perfectly good configured key and silently downgrade the user to the
    // local estimate.
    configFile({ cursorApiKey: 'file-key' })
    process.env.CURSOR_API_KEY = '   '

    const auth = await resolveCursorAuth()

    expect(auth).toMatchObject({ apiKey: 'file-key', apiKeySource: 'config' })
  })

  it('trims whitespace off an env value', async () => {
    configFile(null)
    process.env.CURSOR_API_KEY = '  padded-key\n'

    expect(await resolveCursorAuth()).toMatchObject({ apiKey: 'padded-key' })
  })

  it('reports none when there is no key anywhere', async () => {
    configFile(null)

    expect(await resolveCursorAuth()).toMatchObject({
      apiKey: undefined,
      email: undefined,
      apiKeySource: 'none',
      emailSource: 'none',
    })
  })
})
