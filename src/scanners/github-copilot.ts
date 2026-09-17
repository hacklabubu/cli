import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  copilotTelemetrySources,
  readCopilotTelemetry,
} from './github-copilot-telemetry.js'
import type { ScanResult } from './util.js'
import { findFiles, TokenCollector } from './util.js'

/** A user-authored Copilot prompt retained by a local Copilot transcript. */
export type GitHubCopilotPrompt = {
  /** Stable across scans and distinct from other harness session ids. */
  sessionId: string
  /** The prompt text. Send only under the existing full-consent flow. */
  text: string
  /** The event's recorded instant, or null when the source did not record one. */
  timestamp: string | null
}

type CopilotSource = 'vscode' | 'cli'

type ParseOptions = {
  source: CopilotSource
  /** Required for Copilot CLI events, whose session id is the parent directory name. */
  sessionId?: string
}

/**
 * Source: microsoft/vscode, extensions/copilot/src/extension/chat/vscode-node/
 * sessionTranscriptService.ts (session.start + user.message JSONL).
 * VS Code's built-in GitHub Copilot extension writes these JSONL transcripts
 * under workspace storage. We intentionally name only its extension storage,
 * never generic VS Code chat persistence, so another chat provider cannot be
 * mistaken for Copilot.
 */
export function githubCopilotVsCodeWorkspaceStorageRoots(): string[] {
  const home = homedir()
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
      return [
        join(appData, 'Code', 'User', 'workspaceStorage'),
        join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
      ]
    }
    case 'darwin':
      return [
        join(
          home,
          'Library',
          'Application Support',
          'Code',
          'User',
          'workspaceStorage'
        ),
        join(
          home,
          'Library',
          'Application Support',
          'Code - Insiders',
          'User',
          'workspaceStorage'
        ),
      ]
    case 'linux': {
      const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
      return [
        join(configHome, 'Code', 'User', 'workspaceStorage'),
        join(configHome, 'Code - Insiders', 'User', 'workspaceStorage'),
      ]
    }
    default:
      return []
  }
}

/** Copilot CLI uses this state root; COPILOT_HOME takes precedence at scan time. */
export function githubCopilotCliSessionStateDir(): string {
  return join(
    process.env.COPILOT_HOME || join(homedir(), '.copilot'),
    'session-state'
  )
}

/**
 * Local files deliberately written by GitHub Copilot only.
 *
 * VS Code transcript persistence is currently limited to the extension's
 * `github.copilot-chat/transcripts` directory. Copilot CLI persists one
 * `events.jsonl` file per session. Neither generic VS Code workspace state nor
 * exported chats are read, avoiding duplicate/snapshot records and unrelated
 * providers' chats.
 */
export async function githubCopilotFiles(): Promise<string[]> {
  const vscodeFiles = await Promise.all(
    githubCopilotVsCodeWorkspaceStorageRoots().map(async (root) => {
      let workspaces: string[]
      try {
        workspaces = await readdir(root)
      } catch {
        return []
      }
      return (
        await Promise.all(
          workspaces.map((workspace) =>
            findFiles(
              join(root, workspace, 'github.copilot-chat', 'transcripts'),
              '.jsonl'
            )
          )
        )
      ).flat()
    })
  )
  return [...vscodeFiles.flat(), ...(await githubCopilotSessionFiles())]
}

/** Keep a source prefix because VS Code and the CLI may reuse a UUID. */
function prefixedSessionId(source: CopilotSource, sessionId: string): string {
  return `github_copilot:${source}:${sessionId}`
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const instant = typeof value === 'number' ? value : Date.parse(value)
  const date = new Date(instant)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * Parse the documented JSONL event shape written by VS Code's Copilot
 * transcript service and the Copilot CLI SDK. Synthetic SDK user messages
 * (for example tool/skill traffic) are excluded; only absent or `user` sources
 * represent a person-entered prompt.
 */
export function parseGitHubCopilotJsonl(
  content: string,
  options: ParseOptions
): GitHubCopilotPrompt[] {
  let sessionId = options.sessionId?.trim() || ''
  let sawVsCodeTranscript = options.source !== 'vscode'
  const prompts: GitHubCopilotPrompt[] = []

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const record = event as {
      type?: unknown
      timestamp?: unknown
      data?: {
        sessionId?: unknown
        producer?: unknown
        content?: unknown
        source?: unknown
      }
    }
    if (record.type === 'session.start') {
      if (record.data?.producer === 'copilot-agent') sawVsCodeTranscript = true
      if (
        typeof record.data?.sessionId === 'string' &&
        record.data.sessionId.trim()
      ) {
        sessionId = record.data.sessionId.trim()
      }
      continue
    }
    if (
      record.type !== 'user.message' ||
      !sawVsCodeTranscript ||
      !sessionId ||
      prefixedSessionId(options.source, sessionId).length > 128
    )
      continue
    if (
      typeof record.data?.source === 'string' &&
      record.data.source.toLowerCase() !== 'user'
    ) {
      continue
    }
    if (typeof record.data?.content !== 'string' || !record.data.content.trim())
      continue
    prompts.push({
      sessionId: prefixedSessionId(options.source, sessionId),
      text: record.data.content,
      timestamp: timestamp(record.timestamp),
    })
  }
  return prompts
}

/**
 * Read raw local prompts only for the consented prompt pipeline. Token scanning
 * below uses numeric usage records independently of prompt-sharing consent.
 */
export async function scanGitHubCopilotPrompts(): Promise<
  GitHubCopilotPrompt[]
