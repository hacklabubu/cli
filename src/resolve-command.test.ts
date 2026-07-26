import { describe, expect, it } from 'vitest'

import { resolveCommand } from './resolve-command.js'

describe('resolveCommand', () => {
  it('resolves an exact command name', () => {
    expect(resolveCommand('sync')).toEqual({ kind: 'match', name: 'sync' })
    expect(resolveCommand('org')).toEqual({
      kind: 'match',
      name: 'org',
    })
    expect(resolveCommand('WTF')).toEqual({ kind: 'match', name: 'WTF' })
    expect(resolveCommand('wtf')).toEqual({ kind: 'match', name: 'WTF' })
  })

  it('lets an exact match win over a longer command it prefixes', () => {
    // Future-proofing: a full command must never be shadowed by a longer one.
    expect(resolveCommand('scan', ['scan', 'scanner'])).toEqual({
      kind: 'match',
      name: 'scan',
    })
  })

  it('resolves a unique prefix to its full command', () => {
    expect(resolveCommand('jo')).toEqual({ kind: 'match', name: 'join' })
    expect(resolveCommand('w')).toEqual({ kind: 'match', name: 'whoami' })
    expect(resolveCommand('sy')).toEqual({ kind: 'match', name: 'sync' })
    expect(resolveCommand('o')).toEqual({ kind: 'match', name: 'org' })
    expect(resolveCommand('or')).toEqual({ kind: 'match', name: 'org' })
    expect(resolveCommand('org')).toEqual({ kind: 'match', name: 'org' })
    expect(resolveCommand('co')).toEqual({ kind: 'match', name: 'config' })
    expect(resolveCommand('con')).toEqual({ kind: 'match', name: 'config' })
    expect(resolveCommand('ch')).toEqual({ kind: 'match', name: 'chat' })
    expect(resolveCommand('sc')).toEqual({ kind: 'match', name: 'scout' })
    // `ha` is unambiguous again: the scout feed became `scout search`, so
    // `hacker` is the only `ha…` top-level command.
    expect(resolveCommand('ha')).toEqual({ kind: 'match', name: 'hacker' })
    // `book` is the only `b…` command (brag became `project`), so bare `b`
    // resolves straight to it.
    expect(resolveCommand('b')).toEqual({ kind: 'match', name: 'book' })
  })

  it('reports every match for an ambiguous prefix', () => {
    expect(resolveCommand('c')).toEqual({
      kind: 'ambiguous',
      matches: ['config', 'chat'],
    })
    // `s` stopped being sync shorthand when scout landed — ambiguity is the
    // honest answer, not a silent guess.
    expect(resolveCommand('s')).toEqual({
      kind: 'ambiguous',
      matches: ['sync', 'scout'],
    })
  })

  it('returns unknown for a token that is not a prefix of any command', () => {
    expect(resolveCommand('xyz')).toEqual({ kind: 'unknown' })
    expect(resolveCommand('ogr')).toEqual({ kind: 'unknown' })
  })
})
