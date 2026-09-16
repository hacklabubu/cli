import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { findFiles } from './util.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The original Antigravity IDE writes readable user/agent transcript logs here.
 * Antigravity 2.0 instead has an opaque `.pb` cache at
 * `~/.gemini/antigravity/conversations`; it is intentionally not scanned here.
 */
export function antigravityLegacyBrainDir(): string {
  return join(homedir(), '.gemini', 'antigravity-ide', 'brain')
}

/**
 * Source: github.com/mehdawimohamed/antigravity-conversation-exporter/export_chat.py
 * Layout: brain/<UUID>/.system_generated/logs/transcript[_full].jsonl.
 * Readable legacy IDE transcripts only. A session can have both variants;
 * `transcript_full.jsonl` is preferred by scanAntigravityPrompts().
 */
export async function antigravityLegacyTranscriptFiles(): Promise<string[]> {
  const files = await findFiles(antigravityLegacyBrainDir(), '.jsonl')
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
  /** Stable source-prefixed legacy IDE conversation UUID. */
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

/** All readable typed prompts from the legacy Antigravity IDE, newest log variant once. */
export async function scanAntigravityPrompts(): Promise<AntigravityPrompt[]> {
  const files = await antigravityLegacyTranscriptFiles()
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
