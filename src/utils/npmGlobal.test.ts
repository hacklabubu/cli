import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  firstExistingAncestor,
  isWritable,
  NPM_BIN,
  userNpmPrefix,
} from './npmGlobal.js'

describe('NPM_BIN', () => {
  it('picks the .cmd shim on Windows, plain npm elsewhere', () => {
    expect(NPM_BIN).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm')
  })
})

describe('userNpmPrefix', () => {
  it('is ~/.npm-global', () => {
    expect(userNpmPrefix()).toBe(join(homedir(), '.npm-global'))
  })
})

describe('firstExistingAncestor', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hacklab-npmglobal-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the path itself when it exists', () => {
    expect(firstExistingAncestor(dir)).toBe(dir)
  })

  it('walks up to the nearest existing ancestor for a not-yet-created path', () => {
    // npm's target (…/lib/node_modules/hacklab) rarely exists yet; we must probe
    // the closest ancestor that does.
    const deep = join(dir, 'lib', 'node_modules', 'hacklab')
    expect(firstExistingAncestor(deep)).toBe(dir)
  })

  it('bottoms out at the filesystem root without looping forever', () => {
    // A totally bogus path still terminates (root always exists).
    const anc = firstExistingAncestor('/this/does/not/exist/anywhere')
    expect(anc).toBe('/')
  })
})

describe('isWritable', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hacklab-npmglobal-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is true for a not-yet-created path under a writable ancestor', () => {
    expect(isWritable(join(dir, 'lib', 'node_modules'))).toBe(true)
  })
})
