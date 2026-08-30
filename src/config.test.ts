import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// resolveCursorAuth is the one place the three ways of supplying Cursor
// credentials (--cursor-api-key flag, CURSOR_API_KEY env, ~/.hacklab/config.json)
// get ordered, so the precedence lives or dies here. The flag isn't exercised
// directly: index.ts applies it by setting the env var, so "env wins" covers it.

const m = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: m.readFile,
  writeFile: m.writeFile,
  mkdir: m.mkdir,
}))

import { resolveCursorAuth, updateConfig } from './config.js'

function configFile(contents: Record<string, unknown> | null) {
  if (contents === null) {
    m.readFile.mockRejectedValue(missing())
  } else {
    m.readFile.mockResolvedValue(JSON.stringify(contents))
  }
}

/** What fs actually throws for a file that isn't there. */
function missing(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOENT')
  err.code = 'ENOENT'
  return err
}

/** The config object that was written, if any. */
const written = () => {
  const raw = m.writeFile.mock.calls.at(-1)?.[1]
  return raw === undefined ? undefined : JSON.parse(String(raw))
}

const savedEnv = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  m.writeFile.mockResolvedValue(undefined)
  m.mkdir.mockResolvedValue(undefined)
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

// updateConfig is what background writers (the daily-sync bookkeeping) go
// through. loadConfig flattens every read failure to {}, which is fine for
// reading but lethal for a read-modify-write: spreading {} over a config we
// merely failed to PARSE would drop the user's cursor key and consent without
// anyone noticing.
describe('updateConfig', () => {
  it('merges into the existing config', async () => {
    configFile({ cursorApiKey: 'file-key', promptSync: 'stats' })

    const ok = await updateConfig((config) => ({
      ...config,
      dailySync: { command: 'c' },
    }))

    expect(ok).toBe(true)
    expect(written()).toEqual({
      cursorApiKey: 'file-key',
      promptSync: 'stats',
      dailySync: { command: 'c' },
    })
  })

  it('starts from empty when there is no config file yet', async () => {
    configFile(null)

    expect(await updateConfig(() => ({ cursorEmail: 'a@b.c' }))).toBe(true)
    expect(written()).toEqual({ cursorEmail: 'a@b.c' })
  })

  it('refuses to write over a config file it cannot parse', async () => {
    m.readFile.mockResolvedValue('{ this is not json')

    const ok = await updateConfig((config) => ({ ...config, cursorEmail: 'x' }))

    expect(ok).toBe(false)
    expect(m.writeFile).not.toHaveBeenCalled()
  })

  it('refuses a config file that parses to something other than an object', async () => {
    for (const contents of ['null', '"a string"', '[1, 2]']) {
      m.writeFile.mockClear()
      m.readFile.mockResolvedValue(contents)

      expect(await updateConfig(() => ({ cursorEmail: 'x' }))).toBe(false)
      expect(m.writeFile).not.toHaveBeenCalled()
    }
  })

  it('refuses when the file exists but cannot be read', async () => {
    const denied: NodeJS.ErrnoException = new Error('EACCES')
    denied.code = 'EACCES'
    m.readFile.mockRejectedValue(denied)

    expect(await updateConfig(() => ({ cursorEmail: 'x' }))).toBe(false)
    expect(m.writeFile).not.toHaveBeenCalled()
  })

  it('skips the write entirely when the mutator declines', async () => {
    configFile({ cursorApiKey: 'file-key' })

    expect(await updateConfig(() => null)).toBe(true)
    expect(m.writeFile).not.toHaveBeenCalled()
  })

  it('reports a failed write instead of throwing', async () => {
    configFile({ cursorApiKey: 'file-key' })
    m.writeFile.mockRejectedValue(new Error('EROFS'))

    expect(await updateConfig((c) => ({ ...c, cursorEmail: 'x' }))).toBe(false)
  })
})
