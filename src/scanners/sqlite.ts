import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import type { SqlValue } from 'sql.js'

// A tiny read-only SQLite reader backed by sql.js (pure WASM). We used to shell
// out to a `sqlite3` binary via execSync, but that binary is absent on stock
// Windows (and not guaranteed on macOS/Linux either), so every DB-backed scanner
// silently returned nothing there. sql.js needs no native build and ships JSON1,
// so the scanners' `json_extract` queries work unchanged on every platform.

const require = createRequire(import.meta.url)

// sql.js is CommonJS; the default export is the async `initSqlJs` factory.
let sqlPromise: Promise<import('sql.js').SqlJsStatic> | null = null

async function getSql(): Promise<import('sql.js').SqlJsStatic> {
  if (!sqlPromise) {
    const initSqlJs = (await import('sql.js')).default
    // Resolve the wasm from sql.js's own package so it works from a global
    // install (where sql.js is a direct dependency of hacklab) without the
    // build having to copy the asset into dist/.
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    sqlPromise = initSqlJs({ locateFile: () => wasmPath })
  }
  return sqlPromise
}

/**
 * Run a read-only query against a SQLite file and return its rows as typed value
 * arrays (numbers stay numbers, JSON `json_extract` values keep their JSON type).
 * The whole DB is loaded into memory — fine for the small local agent DBs we read.
 * Throws if the file can't be read; callers already degrade to an empty result.
 *
 * Reads only the main `.db` file, so rows still sitting in an un-checkpointed
 * `-wal` of a live DB are missed — the snapshot is consistent, just possibly a
 * bit stale. That matches how the old `sqlite3` shell-out behaved closely enough
 * for daily token totals.
 */
export async function queryDb(
  dbPath: string,
  sql: string
): Promise<SqlValue[][]> {
  const SQL = await getSql()
  const buf = await readFile(dbPath)
  const db = new SQL.Database(buf)
  try {
    const res = db.exec(sql)
    return res[0]?.values ?? []
  } finally {
    db.close()
  }
}

/** Coerce a SqlValue to a number (parses numeric strings; null/blobs → 0). */
export function num(v: SqlValue | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** Coerce a SqlValue to a string (null/blobs → ''); callers `.trim()` if needed. */
export function str(v: SqlValue | undefined): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}
