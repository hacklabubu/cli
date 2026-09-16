import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import protobuf from 'protobufjs/minimal.js'

import { queryDb } from './sqlite.js'
import type { ScanResult } from './util.js'
import { findFiles, TokenCollector } from './util.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Current shared Antigravity storage and the older IDE-specific directory. */
function antigravityRoots(): string[] {
  return ['antigravity', 'antigravity-cli', 'antigravity-ide'].map((name) =>
    join(homedir(), '.gemini', name)
  )
}

/**
 * Source: github.com/mehdawimohamed/antigravity-conversation-exporter/export_chat.py
 * Layout: brain/<UUID>/.system_generated/logs/transcript[_full].jsonl.
 * Readable transcripts only. A session can have both variants;
 * `transcript_full.jsonl` is preferred by scanAntigravityPrompts().
 */
export async function antigravityTranscriptFiles(): Promise<string[]> {
  const files = (
    await Promise.all(
      antigravityRoots().map((root) => findFiles(join(root, 'brain'), '.jsonl'))
    )
  ).flat()
  return files.filter((file) => {
    const name = basename(file)
    return (
      basename(dirname(file)) === 'logs' &&
      basename(dirname(dirname(file))) === '.system_generated' &&
      (name === 'transcript.jsonl' || name === 'transcript_full.jsonl') &&
      UUID.test(basename(dirname(dirname(dirname(file)))))
    )
  })
}

export type AntigravityPrompt = {
  text: string
  /** Stable source-prefixed conversation UUID, shared across CLI/IDE copies. */
  sessionId: string
  /** Transcript timestamp when supplied; never inferred from file metadata. */
  timestamp: string | null
}

/**
 * Parse a legacy IDE transcript line. The public exporter identifies a typed
 * user prompt as `source: USER_EXPLICIT`, `type: USER_INPUT`, with string
 * `content`. Its documented format does not guarantee timestamps, so this
 * preserves an absent or invalid timestamp as null rather than guessing.
 */
export function parseAntigravityLegacyPromptLine(
  line: string,
  sessionId: string
): AntigravityPrompt | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const entry = parsed as {
    source?: unknown
    type?: unknown
    content?: unknown
    timestamp?: unknown
  }
  if (
    entry.source !== 'USER_EXPLICIT' ||
    entry.type !== 'USER_INPUT' ||
    typeof entry.content !== 'string' ||
    !entry.content.trim()
  ) {
    return null
  }

  return {
    text: entry.content,
    sessionId: `antigravity-ide:${sessionId}`,
    timestamp: normalizeTimestamp(entry.timestamp),
  }
}

/** Read each conversation once even when both storage roots retain a copy. */
export async function scanAntigravityPrompts(): Promise<AntigravityPrompt[]> {
  const files = await antigravityTranscriptFiles()
  const preferred = new Map<string, string>()
  for (const file of files) {
    const sessionId = basename(dirname(dirname(dirname(file))))
    const current = preferred.get(sessionId)
    if (!current || basename(file) === 'transcript_full.jsonl') {
      preferred.set(sessionId, file)
    }
  }

  const prompts: AntigravityPrompt[] = []
  for (const [sessionId, file] of preferred) {
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of content.split(/\r?\n/)) {
      const prompt = parseAntigravityLegacyPromptLine(line, sessionId)
      if (prompt) prompts.push(prompt)
    }
  }
  return prompts
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

async function antigravityConversationDbs(): Promise<string[]> {
  return (
    await Promise.all(
      antigravityRoots().map((root) =>
        findFiles(join(root, 'conversations'), '.db')
      )
    )
  )
    .flat()
    .filter((path) => UUID.test(basename(path, '.db')))
}

/** Fingerprint WAL writes too; the read-only reader sees them after checkpoint. */
export async function antigravityTokenFiles(): Promise<string[]> {
  return (await antigravityConversationDbs()).flatMap((path) => [
    path,
    `${path}-wal`,
  ])
}

type ProtoValue = number | Uint8Array

function protoFields(bytes: Uint8Array): Map<number, ProtoValue> {
  const reader = protobuf.Reader.create(bytes)
  const fields = new Map<number, ProtoValue>()
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const field = tag >>> 3
    if (field === 0) throw new Error('invalid protobuf field')
    switch (tag & 7) {
      case 0:
        fields.set(field, Number(reader.uint64()))
        break
      case 2:
        fields.set(field, reader.bytes())
        break
      default:
        reader.skipType(tag & 7)
    }
  }
  return fields
}

function tokenField(fields: Map<number, ProtoValue>, field: number): number {
  const value = fields.get(field) ?? 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid token count')
  }
  return value
}

export type AntigravityUsage = {
  date: string
  model: string
  tokens: number
  responseId: string | null
}

/**
 * Source: Eneasf/antigravity-token-dashboard docs/TELEMETRY_SPEC.md.
 * steps.metadata: field 1 Timestamp, field 9 UsageMetadata. Input field 2 is
 * uncached; field 5 is cached input; output field 3 already includes reasoning
 * (fields 9 and 10). Never add those output subsets again.
 */
export function parseAntigravityUsage(
  metadata: Uint8Array
): AntigravityUsage | null {
  try {
    const fields = protoFields(metadata)
    const timeBytes = fields.get(1)
    const usageBytes = fields.get(9)
    if (
      !(timeBytes instanceof Uint8Array) ||
      !(usageBytes instanceof Uint8Array)
    )
      return null
    const time = protoFields(timeBytes)
    if (!time.has(1)) return null
    const seconds = tokenField(time, 1)
    const nanos = tokenField(time, 2)
    if (nanos >= 1_000_000_000) return null
    const at = new Date(seconds * 1000 + Math.floor(nanos / 1_000_000))
    if (!Number.isFinite(at.getTime())) return null
    const usage = protoFields(usageBytes)
    const tokens =
      tokenField(usage, 2) + tokenField(usage, 3) + tokenField(usage, 5)
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return null
    const modelId = tokenField(usage, 1)
    // Preserve the actual enum: unofficial name tables disagree across builds.
    const model = modelId ? `antigravity-model-${modelId}` : ''
    const response = usage.get(11)
    return {
      date: at.toISOString().slice(0, 10),
      model,
      tokens,
      responseId:
        response instanceof Uint8Array
          ? Buffer.from(response).toString('utf8').trim() || null
          : null,
    }
  } catch {
    // An unknown/truncated protobuf is not evidence of token usage.
    return null
  }
}

export async function scanAntigravity(): Promise<ScanResult> {
  const collector = new TokenCollector('antigravity')
  const generations = new Map<string, AntigravityUsage>()
  for (const path of await antigravityConversationDbs()) {
    try {
      const rows = await queryDb(
        path,
        'SELECT idx, metadata FROM steps WHERE step_type = 15 ORDER BY idx'
      )
      for (const [index, metadata] of rows) {
        if (typeof index !== 'number' || !(metadata instanceof Uint8Array))
          continue
        const usage = parseAntigravityUsage(metadata)
        if (!usage) continue
        const key = usage.responseId
          ? `response:${usage.responseId}`
          : `step:${basename(path, '.db')}:${index}`
        const previous = generations.get(key)
        if (!previous || usage.tokens > previous.tokens)
          generations.set(key, usage)
      }
    } catch (error) {
      console.warn(
        `Antigravity usage unavailable in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  for (const usage of generations.values()) {
    collector.addDaily(usage.date, usage.model, usage.tokens, 1)
  }
  return collector.result()
}
