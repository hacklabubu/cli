import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import protobuf from 'protobufjs/minimal.js'
import initSqlJs from 'sql.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => home.dir,
}))

import {
  antigravityTokenFiles,
  parseAntigravityUsage,
  scanAntigravity,
} from './antigravity.js'
import {
  githubCopilotTokenFiles,
  githubCopilotVsCodeWorkspaceStorageRoots,
  scanGitHubCopilot,
} from './github-copilot.js'
import type { TickSources } from './incremental.js'
import {
  loadScanState,
  markUploaded,
  runTick,
  saveScanState,
  stageFullScan,
  tickPayload,
} from './incremental.js'

const firstAt = '2026-09-16T12:00:00.000Z'
const secondAt = '2026-09-17T12:00:00.000Z'
const conversation = '7e1b0c0a-4c8c-42e3-8f26-d6e169fb9a6e'
const line = (value: unknown) => `${JSON.stringify(value)}\n`

function shutdown(at: string, input: number, output: number, count: number) {
  const metric = {
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
    },
    requests: { count },
  }
  return line({
    type: 'session.shutdown',
    timestamp: at,
    data: {
      modelMetrics: { 'claude-sonnet-4.6': metric },
      agentMetrics: { main: { modelMetrics: { 'claude-sonnet-4.6': metric } } },
      currentTokens: 999999,
    },
  })
}

function metadata(responseId: string, at = firstAt): Uint8Array {
  const timestamp = protobuf.Writer.create()
    .uint32(8)
    .uint64(Date.parse(at) / 1000)
    .finish()
  const usage = protobuf.Writer.create()
    .uint32(8)
    .uint32(1318)
    .uint32(16)
    .uint32(100)
    .uint32(24)
    .uint32(30)
    .uint32(40)
    .uint32(200)
    .uint32(72)
    .uint32(20)
    .uint32(80)
    .uint32(10)
    .uint32(90)
    .string(responseId)
    .finish()
  return protobuf.Writer.create()
    .uint32(10)
    .bytes(timestamp)
    .uint32(74)
    .bytes(usage)
    .finish()
}

