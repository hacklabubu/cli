import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findFiles } from './util.js'

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
  return [
    ...vscodeFiles.flat(),
    ...(await findFiles(githubCopilotCliSessionStateDir(), '.jsonl')).filter(
      (path) => /[\\/]session-state[\\/][^\\/]+[\\/]events\.jsonl$/i.test(path)
    ),
  ]
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
 * Read raw local prompts for the prompt-consent pipeline. This is intentionally
 * not a token scanner: local VS Code transcripts and Copilot CLI event logs do
 * not contain billable token totals.
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
