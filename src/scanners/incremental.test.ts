import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cumulativeTotals,
  emptyState,
  loadScanState,
  markUploaded,
  readCompleteLines,
  rebuildScanState,
  runTick,
  sameTotals,
  saveScanState,
  scanStatePath,
  type TickSources,
  tickPayload,
} from './incremental.js'
import { parseClaudeCodeLine, type ScanResult } from './index.js'
import { findFiles } from './util.js'

// The tick is the only scanner that carries state between runs, so what's under
// test here is exactly the state machine: what it re-reads, what it re-uploads,
// and what it refuses to trust.

let dir: string
let sessionPath: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hacklab-tick-'))
  sessionPath = process.env.HACKLAB_SESSION_PATH
  process.env.HACKLAB_SESSION_PATH = join(dir, 'session.json')
})

afterEach(async () => {
  if (sessionPath === undefined) delete process.env.HACKLAB_SESSION_PATH
  else process.env.HACKLAB_SESSION_PATH = sessionPath
  await rm(dir, { recursive: true, force: true })
})

const today = new Date().toISOString().slice(0, 10)

/** A Claude Code usage line, timestamped now (so it lands in today's bucket). */
function usageLine(tokens: number, model = 'opus'): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: { model, usage: { input_tokens: tokens, output_tokens: 0 } },
  })}\n`
}

/** Sources with one JSONL harness rooted at a tmp dir, nothing else. */
function sources(over: Partial<TickSources> = {}): TickSources {
  return {
    jsonl: [
      {
        tool: 'claude_code',
        files: () => findFiles(dir, '.jsonl'),
        parse: parseClaudeCodeLine,
      },
    ],
    codex: { files: async () => [], dateFor: () => null },
    sqlite: [],
    ...over,
  }
}

const tokensOf = (
  state: Awaited<ReturnType<typeof runTick>>['state'],
  tool = 'claude_code'
) => cumulativeTotals(state).toolTotals[tool] ?? 0

describe('runTick — tailing JSONL logs', () => {
  it('reads everything on a cold start but marks nothing dirty', async () => {
    // Those tokens are already on the server (the daily job put them there):
    // re-uploading every date would only invite the reconcile to prune rows a
    // partial scan can't see.
    await writeFile(join(dir, 'a.jsonl'), usageLine(100))

    const { state, changed } = await runTick(null, sources())

    expect(tokensOf(state)).toBe(100)
    expect(state.dirty).toEqual([])
    expect(changed).toBe(true)
  })

  it('adds appended lines to the aggregate and dirties their date', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, usageLine(100))
    const first = await runTick(null, sources())

    await appendFile(file, usageLine(40))
    const second = await runTick(first.state, sources())

    expect(tokensOf(second.state)).toBe(140)
    expect(second.state.dirty).toEqual([today])
  })

  it('does no work at all when nothing moved', async () => {
    await writeFile(join(dir, 'a.jsonl'), usageLine(100))
    const first = await runTick(null, sources())

    const second = await runTick(first.state, sources())

    expect(second.changed).toBe(false)
    expect(second.state.dirty).toEqual([])
    expect(tokensOf(second.state)).toBe(100)
  })

  it('stops at the last complete line and picks the rest up later', async () => {
    // A harness can be mid-append when the tick looks; counting half a line
    // (and then the other half next minute) would corrupt both.
    const file = join(dir, 'a.jsonl')
    const complete = usageLine(100)
    const partial = usageLine(40).slice(0, -5)
    await writeFile(file, complete + partial)

    const first = await runTick(null, sources())
    expect(tokensOf(first.state)).toBe(100)
    expect(first.state.harnesses.claude_code?.files[file]?.offset).toBe(
      Buffer.byteLength(complete)
    )

    // The writer finishes the line.
    await writeFile(file, complete + usageLine(40))
    const second = await runTick(first.state, sources())
    expect(tokensOf(second.state)).toBe(140)
  })

  it('reads a brand-new file from the start', async () => {
    await writeFile(join(dir, 'a.jsonl'), usageLine(100))
    const first = await runTick(null, sources())

    await writeFile(join(dir, 'b.jsonl'), usageLine(7))
    const second = await runTick(first.state, sources())

    expect(tokensOf(second.state)).toBe(107)
    expect(second.state.dirty).toEqual([today])
  })

  it('re-reads the whole harness when a file shrinks', async () => {
    // We know what the files contributed in total but not which file
    // contributed what, so there's nothing to subtract — only a re-read.
    const file = join(dir, 'a.jsonl')
    await writeFile(file, usageLine(100) + usageLine(100))
    const first = await runTick(null, sources())
    expect(tokensOf(first.state)).toBe(200)

    await writeFile(file, usageLine(10))
    const second = await runTick(first.state, sources())

    expect(tokensOf(second.state)).toBe(10)
    expect(second.state.dirty).toEqual([today])
  })

  it('re-reads the whole harness when a file disappears', async () => {
    const gone = join(dir, 'a.jsonl')
    await writeFile(gone, usageLine(100))
    await writeFile(join(dir, 'b.jsonl'), usageLine(30))
    const first = await runTick(null, sources())
    expect(tokensOf(first.state)).toBe(130)

    await rm(gone)
    const second = await runTick(first.state, sources())

    expect(tokensOf(second.state)).toBe(30)
    expect(second.state.harnesses.claude_code?.files[gone]).toBeUndefined()
    expect(second.state.dirty).toEqual([today])
  })

  it('leaves untouched dates alone when a harness is re-read', async () => {
    // Only what actually moved gets re-uploaded — a rotated log must not
    // re-send the user's entire history.
    const stable = `${JSON.stringify({
      timestamp: '2026-01-02T10:00:00.000Z',
      message: { model: 'opus', usage: { input_tokens: 5, output_tokens: 0 } },
    })}\n`
    await writeFile(join(dir, 'old.jsonl'), stable)
    const doomed = join(dir, 'new.jsonl')
    await writeFile(doomed, usageLine(100))
    const first = await runTick(null, sources())

    await writeFile(doomed, usageLine(1))
    const second = await runTick(first.state, sources())

    expect(second.state.dirty).toEqual([today])
    expect(tokensOf(second.state)).toBe(6)
  })
})

describe('runTick — Codex running totals', () => {
  const codexLine = (total: number, model = 'gpt-5') =>
    `${JSON.stringify({
      payload: { model, info: { total_token_usage: { input_tokens: total } } },
    })}\n`

  const codexSources = (): TickSources =>
    sources({
      jsonl: [],
      codex: { files: () => findFiles(dir, '.jsonl'), dateFor: () => today },
    })

  it('counts only the growth of a file’s running total', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, codexLine(100) + codexLine(300))
    const first = await runTick(null, codexSources())
    expect(tokensOf(first.state, 'codex')).toBe(300)

    await appendFile(file, codexLine(450))
    const second = await runTick(first.state, codexSources())

    // 450, not 300 + 450 — Codex reports totals, not deltas.
    expect(tokensOf(second.state, 'codex')).toBe(450)
    expect(second.state.harnesses.codex?.codexTotals?.[file]?.maxTotal).toBe(
      450
    )
  })

  it('counts a session once, however many times it grows', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, codexLine(100))
    const first = await runTick(null, codexSources())
    await appendFile(file, codexLine(200))
    const second = await runTick(first.state, codexSources())

    expect(second.state.harnesses.codex?.daily[`${today}|gpt-5`]).toEqual({
      tokens: 200,
      messages: 1,
    })
  })

  it('ignores an appended chunk that lowers the total', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, codexLine(500))
    const first = await runTick(null, codexSources())
    await appendFile(file, codexLine(10))
    const second = await runTick(first.state, codexSources())

    expect(tokensOf(second.state, 'codex')).toBe(500)
    expect(second.state.dirty).toEqual([])
  })
})

describe('runTick — SQLite harnesses', () => {
  const result = (tokens: number): ScanResult => ({
    tool: 'hermes',
    daily: [{ date: today, tool: 'hermes', tokens, messages: 1, model: 'h' }],
    hourly: [],
    models: { h: tokens },
  })

  it('re-queries only when the db or its -wal moved', async () => {
    const dbPath = join(dir, 'state.db')
    await writeFile(dbPath, 'x')
    const scan = vi.fn(async () => result(50))
    const src = sources({
      jsonl: [],
      sqlite: [{ tool: 'hermes', dbPath: () => dbPath, scan }],
    })

    const first = await runTick(null, src)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(tokensOf(first.state, 'hermes')).toBe(50)

    // Nothing touched the db: the query is skipped entirely.
    const second = await runTick(first.state, src)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(second.changed).toBe(false)

    // A checkpoint-less write lands in the -wal, which the db's own mtime
    // wouldn't show.
    scan.mockResolvedValue(result(90))
    await writeFile(`${dbPath}-wal`, 'w')
    const third = await runTick(second.state, src)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(tokensOf(third.state, 'hermes')).toBe(90)
    expect(third.state.dirty).toEqual([today])
  })
})

describe('scan-state persistence', () => {
  it('drops hourly buckets that fell out of the 90-day window', async () => {
    const state = emptyState()
    state.harnesses.claude_code = {
      files: {},
      daily: {},
      hourly: {
        '2000-01-01|9|opus': { tokens: 10, messages: 1 },
        [`${today}|9|opus`]: { tokens: 20, messages: 1 },
      },
      models: {},
    }

    await saveScanState(state)
    const loaded = await loadScanState()

    expect(Object.keys(loaded?.harnesses.claude_code?.hourly ?? {})).toEqual([
      `${today}|9|opus`,
    ])
  })

  it('treats a state from another version as no state at all', async () => {
    const state = emptyState()
    state.version = 99
    await writeFile(scanStatePath(), JSON.stringify(state))

    expect(await loadScanState()).toBeNull()
  })

  it('treats an unreadable state as no state at all', async () => {
    await writeFile(scanStatePath(), '{ this is not json')

    expect(await loadScanState()).toBeNull()
  })
})

describe('tickPayload', () => {
  const state = () => {
    const s = emptyState()
    s.harnesses.claude_code = {
      files: {},
      daily: {
        '2026-03-01|opus': { tokens: 10, messages: 1 },
        '2026-03-02|opus': { tokens: 20, messages: 2 },
      },
      hourly: {
        '2026-03-01|9|opus': { tokens: 10, messages: 1 },
        '2026-03-02|9|opus': { tokens: 20, messages: 2 },
      },
      models: { opus: 30 },
    }
    // Cursor is never scanned by a tick — it's carried over from the last full
    // scan so a dirty date still goes out complete.
    s.harnesses.cursor = {
      files: {},
      daily: { '2026-03-02|': { tokens: 7, messages: 1 } },
      hourly: {},
      models: {},
    }
    s.dirty = ['2026-03-02']
    return s
  }

  it('sends only the dirty dates, but every harness for them', async () => {
    const payload = tickPayload(state())

    expect(payload.dailyTotals).toEqual(
      expect.arrayContaining([
        {
          date: '2026-03-02',
          tool: 'claude_code',
          tokens: 20,
          messages: 2,
          model: 'opus',
        },
        {
          date: '2026-03-02',
          tool: 'cursor',
          tokens: 7,
          messages: 1,
          model: undefined,
        },
      ])
    )
    expect(payload.dailyTotals).toHaveLength(2)
    expect(payload.hourlyTotals).toEqual([
      {
        date: '2026-03-02',
        hour: 9,
        tool: 'claude_code',
        model: 'opus',
        tokens: 20,
        messages: 2,
      },
    ])
  })

  it('always sends the full cumulative totals', async () => {
    // The server diffs these against its own per-machine snapshot, so they have
    // to cover every date — including Cursor, which the tick can't rescan.
    const payload = tickPayload(state())

    expect(payload.toolTotals).toEqual({ claude_code: 30, cursor: 7 })
    expect(payload.modelTotals).toEqual({ opus: 30 })
  })
})

describe('cumulative bookkeeping', () => {
  it('sameTotals ignores keys that are zero on both sides', () => {
    expect(sameTotals({ a: 1 }, { a: 1, b: 0 })).toBe(true)
    expect(sameTotals({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('markUploaded clears the dirty set and the error suppression', () => {
    const state = emptyState()
    state.harnesses.claude_code = {
      files: {},
      daily: { [`${today}|opus`]: { tokens: 5, messages: 1 } },
      hourly: {},
      models: { opus: 5 },
    }
    state.dirty = [today]
    state.lastError = 'tick error: boom'
    state.nextAllowedAt = 123

    markUploaded(state)

    expect(state.dirty).toEqual([])
    expect(state.uploaded.toolTotals).toEqual({ claude_code: 5 })
    expect(state.lastError).toBeUndefined()
    expect(state.nextAllowedAt).toBeUndefined()
  })
})

describe('rebuildScanState', () => {
  it('re-bases the state on a full scan, leaving nothing dirty', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, usageLine(100))
    const scanned: ScanResult = {
      tool: 'claude_code',
      daily: [
        {
          date: today,
          tool: 'claude_code',
          tokens: 100,
          messages: 1,
          model: 'opus',
        },
      ],
      hourly: [],
      models: { opus: 100 },
    }

    await rebuildScanState([scanned], sources())
    const state = await loadScanState()

    expect(state?.dirty).toEqual([])
    expect(state?.uploaded.toolTotals.claude_code).toBe(100)
    // Offsets sit at EOF, so the next tick only sees what comes after.
    expect(state?.harnesses.claude_code?.files[file]?.offset).toBe(
      Buffer.byteLength(usageLine(100))
    )

    await appendFile(file, usageLine(5))
    const { state: ticked } = await runTick(state, sources())
    expect(tokensOf(ticked)).toBe(105)
  })
})

describe('readCompleteLines', () => {
  it('never splits a multi-byte character', async () => {
    const file = join(dir, 'utf8.jsonl')
    await writeFile(file, '{"a":"日本語"}\n{"b":"partial')

    const { text, offset } = await readCompleteLines(file, 0, 1000)

    expect(text).toBe('{"a":"日本語"}')
    expect(offset).toBe(Buffer.byteLength('{"a":"日本語"}\n'))
  })
})
