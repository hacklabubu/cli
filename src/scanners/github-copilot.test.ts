import { describe, expect, it } from 'vitest'

import { parseGitHubCopilotJsonl } from './github-copilot.js'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('parseGitHubCopilotJsonl', () => {
  it('extracts only user prompts from a VS Code Copilot transcript', () => {
    const transcript = [
      {
        type: 'session.start',
        timestamp: '2026-09-16T09:00:00.000Z',
        data: { sessionId: 'vscode-session', producer: 'copilot-agent' },
      },
      {
        type: 'user.message',
        timestamp: '2026-09-16T09:01:00.000Z',
        data: { content: 'fix the failing test', attachments: [] },
      },
      {
        type: 'user.message',
        timestamp: '2026-09-16T09:02:00.000Z',
        data: { content: 'tool input', source: 'skill' },
      },
      {
        type: 'assistant.message',
        timestamp: '2026-09-16T09:03:00.000Z',
        data: { content: 'done' },
      },
    ]
      .map(line)
      .join('')

    expect(parseGitHubCopilotJsonl(transcript, { source: 'vscode' })).toEqual([
      {
        sessionId: 'github_copilot:vscode:vscode-session',
        text: 'fix the failing test',
        timestamp: '2026-09-16T09:01:00.000Z',
      },
    ])
  })

  it('does not mistake arbitrary VS Code JSONL for a Copilot transcript', () => {
    const transcript = line({
      type: 'user.message',
      timestamp: '2026-09-16T09:01:00.000Z',
      data: { content: 'another provider' },
    })

    expect(parseGitHubCopilotJsonl(transcript, { source: 'vscode' })).toEqual(
      []
    )
  })

  it('uses the CLI session directory id and preserves a missing timestamp', () => {
    const events = [
      { type: 'user.message', data: { content: 'implement the feature' } },
      {
        type: 'user.message',
        timestamp: 'not a date',
        data: { content: 'still user authored', source: 'USER' },
      },
      {
        type: 'user.message',
        timestamp: '2026-09-16T09:03:00.000Z',
        data: { content: 'generated context', source: 'system' },
      },
    ]
      .map(line)
      .join('')

    expect(
      parseGitHubCopilotJsonl(events, {
        source: 'cli',
        sessionId: 'cli-session',
      })
    ).toEqual([
      {
        sessionId: 'github_copilot:cli:cli-session',
        text: 'implement the feature',
        timestamp: null,
      },
      {
        sessionId: 'github_copilot:cli:cli-session',
        text: 'still user authored',
        timestamp: null,
      },
    ])
  })
})