async function put(path: string, content: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function conversationDb(root: string, rows: Array<[number, Uint8Array]>) {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  try {
    db.run(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)'
    )
    for (const [idx, blob] of rows)
      db.run('INSERT INTO steps VALUES (?, 15, ?)', [idx, blob])
    await put(
      join(home.dir, '.gemini', root, 'conversations', `${conversation}.db`),
      db.export()
    )
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  home.dir = await mkdtemp(join(tmpdir(), 'hacklab-harness-tokens-'))
  vi.stubEnv('COPILOT_HOME', join(home.dir, '.copilot'))
  vi.stubEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', '')
  vi.stubEnv('XDG_CONFIG_HOME', join(home.dir, '.config'))
  vi.stubEnv('APPDATA', join(home.dir, 'AppData', 'Roaming'))
  vi.stubEnv('HACKLAB_SESSION_PATH', join(home.dir, '.hacklab', 'session.json'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home.dir, { recursive: true, force: true })
})

describe('harness token accounting', () => {
  it('counts resumed Copilot growth on its date without cache, agent, or replay duplication', async () => {
    const content =
      line({
        type: 'session.start',
        data: { sessionId: 'canonical-session' },
      }) +
      shutdown(firstAt, 100, 50, 2) +
      shutdown(secondAt, 130, 70, 3) +
      shutdown(secondAt, 130, 70, 3) +
      line({
        type: 'assistant.usage',
        timestamp: secondAt,
        data: { inputTokens: 999999 },
      })
    await put(
      join(home.dir, '.copilot', 'session-state', 'original', 'events.jsonl'),
      content
    )
    await put(
      join(home.dir, '.copilot', 'session-state', 'copy', 'events.jsonl'),
      content
    )
    const scan = await scanGitHubCopilot()
    expect(scan.models).toEqual({ 'claude-sonnet-4.6': 200 })
    expect(scan.daily).toEqual([
      {
        tool: 'github_copilot',
        date: '2026-09-16',
        model: 'claude-sonnet-4.6',
        tokens: 150,
        messages: 2,
      },
      {
        tool: 'github_copilot',
        date: '2026-09-17',
        model: 'claude-sonnet-4.6',
        tokens: 50,
        messages: 1,
      },
    ])
  })

  it('reconciles shutdowns with file/DB traces, retaining BYOK models but not delegated harnesses', async () => {
    const span = (
      id: string,
      parent: string,
      session: string,
      agent: string,
      operation: string,
      input: number,
      output: number,
      at = secondAt
    ) => ({
      traceId: 'trace',
      spanId: id,
      parentSpanId: parent,
      endTime: [Date.parse(at) / 1000, 0] as const,
      attributes: {
        'gen_ai.operation.name': operation,
        'gen_ai.agent.name': agent === 'id-only' ? '' : agent,
        'gen_ai.agent.id': agent === 'id-only' ? 'github.copilot.default' : '',
        'gen_ai.conversation.id': session,
        'gen_ai.response.model': 'claude-sonnet-4.6',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.usage.input_tokens': input,
        'gen_ai.usage.output_tokens': output,
        'gen_ai.usage.cache_read.input_tokens': 5,
      },
    })
    const spans = [
      span('root', '', 'session', 'id-only', 'invoke_agent', 9999, 9999),
      span('before', 'root', 'session', '', 'chat', 100, 50, firstAt),
      span('resumed', 'root', 'session', '', 'chat', 20, 10),
      span(
        'byok',
        '',
        'vscode',
        'GitHub Copilot Chat',
        'invoke_agent',
        9999,
        9999
      ),
      span('byok-call', 'byok', 'vscode', '', 'chat', 10, 5),
      span(
        'delegate',
        'root',
        'delegate',
        'claude',
        'invoke_agent',
        9999,
        9999
      ),
      span('delegate-call', 'delegate', 'delegate', '', 'chat', 1000, 500),
      span('orphan', 'unfinished-owner', 'unknown', '', 'chat', 1000, 500),
    ]
    const contents = `${spans.map(line).join('')}{}\n`
    const [workspaceRoot] = githubCopilotVsCodeWorkspaceStorageRoots()
    if (!workspaceRoot) throw new Error('test needs a supported desktop OS')
    const outfile = join(home.dir, 'copilot-export.jsonl')
    await put(
      join(dirname(workspaceRoot), 'settings.json'),
      `{// JSONC comments and trailing commas are supported.\n"github.copilot.chat.otel.outfile":${JSON.stringify(outfile)},\n}`
    )
    await put(outfile, contents)
    await put(join(home.dir, '.copilot', 'otel', 'copy.jsonl'), contents)
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    try {
      db.run(`CREATE TABLE spans(span_id TEXT, trace_id TEXT, parent_span_id TEXT,
        end_time_ms INTEGER, operation_name TEXT, agent_name TEXT, conversation_id TEXT,
        chat_session_id TEXT, response_model TEXT, request_model TEXT, input_tokens INTEGER, output_tokens INTEGER)`)
      db.run('CREATE TABLE span_attributes(span_id TEXT, key TEXT, value TEXT)')
      for (const record of spans) {
        const a = record.attributes
        db.run('INSERT INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
          record.spanId,
          record.traceId,
          record.parentSpanId,
          record.endTime[0] * 1000,
          a['gen_ai.operation.name'],
          a['gen_ai.agent.name'],
          a['gen_ai.conversation.id'],
          null,
          a['gen_ai.response.model'],
          null,
          a['gen_ai.usage.input_tokens'],
          a['gen_ai.usage.output_tokens'],
        ])
        db.run('INSERT INTO span_attributes VALUES (?, ?, ?)', [
          record.spanId,
          'gen_ai.agent.id',
          a['gen_ai.agent.id'],
        ])
      }
      await put(
        join(
          dirname(workspaceRoot),
          'globalStorage',
          'github.copilot-chat',
          'agent-traces.db'
        ),
        db.export()
      )
    } finally {
      db.close()
    }
    const path = join(
      home.dir,
      '.copilot',
      'session-state',
      'session',
      'events.jsonl'
    )
    await put(path, shutdown(firstAt, 100, 50, 2))
    expect((await scanGitHubCopilot()).models).toEqual({
      'claude-sonnet-4.6': 195,
    })
    await appendFile(path, shutdown('2026-09-17T12:00:01.000Z', 120, 60, 3))
    expect((await scanGitHubCopilot()).models).toEqual({
      'claude-sonnet-4.6': 195,
    })
  })

  it('counts uncached plus cached input and total output once across Antigravity CLI/GUI copies', async () => {
    await conversationDb('antigravity', [[1, metadata('response-a')]])
    await conversationDb('antigravity-cli', [
      [1, metadata('response-a')],
      [2, metadata('response-b', secondAt)],
    ])
    const scan = await scanAntigravity()
    expect(scan.models).toEqual({ 'antigravity-model-1318': 660 })
    expect(scan.daily).toEqual([
      {
        tool: 'antigravity',
        date: '2026-09-16',
        model: 'antigravity-model-1318',
        tokens: 330,
        messages: 1,
      },
      {
        tool: 'antigravity',
        date: '2026-09-17',
        model: 'antigravity-model-1318',
        tokens: 330,
        messages: 1,
      },
    ])
    expect(
      parseAntigravityUsage(metadata('response-a').slice(0, -1))
    ).toBeNull()
  })

  it('replaces cumulative snapshots on ticks and full rebases without requiring prompt consent', async () => {
    const path = join(
      home.dir,
      '.copilot',
      'session-state',
      'session',
      'events.jsonl'
    )
    await put(path, shutdown(firstAt, 100, 50, 2))
    await conversationDb('antigravity-cli', [[1, metadata('response-a')]])
    const sources: TickSources = {
      jsonl: [],
      codex: { files: async () => [], dateFor: () => null },
      sqlite: [],
      prompts: [],
      snapshots: [
        {
          tool: 'github_copilot',
          files: githubCopilotTokenFiles,
          scan: scanGitHubCopilot,
        },
        {
          tool: 'antigravity',
          files: antigravityTokenFiles,
          scan: scanAntigravity,
        },
      ],
    }
    let tick = await runTick(await loadScanState(), sources, {
      promptActivity: false,
    })
    let payload = tickPayload(tick.state)
    expect(payload.toolTotals.github_copilot).toBe(150)
    expect(payload.toolTotals.antigravity).toBe(330)
    expect(payload.promptActivity).toBeUndefined()
    markUploaded(tick.state)
    await appendFile(path, shutdown(secondAt, 130, 70, 3))
    tick = await runTick(tick.state, sources, { promptActivity: false })
    payload = tickPayload(tick.state)
    expect(payload.toolTotals.github_copilot).toBe(200)
    expect(payload.dailyTotals.reduce((sum, row) => sum + row.tokens, 0)).toBe(
      50
    )
    markUploaded(tick.state)
    await saveScanState(tick.state)
    const scans = await Promise.all([scanGitHubCopilot(), scanAntigravity()])
    const rebased = await stageFullScan(scans, { scanned: null }, sources)
    await rebased.commit()
    const repeated = await runTick(await loadScanState(), sources, {
      promptActivity: false,
    })
    expect(tickPayload(repeated.state).toolTotals.github_copilot).toBe(200)
    expect(tickPayload(repeated.state).toolTotals.antigravity).toBe(330)
  })
})
