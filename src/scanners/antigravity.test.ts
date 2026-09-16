import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function userPrompt(content: string, timestamp?: string): string {
  return JSON.stringify({
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content,
    ...(timestamp ? { timestamp } : {}),
  })
}

describe('parseAntigravityLegacyPromptLine', () => {
  it('returns only explicit user input with its actual timestamp', () => {
    expect(
      parseAntigravityLegacyPromptLine(
        userPrompt('ship it', '2026-09-16T08:00:00-04:00'),
        sessionId
      )
    ).toEqual({
      text: 'ship it',
      sessionId: `antigravity-ide:${sessionId}`,
      timestamp: '2026-09-16T12:00:00.000Z',
    })
  })

  it('keeps missing timestamps null and rejects non-user transcript records', () => {
    expect(
      parseAntigravityLegacyPromptLine(userPrompt('no timestamp'), sessionId)
    ).toMatchObject({ timestamp: null })
    expect(
      parseAntigravityLegacyPromptLine(
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: 'agent response',
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
        userPrompt('complete log', '2026-09-16T00:00:00Z'),
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