> {
  const files = await githubCopilotFiles()
  const prompts = await Promise.all(
    files.map(async (path) => {
      let content: string
      try {
        content = await readFile(path, 'utf8')
      } catch {
        return []
      }
      const cliMatch = path.match(
        /[\\/]session-state[\\/]([^\\/]+)[\\/]events\.jsonl$/i
      )
      return parseGitHubCopilotJsonl(content, {
        source: cliMatch ? 'cli' : 'vscode',
        sessionId: cliMatch?.[1],
      })
    })
  )
  return prompts.flat()
}

async function githubCopilotSessionFiles(): Promise<string[]> {
  return (await findFiles(githubCopilotCliSessionStateDir(), '.jsonl')).filter(
    (path) => /[\\/]session-state[\\/][^\\/]+[\\/]events\.jsonl$/i.test(path)
  )
}

export async function githubCopilotTokenFiles(): Promise<string[]> {
  const telemetry = await copilotTelemetrySources(
    githubCopilotVsCodeWorkspaceStorageRoots().map((root) => dirname(root))
  )
  return [
    ...(await githubCopilotSessionFiles()),
    ...telemetry.files,
    ...telemetry.databases.flatMap((path) => [path, `${path}-wal`]),
  ]
}

export type CopilotUsageSnapshot = {
  sessionId: string
  model: string
  timestamp: string
  tokens: number
  messages: number
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * SDK session.shutdown is durable, unlike ephemeral assistant.usage events.
 * modelMetrics is cumulative across resumes. Input already includes both cache
 * buckets, output already includes reasoning; agentMetrics is a breakdown of
 * these same modelMetrics, not additional usage.
 * Sources: github/copilot-sdk generated/session-events.ts; ccusage.com/guide/copilot/
 */
export function parseGitHubCopilotUsage(
  content: string,
  fallbackSessionId: string
): CopilotUsageSnapshot[] {
  let sessionId = fallbackSessionId
  const snapshots: CopilotUsageSnapshot[] = []
  for (const line of content.split('\n')) {
    let event: {
      type?: unknown
      timestamp?: unknown
      agentId?: unknown
      data?: {
        sessionId?: unknown
        modelMetrics?: Record<
          string,
          {
            usage?: { inputTokens?: unknown; outputTokens?: unknown }
            requests?: { count?: unknown }
          }
        >
      }
    }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (
      event.type === 'session.start' &&
      typeof event.data?.sessionId === 'string'
    ) {
      sessionId = event.data.sessionId.trim() || sessionId
    }
    if (event.type !== 'session.shutdown' || event.agentId) continue
    const at = timestamp(event.timestamp)
    const metrics = event.data?.modelMetrics
    if (
      !at ||
      !sessionId ||
      !metrics ||
      typeof metrics !== 'object' ||
      Array.isArray(metrics)
    )
      continue
    for (const [model, metric] of Object.entries(metrics)) {
      const input = metric?.usage?.inputTokens
      const output = metric?.usage?.outputTokens
      if (!model || !tokenCount(input) || !tokenCount(output)) continue
      const tokens = input + output
      if (!Number.isSafeInteger(tokens)) continue
      snapshots.push({
        sessionId,
        model,
        timestamp: at,
        tokens,
        messages: tokenCount(metric?.requests?.count)
          ? metric.requests.count
          : 0,
      })
    }
  }
  return snapshots
}

export async function scanGitHubCopilot(): Promise<ScanResult> {
  const snapshots: CopilotUsageSnapshot[] = []
  for (const path of await githubCopilotSessionFiles()) {
    try {
      snapshots.push(
        ...parseGitHubCopilotUsage(
          await readFile(path, 'utf8'),
          basename(dirname(path))
        )
      )
    } catch (error) {
      console.warn(
        `Copilot usage unavailable in ${basename(dirname(path))}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const collector = new TokenCollector('github_copilot')
  const previous = new Map<string, { tokens: number; messages: number }>()
  const latestShutdown = new Map<string, string>()
  for (const snapshot of snapshots) {
    const key = JSON.stringify([snapshot.sessionId, snapshot.model])
    latestShutdown.set(
      JSON.stringify([
        snapshot.sessionId,
        snapshot.model.replace(/-1m(?:-internal)?$/, ''),
      ]),
      snapshot.timestamp
    )
    const before = previous.get(key) ?? { tokens: 0, messages: 0 }
    const tokens = Math.max(before.tokens, snapshot.tokens)
    const messages = Math.max(before.messages, snapshot.messages)
    if (tokens > before.tokens) {
      collector.addDaily(
        snapshot.timestamp.slice(0, 10),
        snapshot.model,
        tokens - before.tokens,
        messages - before.messages
      )
    }
    previous.set(key, { tokens, messages })
  }
  const telemetry = await copilotTelemetrySources(
    githubCopilotVsCodeWorkspaceStorageRoots().map((root) => dirname(root))
  )
  for (const inference of await readCopilotTelemetry(telemetry)) {
    const key = JSON.stringify([
      inference.sessionId,
      inference.model.replace(/-1m(?:-internal)?$/, ''),
    ])
    const shutdown = latestShutdown.get(key)
    // A later resumed call is new; earlier calls already belong to the durable
    // cumulative snapshot. Never add two representations of the same usage.
    if (shutdown && inference.timestamp <= shutdown) continue
    collector.addDaily(
      inference.timestamp.slice(0, 10),
      inference.model,
      inference.tokens,
      1
    )
  }
  return collector.result()
}
