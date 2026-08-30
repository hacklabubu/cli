import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parsePromptLine } from '../prompt-stats.js'
import {
  cumulativeTotals,
  emptyState,
  hasPromptActivity,
  loadScanState,
  markUploaded,
  PROMPT_SESSION_RETENTION_DAYS,
  readCompleteLines,
  runTick,
  sameTotals,
  saveScanState,
  scanStatePath,
  stageFullScan,
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

/** A Claude Code user prompt, as the transcript records one. */
function promptLine(
  text: string,
  sessionId = 's1',
  timestamp = new Date().toISOString()
): string {
  return `${JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { content: text },
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
        parsePrompt: parsePromptLine,
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
  it('drops prompt sessions that aged out of the retention window', async () => {
    const stale = new Date(
      Date.now() - (PROMPT_SESSION_RETENTION_DAYS + 5) * 86_400_000
    ).toISOString()
    const state = emptyState()
    state.prompts.sessions = {
      old: { startedAt: stale, lastActiveAt: stale, promptCount: 3 },
      fresh: {
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        promptCount: 1,
      },
    }
    // An unsent row goes with it: a dirty list that only ever grows is the
    // failure mode this prune exists to prevent.
    state.prompts.dirtySessions = ['old', 'fresh']

    await saveScanState(state)
    const loaded = await loadScanState()

    expect(Object.keys(loaded?.prompts.sessions ?? {})).toEqual(['fresh'])
    expect(loaded?.prompts.dirtySessions).toEqual(['fresh'])
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
      models: { opus: 30 },
    }
    // Cursor is never scanned by a tick — it's carried over from the last full
    // scan so a dirty date still goes out complete.
    s.harnesses.cursor = {
      files: {},
      daily: { '2026-03-02|': { tokens: 7, messages: 1 } },
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

describe('stageFullScan', () => {
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
      models: { opus: 100 },
    }

    const staged = await stageFullScan([scanned], { scanned: null }, sources())
    await staged.commit()
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

// Prompt activity rides the same tail-read as tokens, but on the opposite
// contract: the server upserts it with GREATEST semantics per (machine,
// session) and (machine, date), so a resend is free and the dirty sets can be
// drained a capped batch at a time.
describe('runTick — prompt activity', () => {
  it('counts prompts from the same tail-read that counts tokens', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, usageLine(100))
    const first = await runTick(null, sources())

    await appendFile(file, promptLine('fix the auth bug please'))
    const { state } = await runTick(first.state, sources())

    expect(state.prompts.sessions.s1).toMatchObject({ promptCount: 1 })
    expect(state.prompts.daily[today]).toEqual({ prompts: 1, words: 5 })
    expect(state.prompts.dirtySessions).toEqual(['s1'])
    expect(state.prompts.dirtyDates).toEqual([today])
    expect(hasPromptActivity(state)).toBe(true)
  })

  it('widens a session rather than duplicating it', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(
      file,
      promptLine('later one', 's1', '2026-03-02T12:00:00.000Z')
    )
    const first = await runTick(null, sources())

    await appendFile(
      file,
      promptLine('even later', 's1', '2026-03-02T13:00:00.000Z')
    )
    const { state } = await runTick(first.state, sources())

    expect(state.prompts.sessions.s1).toEqual({
      startedAt: '2026-03-02T12:00:00.000Z',
      lastActiveAt: '2026-03-02T13:00:00.000Z',
      promptCount: 2,
    })
  })

  it('marks everything dirty on a cold start', async () => {
    // Unlike tokens, prompt rows are idempotent upserts and a cold start is
    // exactly the case where nothing proves they ever reached the server.
    await writeFile(join(dir, 'a.jsonl'), promptLine('hello there'))

    const { state } = await runTick(null, sources())

    expect(state.dirty).toEqual([])
    expect(state.prompts.dirtySessions).toEqual(['s1'])
    expect(state.prompts.dirtyDates).toEqual([today])
  })

  it('rebuilds rather than double-counts when the tail is invalidated', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, promptLine('one two three') + promptLine('four five'))
    const first = await runTick(null, sources())
    expect(first.state.prompts.sessions.s1?.promptCount).toBe(2)

    // The file shrank: the whole harness is re-read, prompts included.
    await writeFile(file, promptLine('one two three'))
    const { state } = await runTick(first.state, sources())

    expect(state.prompts.sessions.s1?.promptCount).toBe(1)
    expect(state.prompts.daily[today]).toEqual({ prompts: 1, words: 3 })
  })

  it('ignores lines that are not the person typing', async () => {
    const toolResult = `${JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    })}\n`
    await writeFile(join(dir, 'a.jsonl'), toolResult)

    const { state } = await runTick(null, sources())

    expect(state.prompts.sessions).toEqual({})
  })
})

describe('tickPayload — promptActivity', () => {
  const withPrompts = (sessionCount: number) => {
    const s = emptyState()
    for (let i = 0; i < sessionCount; i++) {
      const id = `s${String(i).padStart(4, '0')}`
      const at = new Date(Date.parse('2026-03-02T00:00:00.000Z') + i * 1000)
      s.prompts.sessions[id] = {
        startedAt: at.toISOString(),
        lastActiveAt: at.toISOString(),
        promptCount: 1,
      }
      s.prompts.dirtySessions.push(id)
    }
    s.prompts.daily['2026-03-02'] = { prompts: sessionCount, words: 10 }
    s.prompts.dirtyDates.push('2026-03-02')
    return s
  }

  it('is left out entirely unless the tier asked for it', () => {
    const state = withPrompts(1)
    expect(tickPayload(state).promptActivity).toBeUndefined()
  })

  it('sends the outstanding sessions and dates', () => {
    const payload = tickPayload(withPrompts(2), { promptActivity: true })

    expect(payload.promptActivity?.sessions).toHaveLength(2)
    expect(payload.promptActivity?.dailyPrompts).toEqual([
      { date: '2026-03-02', prompts: 2, words: 10 },
    ])
  })

  it('caps a backlog at 500 sessions, newest first, keeping the rest dirty', () => {
    const state = withPrompts(520)

    const payload = tickPayload(state, { promptActivity: true })
    expect(payload.promptActivity?.sessions).toHaveLength(500)
    // Most recently active first, so the work the user cares about syncs first.
    expect(payload.promptActivity?.sessions[0]?.sessionId).toBe('s0519')

    markUploaded(state)
    expect(state.prompts.dirtySessions).toHaveLength(20)
    expect(state.prompts.dirtyDates).toEqual([])
  })

  it('reads a dirty id with no row behind it as nothing to send', () => {
    // Otherwise the tick POSTs an empty block every minute forever: there'd be
    // nothing for markUploaded to clear, so the id would never go away.
    const state = emptyState()
    state.prompts.dirtySessions = ['pruned']
    state.prompts.dirtyDates = ['2020-01-01']

    expect(hasPromptActivity(state)).toBe(false)
  })

  it('drops a claim the tier no longer covers', () => {
    // A failed send under `stats`, then the user turns the tier down to `none`:
    // the next tick's success must not clear rows it never sent.
    const state = withPrompts(2)
    tickPayload(state, { promptActivity: true })

    tickPayload(state)
    markUploaded(state)

    expect(state.prompts.dirtySessions).toHaveLength(2)
  })

  it('keeps everything dirty when the upload never lands', () => {
    const state = withPrompts(3)
    tickPayload(state, { promptActivity: true })

    // No markUploaded: the POST failed, so the next tick has to resend.
    expect(state.prompts.dirtySessions).toHaveLength(3)
    const again = tickPayload(state, { promptActivity: true })
    expect(again.promptActivity?.sessions).toHaveLength(3)
  })
})

describe('stageFullScan — prompt activity', () => {
  const scanned: ScanResult = {
    tool: 'claude_code',
    daily: [],
    models: {},
  }

  // Inside the retention window, or `saveScanState` prunes it away first.
  const startedAt = new Date(Date.now() - 3_600_000).toISOString()
  const lastActiveAt = new Date().toISOString()

  it('dirties only what the full scan moved', async () => {
    const before = emptyState()
    before.prompts.sessions.s1 = { startedAt, lastActiveAt, promptCount: 4 }
    before.prompts.daily[today] = { prompts: 4, words: 40 }
    await saveScanState(before)

    const staged = await stageFullScan(
      [scanned],
      {
        scanned: {
          sessions: {
            // unchanged — the ticks already sent this one
            s1: { startedAt, lastActiveAt, promptCount: 4 },
            // new to the full scan
            s2: { startedAt, lastActiveAt, promptCount: 2 },
          },
          daily: { [today]: { prompts: 6, words: 55 } },
        },
      },
      sources()
    )

    // The difference rides out on this very upload — there may be no daemon to
    // drain it later.
    expect(staged.promptActivity?.sessions).toEqual([
      { sessionId: 's2', startedAt, lastActiveAt, promptCount: 2 },
    ])
    expect(staged.promptActivity?.dailyPrompts).toEqual([
      { date: today, prompts: 6, words: 55 },
    ])

    await staged.commit()
    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual([])
    expect(state?.prompts.dirtyDates).toEqual([])
    expect(state?.prompts.daily[today]).toEqual({ prompts: 6, words: 55 })
  })

  it('clears the claim only on a commit', async () => {
    // No commit means the POST never landed: everything has to still be there
    // for the next run to re-derive and resend.
    const before = emptyState()
    before.prompts.daily[today] = { prompts: 1, words: 5 }
    await saveScanState(before)

    const full = {
      scanned: {
        sessions: { s1: { startedAt, lastActiveAt, promptCount: 2 } },
        daily: { [today]: { prompts: 2, words: 11 } },
      },
    }

    const failed = await stageFullScan([scanned], full, sources())
    expect(failed.promptActivity?.sessions).toHaveLength(1)
    // ...upload throws here, so commit() is never called.

    const retry = await stageFullScan([scanned], full, sources())
    expect(retry.promptActivity).toEqual(failed.promptActivity)

    await retry.commit()
    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toEqual([])
  })

  it('holds back what the cap could not carry', async () => {
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i < 505; i++) {
      sessions[`s${String(i).padStart(4, '0')}`] = {
        startedAt,
        lastActiveAt: new Date(
          Date.parse(lastActiveAt) - i * 1000
        ).toISOString(),
        promptCount: 1,
      }
    }

    const staged = await stageFullScan(
      [scanned],
      {
        scanned: {
          sessions: sessions as never,
          daily: { [today]: { prompts: 505, words: 900 } },
        },
      },
      sources()
    )
    expect(staged.promptActivity?.sessions).toHaveLength(500)

    await staged.commit()
    const state = await loadScanState()
    expect(state?.prompts.dirtySessions).toHaveLength(5)
  })

  it('leaves the prompt state alone for a caller that never read prompts', async () => {
    // `hacklab scan` uploads tokens without resolving a consent tier. It must
    // not wipe what the tick accumulated, and must not send any of it either.
    const before = emptyState()
    before.prompts.sessions.s1 = { startedAt, lastActiveAt, promptCount: 4 }
    before.prompts.daily[today] = { prompts: 4, words: 40 }
    before.prompts.dirtySessions = ['s1']
    before.prompts.dirtyDates = [today]
    await saveScanState(before)

    const staged = await stageFullScan([scanned], 'untouched', sources())
    expect(staged.promptActivity).toBeUndefined()

    await staged.commit()
    const state = await loadScanState()
    expect(state?.prompts.sessions.s1?.promptCount).toBe(4)
    expect(state?.prompts.dirtySessions).toEqual(['s1'])
    expect(state?.prompts.dirtyDates).toEqual([today])
  })

  it('drops the prompt state entirely when the user is at the none tier', async () => {
    // Nothing conversational was read, so nothing conversational is kept.
    const before = emptyState()
    before.prompts.sessions.s1 = { startedAt, lastActiveAt, promptCount: 4 }
    before.prompts.dirtySessions = ['s1']
    await saveScanState(before)

    const staged = await stageFullScan([scanned], { scanned: null }, sources())
    await staged.commit()

    const state = await loadScanState()
    expect(state?.prompts.sessions).toEqual({})
    expect(state?.prompts.dirtySessions).toEqual([])
    expect(staged.promptActivity).toBeUndefined()
  })
})
