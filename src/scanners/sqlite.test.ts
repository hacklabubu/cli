import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { num, queryDb, str } from './sqlite.js'

const require = createRequire(import.meta.url)

// Build a real on-disk SQLite file with sql.js (no `sqlite3` binary needed), then
// read it back through queryDb — the same path the scanners use on every OS,
// including Windows where a `sqlite3` CLI is absent.
let dir: string

async function makeDb(statements: string[]): Promise<string> {
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
  })
  const db = new SQL.Database()
  for (const s of statements) db.run(s)
  const bytes = db.export()
  db.close()
  const path = join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`)
  writeFileSync(path, Buffer.from(bytes))
  return path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hacklab-sqlite-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('queryDb', () => {
  it('returns typed rows (numbers stay numbers, blanks stay strings)', async () => {
    const path = await makeDb([
      'create table t(a int, b text)',
      "insert into t values (5, 'hi'), (7, '')",
    ])
    const rows = await queryDb(path, 'select a, b from t order by a')
    expect(rows).toEqual([
      [5, 'hi'],
      [7, ''],
    ])
    expect(typeof rows[0]![0]).toBe('number')
  })

  it('evaluates json_extract (JSON1 ships with sql.js) — the OpenCode query shape', async () => {
    const path = await makeDb([
      'create table message(data text)',
      `insert into message values ('{"role":"assistant","modelID":"opus","time":{"created":1737000000000},"tokens":{"input":10,"output":20,"cache":{"read":3,"write":1},"reasoning":2}}')`,
      `insert into message values ('{"role":"user","tokens":{"input":1}}')`,
    ])
    const rows = await queryDb(
      path,
      `SELECT json_extract(data,'$.time.created'), coalesce(json_extract(data,'$.modelID'),''), coalesce(json_extract(data,'$.tokens.input'),0), coalesce(json_extract(data,'$.tokens.output'),0), coalesce(json_extract(data,'$.tokens.cache.read'),0), coalesce(json_extract(data,'$.tokens.cache.write'),0), coalesce(json_extract(data,'$.tokens.reasoning'),0) FROM message WHERE json_extract(data,'$.role')='assistant'`
    )
    expect(rows).toHaveLength(1)
    const [time, model, inp, out, cr, cw, reason] = rows[0]!
    expect(num(time)).toBe(1737000000000)
    expect(str(model)).toBe('opus')
    expect(num(inp) + num(out) + num(cr) + num(cw) + num(reason)).toBe(36)
  })

  it('returns [] for a query that yields no rows', async () => {
    const path = await makeDb(['create table t(a int)'])
    expect(await queryDb(path, 'select a from t')).toEqual([])
  })

  it('rejects when the file does not exist (callers degrade to empty)', async () => {
    await expect(
      queryDb(join(dir, 'nope.sqlite'), 'select 1')
    ).rejects.toThrow()
  })
})

describe('num / str coercion', () => {
  it('num parses numbers and numeric strings, defaults others to 0', () => {
    expect(num(42)).toBe(42)
    expect(num('3.5')).toBe(3.5)
    expect(num('')).toBe(0)
    expect(num(null)).toBe(0)
    expect(num(undefined)).toBe(0)
  })

  it('str passes strings, stringifies numbers, defaults others to ""', () => {
    expect(str('hi')).toBe('hi')
    expect(str(9)).toBe('9')
    expect(str(null)).toBe('')
    expect(str(undefined)).toBe('')
  })
})
