import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => home.dir,
}))

import {
  parseAntigravityLegacyPromptLine,
  scanAntigravityPrompts,
} from './antigravity.js'

const sessionId = '7e1b0c0a-4c8c-42e3-8f26-d6e169fb9a6e'

function userPrompt(
  body: string,
  timestamps: { created_at?: string; timestamp?: string } = {}
): string {
  return JSON.stringify({
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: `<USER_REQUEST>${body}</USER_REQUEST>`,
    ...timestamps,
  })
}

describe('parseAntigravityLegacyPromptLine', () => {
  it('uses created_at and retains only the verbatim USER_REQUEST body', async () => {
    const lines = (
      await readFile(
        new URL(
          './fixtures/antigravity-reported-prompts.jsonl',
          import.meta.url
        ),
        'utf8'
      )
    )
      .trimEnd()
      .split('\n')

    expect(
      lines.map((line) => parseAntigravityLegacyPromptLine(line, sessionId))
    ).toEqual([
      {
        text: '\nhey! if I ask you to code me a little app, would you be able to write code on my system where i can run it?\n',
        sessionId: `antigravity-ide:${sessionId}`,
        timestamp: '2026-09-16T17:14:10.000Z',
      },
      {
        text: "\nCool! I gave you permission for ~/_projects/test_antigravity\n\nI'd like to make a cli app which shows a live count of keys I press. So for each key, a count, and updates when I press them\n",
        sessionId: `antigravity-ide:${sessionId}`,
        timestamp: '2026-09-16T17:15:55.000Z',
      },
      null,
    ])
  })

  it('selects a nonempty USER_REQUEST after leading artifact prose', async () => {
    const [, , artifactRecord] = (
      await readFile(
        new URL(
          './fixtures/antigravity-reported-prompts.jsonl',
          import.meta.url
        ),
        'utf8'
      )
    )
      .trimEnd()
      .split('\n')
    const withRequest = JSON.parse(artifactRecord)
    withRequest.content = withRequest.content.replace(
      '<USER_REQUEST>\n\n</USER_REQUEST>',
      '<USER_REQUEST>\nship it\n</USER_REQUEST>'
    )

    expect(
      parseAntigravityLegacyPromptLine(JSON.stringify(withRequest), sessionId)
    ).toMatchObject({ text: '\nship it\n' })
  })

  it('falls back to timestamp only when created_at is absent or invalid', () => {
    expect(
      parseAntigravityLegacyPromptLine(
        userPrompt('legacy', { timestamp: '2026-09-16T08:00:00-04:00' }),
        sessionId
      )
    ).toMatchObject({ timestamp: '2026-09-16T12:00:00.000Z' })
    expect(
      parseAntigravityLegacyPromptLine(
        userPrompt('created first', {
          created_at: '2026-09-16T08:00:00Z',
          timestamp: '2026-09-16T08:00:00-04:00',
        }),
        sessionId
      )
    ).toMatchObject({ timestamp: '2026-09-16T08:00:00.000Z' })
    expect(
      parseAntigravityLegacyPromptLine(
        userPrompt('invalid created_at', {
          created_at: 'invalid',
          timestamp: '2026-09-16T08:00:00-04:00',
        }),
        sessionId
      )
    ).toMatchObject({ timestamp: '2026-09-16T12:00:00.000Z' })
  })

  it('keeps missing or invalid timestamps null and rejects malformed requests', () => {
    expect(
      parseAntigravityLegacyPromptLine(userPrompt('no timestamp'), sessionId)
    ).toMatchObject({ timestamp: null })
    expect(
      parseAntigravityLegacyPromptLine(
        userPrompt('invalid timestamps', {
          created_at: 'invalid',
          timestamp: 'also invalid',
        }),
        sessionId
      )
    ).toMatchObject({ timestamp: null })
    expect(
      parseAntigravityLegacyPromptLine(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: '<USER_REQUEST> \n\t</USER_REQUEST>',
        }),
        sessionId
      )
    ).toBeNull()
    expect(
      parseAntigravityLegacyPromptLine(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: '<USER_REQUEST>missing close',
        }),
        sessionId
      )
    ).toBeNull()
    expect(
      parseAntigravityLegacyPromptLine(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: 'untagged request',
        }),
        sessionId
      )
    ).toBeNull()
    expect(
      parseAntigravityLegacyPromptLine(
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: '<USER_REQUEST>agent response</USER_REQUEST>',
        }),
        sessionId
      )
    ).toBeNull()
  })
})

describe('scanAntigravityPrompts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hacklab-antigravity-'))
    home.dir = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('uses transcript_full once when both legacy transcript variants exist', async () => {
    const logs = join(
      dir,
      '.gemini',
      'antigravity-ide',
      'brain',
      sessionId,
      '.system_generated',
      'logs'
    )
    await mkdir(logs, { recursive: true })
    await writeFile(join(logs, 'transcript.jsonl'), userPrompt('partial log'))
    await writeFile(
      join(logs, 'transcript_full.jsonl'),
      [
        userPrompt('complete log', { timestamp: '2026-09-16T00:00:00Z' }),
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: 'answer',
        }),
      ].join('\n')
    )

    await expect(scanAntigravityPrompts()).resolves.toEqual([
      {
        text: 'complete log',
        sessionId: `antigravity-ide:${sessionId}`,
        timestamp: '2026-09-16T00:00:00.000Z',
      },
    ])
  })
})
