import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

import { queryDb } from './sqlite.js'
import { findFiles } from './util.js'

export type CopilotTelemetrySources = { files: string[]; databases: string[] }
export type CopilotInference = {
  sessionId: string
  model: string
  timestamp: string
  tokens: number
}

type Attributes = Record<string, unknown>
type Span = {
  traceId: string
  spanId: string
  parentSpanId: string
  endTime: number
  attributes: Attributes
}

function object(value: unknown): Attributes {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Attributes)
    : {}
}

/** Discover only Copilot-owned exports; never sweep generic agent telemetry. */
export async function copilotTelemetrySources(
  userDirs: string[]
): Promise<CopilotTelemetrySources> {
  const root = process.env.COPILOT_HOME || join(homedir(), '.copilot')
  const files = new Set(await findFiles(join(root, 'otel'), '.jsonl'))
  const explicit = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim()
  if (explicit) files.add(resolve(explicit))
  const databases = new Set<string>()
  for (const userDir of userDirs) {
    const settings = [
      join(userDir, 'settings.json'),
      ...(await findFiles(join(userDir, 'profiles'), 'settings.json')),
    ]
    for (const path of settings) {
      try {
        const config = object(parseJsonc(await readFile(path, 'utf8')))
        const outfile = config['github.copilot.chat.otel.outfile']
        if (typeof outfile === 'string' && outfile.trim())
          files.add(resolve(outfile.trim()))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(
            `Copilot telemetry settings unavailable: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
    const candidates = [
      ...(await findFiles(
        join(userDir, 'globalStorage', 'github.copilot-chat'),
        '.db'
      )),
      ...(await findFiles(join(userDir, 'profiles'), '.db')),
    ]
    for (const path of candidates) {
      if (
        /[\\/]globalStorage[\\/]github\.copilot-chat[\\/]agent-traces\.db$/i.test(
          path
        )
      )
        databases.add(path)
    }
  }
  return { files: [...files], databases: [...databases] }
}

function hrTime(value: unknown): number {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1]) ||
    value[0] < 0 ||
    value[1] < 0 ||
    value[1] >= 1_000_000_000
  )
    return NaN
  return value[0] * 1000 + Math.floor(value[1] / 1_000_000)
}

/** Direct ReadableSpan JSON from Copilot's file exporter, not aggregate metrics. */
function fileSpan(line: string): Span | null {
  try {
    const record = object(JSON.parse(line))
    const context = object(record._spanContext ?? record.spanContext)
    const parent = object(record.parentSpanContext)
    const traceId = record.traceId ?? context.traceId
    const spanId = record.spanId ?? context.spanId
    const parentSpanId = record.parentSpanId ?? parent.spanId ?? ''
    if (
      typeof traceId !== 'string' ||
      !traceId ||
      typeof spanId !== 'string' ||
      !spanId ||
      typeof parentSpanId !== 'string'
    )
      return null
    const endTime = hrTime(record.endTime)
    if (!Number.isFinite(endTime) || endTime <= 0) return null
    return {
      traceId,
      spanId,
      parentSpanId,
      endTime,
      attributes: object(record.attributes),
    }
  } catch {
    // Partial lines and the exporter's known '{}' serialization failure carry no usage.
    return null
  }
}

/**
 * VS Code's SQLiteSpanExporter preserves SDK trace/span IDs, including embedded
 * CLI spans. Count completed native Copilot trace leaves only, deduplicating the
 * DB and file exports. Require the owning agent span: a Claude/Codex delegate's
 * usage belongs to its native scanner, and a model called Claude is not itself
 * evidence that the harness was Claude Code.
 * Sources: microsoft/vscode extensions/copilot/src/platform/otel/node/{
 * fileExporters.ts,sqlite/sqliteSpanExporter.ts,sqlite/otelSqliteStore.ts}.
 */
export async function readCopilotTelemetry(
  sources: CopilotTelemetrySources
): Promise<CopilotInference[]> {
  const spans = new Map<string, Span>()
  for (const path of sources.files) {
    try {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        const span = fileSpan(line)
        if (span) spans.set(`${span.traceId}:${span.spanId}`, span)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Copilot telemetry unavailable in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
  for (const path of sources.databases) {
    try {
      const rows = await queryDb(
        path,
        `SELECT span_id, trace_id, parent_span_id,
        end_time_ms, operation_name, agent_name, conversation_id, chat_session_id,
        response_model, request_model, input_tokens, output_tokens,
        (SELECT value FROM span_attributes
          WHERE span_id = s.span_id AND key = 'gen_ai.agent.id') AS agent_id
        FROM spans AS s`
      )
      for (const row of rows) {
        const [
          spanId,
          traceId,
          parentSpanId,
          endTime,
          operation,
          agent,
          conversation,
          chatSession,
          responseModel,
          requestModel,
          input,
          output,
          agentId,
        ] = row
        if (
          typeof spanId !== 'string' ||
          !spanId ||
          typeof traceId !== 'string' ||
          !traceId ||
          typeof endTime !== 'number' ||
          !Number.isFinite(endTime) ||
          endTime <= 0
        )
          continue
        spans.set(`${traceId}:${spanId}`, {
          spanId,
          traceId,
          parentSpanId: typeof parentSpanId === 'string' ? parentSpanId : '',
          endTime,
          attributes: {
            'gen_ai.operation.name': operation,
            'gen_ai.agent.name': agent,
            'gen_ai.agent.id': agentId,
            'gen_ai.conversation.id': conversation || chatSession,
            'gen_ai.response.model': responseModel,
            'gen_ai.request.model': requestModel,
            'gen_ai.usage.input_tokens': input,
            'gen_ai.usage.output_tokens': output,
          },
        })
      }
    } catch (error) {
      console.warn(
        `Copilot trace database unavailable: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const inferences: CopilotInference[] = []
  for (const span of spans.values()) {
    const attributes = span.attributes
    if (attributes['gen_ai.operation.name'] !== 'chat') continue
    let session =
      attributes['gen_ai.conversation.id'] ??
      attributes['copilot_chat.chat_session_id']
    let native = false
    let delegated = false
    let cursor: Span | undefined = span
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor.spanId)) {
      seen.add(cursor.spanId)
      if (cursor.attributes['gen_ai.agent.id'] === 'github.copilot.default')
        native = true
      const agent = cursor.attributes['gen_ai.agent.name']
      if (typeof agent === 'string') {
        const name = agent.toLowerCase()
        if (
          name === 'github copilot chat' ||
          name === 'copilot' ||
          name === 'copilotcli' ||
          name === 'github-copilot'
        )
          native = true
        if (
          name === 'claude' ||
          name === 'claude-code' ||
          name === 'claude_code' ||
          name === 'codex'
        )
          delegated = true
      }
      session ||=
        cursor.attributes['gen_ai.conversation.id'] ??
        cursor.attributes['copilot_chat.chat_session_id']
      cursor = spans.get(`${span.traceId}:${cursor.parentSpanId}`)
    }
    if (!native || delegated || typeof session !== 'string' || !session)
      continue
    const model =
      attributes['gen_ai.response.model'] || attributes['gen_ai.request.model']
    const input = attributes['gen_ai.usage.input_tokens']
    const output = attributes['gen_ai.usage.output_tokens']
    if (
      typeof model !== 'string' ||
      !model ||
      typeof input !== 'number' ||
      typeof output !== 'number' ||
      !Number.isSafeInteger(input) ||
      input < 0 ||
      !Number.isSafeInteger(output) ||
      output < 0
    )
      continue
    // GenAI input includes cache subsets; output includes reasoning subsets.
    const tokens = input + output
    const date = new Date(span.endTime)
    if (
      !Number.isSafeInteger(tokens) ||
      tokens <= 0 ||
      !Number.isFinite(date.getTime())
    )
      continue
    inferences.push({
      sessionId: session,
      model,
      timestamp: date.toISOString(),
      tokens,
    })
  }
  return inferences
}
