import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `scanPromptStats` reads `~/.claude/projects` through `os.homedir()`, which a
// vitest worker won't let $HOME move — so the home dir itself is stubbed.
const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home.dir }
})

import { scanPromptStats } from './prompt-stats.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hacklab-prompt-scan-'))
  home.dir = dir
  await mkdir(join(dir, '.claude', 'projects'), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write a transcript of user prompts and pin its mtime. */
async function transcript(
  name: string,
  prompts: string[],
  mtime: Date,
  sessionId = name
) {
  const path = join(dir, '.claude', 'projects', `${name}.jsonl`)
  await writeFile(
    path,
    `${prompts
      .map((text, i) =>
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd: dir,
          timestamp: new Date(
            Date.parse('2026-03-02T09:00:00.000Z') + i * 60_000
          ).toISOString(),
          message: { content: text },
        })
      )
      .join('\n')}\n`
  )
  await utimes(path, mtime, mtime)
  return path
}

describe('scanPromptStats — the conversation sample', () => {
  it('takes the most recent prompts, newest transcript first', async () => {
    // The whole point of the change: the scorer should see how this person
    // prompts *now*, not whichever project happens to sort first on disk.
    await transcript('aaa-old', ['ancient one', 'ancient two'], new Date(1e12))
    await transcript('zzz-new', ['recent one', 'recent two'], new Date(2e12))

    const stats = await scanPromptStats({ includeSample: true })

    const sample = stats?.conversationSample ?? ''
    expect(sample.indexOf('recent two')).toBeLessThan(
      sample.indexOf('ancient one')
    )
    // Within a file too: the last prompt typed comes before the first.
    expect(sample.indexOf('recent two')).toBeLessThan(
      sample.indexOf('recent one')
    )
  })

  it('omits the sample entirely without the full tier', async () => {
    await transcript('a', ['something private'], new Date(2e12))

    const stats = await scanPromptStats()

    expect(stats?.conversationSample).toBeUndefined()
    expect(stats?.totalPrompts).toBe(1)
  })

  it('stops at the server cap', async () => {
    await transcript(
      'big',
      Array.from({ length: 400 }, (_, i) => `${i} ${'word '.repeat(40)}`),
      new Date(2e12)
    )

    const stats = await scanPromptStats({ includeSample: true })

    expect((stats?.conversationSample ?? '').length).toBeLessThanOrEqual(20_000)
  })
})

describe('scanPromptStats — the activity aggregate', () => {
  it('reports sessions and per-day counts the tick can re-base on', async () => {
    await transcript('one', ['a b c', 'd e'], new Date(2e12), 'sess-1')
    await transcript('two', ['f'], new Date(1e12), 'sess-2')

    const stats = await scanPromptStats()

    expect(stats?.activity.sessions['sess-1']).toEqual({
      startedAt: '2026-03-02T09:00:00.000Z',
      lastActiveAt: '2026-03-02T09:01:00.000Z',
      promptCount: 2,
    })
    expect(stats?.activity.daily['2026-03-02']).toEqual({
      prompts: 3,
      words: 6,
    })
  })

  it('returns null when there is nothing to report', async () => {
    expect(await scanPromptStats()).toBeNull()
  })
})

describe('scanPromptStats — the length tail', () => {
  /** `words` words of prompt text. */
  const words = (n: number) => Array.from({ length: n }, () => 'x').join(' ')

  it('reports the lengths past the axis, and only in the tail', async () => {
    // 38 short prompts keep bucketMax at its floor, so the two long ones fall
    // outside the histogram entirely and are reported exactly by the tail.
    await transcript(
      'one',
      [...Array.from({ length: 38 }, () => words(5)), words(40), words(120)],
      new Date(2e12),
      'sess-1'
    )

    const stats = await scanPromptStats()

    expect(stats?.bucketMax).toBe(10)
    expect(stats?.histogram).toEqual([{ length: 5, count: 38 }])
    expect(stats?.tail).toEqual([
      { length: 40, count: 1 },
      { length: 120, count: 1 },
    ])

    // The two halves partition the scan: nothing counted twice, nothing lost.
    const histogramTotal = (stats?.histogram ?? []).reduce(
      (sum, b) => sum + b.count,
      0
    )
    const tailTotal = (stats?.tail ?? []).reduce((sum, e) => sum + e.count, 0)
    expect(histogramTotal + tailTotal).toBe(stats?.totalPrompts)
  })

  it('sends an empty tail on a scan with no long prompts', async () => {
    await transcript('one', ['a b c', 'd e'], new Date(2e12), 'sess-1')

    const stats = await scanPromptStats()

    expect(stats?.tail).toEqual([])
  })
})
