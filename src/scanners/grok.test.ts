import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseGrokLine, scanGrok } from './index.js'

function inferenceLine(opts: {
  prompt: number
  completion: number
  cached?: number
  reasoning?: number
  ts?: string
  model?: string
  msg?: string
}): string {
  return JSON.stringify({
    ts: opts.ts ?? '2026-08-20T15:00:00.000Z',
    src: 'shell',
    msg: opts.msg ?? 'shell.turn.inference_done',
    ctx: {
      prompt_tokens: opts.prompt,
      cached_prompt_tokens: opts.cached ?? 0,
      completion_tokens: opts.completion,
      reasoning_tokens: opts.reasoning ?? 0,
      ...(opts.model ? { model_id: opts.model } : {}),
    },
  })
}

describe('parseGrokLine', () => {
  it('sums prompt + completion and ignores cache/reasoning subsets', () => {
    const usage = parseGrokLine(
      inferenceLine({
        prompt: 33051,
        cached: 5504,
        completion: 231,
        reasoning: 228,
        model: 'grok-4.6',
      })
    )
    expect(usage).toEqual({
      tokens: 33282,
      model: 'grok-4.6',
      date: '2026-08-20',
    })
  })

  it('skips non-inference log lines without parsing them as usage', () => {
    expect(
      parseGrokLine(
        JSON.stringify({ ts: '2026-08-20T15:00:00.000Z', msg: 'auth init' })
      )
    ).toBeNull()
    expect(parseGrokLine('{"msg":"not json usage"}')).toBeNull()
    expect(parseGrokLine('')).toBeNull()
  })

  it('skips zero-token rounds', () => {
    expect(
      parseGrokLine(inferenceLine({ prompt: 0, completion: 0 }))
    ).toBeNull()
  })

  it('defaults the model to grok when the log line does not name one', () => {
    expect(
      parseGrokLine(inferenceLine({ prompt: 10, completion: 2 }))?.model
    ).toBe('grok')
  })
})

describe('scanGrok', () => {
  let dir: string
  let previousHome: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hacklab-grok-'))
    previousHome = process.env.GROK_HOME
    process.env.GROK_HOME = dir
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty when Grok Build has never written logs', async () => {
    const result = await scanGrok()
    expect(result).toEqual({ tool: 'grok', daily: [], models: {} })
  })

  it('aggregates inference_done lines from unified.jsonl', async () => {
    const logs = join(dir, 'logs')
    await mkdir(logs, { recursive: true })
    await writeFile(
      join(logs, 'unified.jsonl'),
      [
        JSON.stringify({
          ts: '2026-08-20T15:00:00.000Z',
          msg: 'session created',
        }),
        inferenceLine({
          prompt: 100,
          completion: 20,
          ts: '2026-08-20T15:01:00.000Z',
          model: 'grok-4.6',
        }),
        inferenceLine({
          prompt: 200,
          completion: 30,
          ts: '2026-08-20T16:01:00.000Z',
          model: 'grok-4.6',
        }),
        '',
      ].join('\n')
    )

    const result = await scanGrok()
    expect(result.tool).toBe('grok')
    expect(result.daily).toEqual([
      {
        date: '2026-08-20',
        tool: 'grok',
        tokens: 350,
        messages: 2,
        model: 'grok-4.6',
      },
    ])
    expect(result.models).toEqual({ 'grok-4.6': 350 })
  })
})
