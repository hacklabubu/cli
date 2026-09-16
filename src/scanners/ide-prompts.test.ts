import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => home.dir,
}))

import {
  IDE_PROMPT_SOURCES,
  parsePromptLine,
  scanPromptStats,
} from '../prompt-stats.js'
import { githubCopilotVsCodeWorkspaceStorageRoots } from './github-copilot.js'
import type { TickSources } from './incremental.js'
import {
  loadScanState,
  markUploaded,
  runTick,
  stageFullScan,
  tickPayload,
} from './incremental.js'
import { findFiles, parseClaudeCodeLine } from './index.js'

const at = '2026-09-16T12:00:00.000Z'
const day = at.slice(0, 10)
const line = (event: unknown) => `${JSON.stringify(event)}\n`
const copilotPrompt = (text: string) =>
  line({
    type: 'user.message',
    timestamp: at,
    data: { content: text },
  })
const claudePrompt = (text: string) =>
  line({
    type: 'user',
    sessionId: 'claude-session',
    timestamp: at,
    message: { content: text },
  })

let claudeFile: string
let copilotFile: string
let sources: TickSources

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

beforeEach(async () => {
  home.dir = await mkdtemp(join(tmpdir(), 'hacklab-ide-prompts-'))
  vi.stubEnv('COPILOT_HOME', join(home.dir, '.copilot'))
  vi.stubEnv('XDG_CONFIG_HOME', join(home.dir, '.config'))
  vi.stubEnv('APPDATA', join(home.dir, 'AppData', 'Roaming'))
  vi.stubEnv('HACKLAB_SESSION_PATH', join(home.dir, '.hacklab', 'session.json'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(at))
  claudeFile = join(home.dir, '.claude', 'projects', 'work', 'session.jsonl')
  copilotFile = join(
    home.dir,
    '.copilot',
    'session-state',
    'cli-session',
    'events.jsonl'
  )
  sources = {
    jsonl: [
      {
        tool: 'claude_code',
        files: () => findFiles(join(home.dir, '.claude', 'projects'), '.jsonl'),
        parse: parseClaudeCodeLine,
        parsePrompt: parsePromptLine,
      },
    ],
    codex: { files: async () => [], dateFor: () => null },
    sqlite: [],
    prompts: IDE_PROMPT_SOURCES,
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await rm(home.dir, { recursive: true, force: true })
})

describe('consented IDE prompt integration', () => {
  it('finds IDE-only history without inventing dates, tokens, or a text upload', async () => {
    await put(copilotFile, copilotPrompt('fix tests'))
    const [workspaceRoot] = githubCopilotVsCodeWorkspaceStorageRoots()
    if (!workspaceRoot) throw new Error('test needs a supported desktop OS')
    const vscodeFile = join(
      workspaceRoot,
      'workspace',
      'github.copilot-chat',
      'transcripts',
      'vscode.jsonl'
    )
    await put(
      vscodeFile,
      line({
        type: 'session.start',
        data: { producer: 'copilot-agent', sessionId: 'vscode-session' },
      }) + copilotPrompt('review changes')
    )
    await put(
      join(
        home.dir,
        '.gemini',
        'antigravity-ide',
        'brain',
        '7e1b0c0a-4c8c-42e3-8f26-d6e169fb9a6e',
        '.system_generated',
        'logs',
        'transcript_full.jsonl'
      ),
      line({
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: 'write docs',
      })
    )

    const stats = await scanPromptStats()
    expect(stats?.totalPrompts).toBe(3)
    expect(stats?.histogram).toEqual([{ length: 2, count: 3 }])
    expect(stats?.activity.daily[day]).toEqual({ prompts: 2, words: 4 })
    expect(stats?.conversationSample).toBeUndefined()
    expect(
      (await scanPromptStats({ includeSample: true }))?.conversationSample
    ).toContain('write docs')
    const { state } = await runTick(null, sources)
    expect(
      tickPayload(state, { promptActivity: true }).toolTotals
    ).not.toHaveProperty('github_copilot')
    expect(
      tickPayload(state, { promptActivity: true }).promptActivity?.dailyPrompts
    ).toEqual([{ date: day, prompts: 2, words: 4 }])
  })

  it('keeps sources independent across appends, rewrites, and a full-scan rebase', async () => {
    await put(
      claudeFile,
      claudePrompt('first prompt') + claudePrompt('second prompt')
    )
    await put(copilotFile, copilotPrompt('copilot prompt'))
    const first = await runTick(null, sources)
    expect(first.state.prompts.daily[day]?.prompts).toBe(3)
    markUploaded(first.state)

    await appendFile(copilotFile, copilotPrompt('another copilot prompt'))
    const appended = await runTick(first.state, sources)
    expect(appended.state.prompts.daily[day]?.prompts).toBe(4)
    expect(
      tickPayload(appended.state, { promptActivity: true }).promptActivity
        ?.sessions
    ).toContainEqual({
      sessionId: 'github_copilot:cli:cli-session',
      startedAt: at,
      lastActiveAt: at,
      promptCount: 2,
    })
    markUploaded(appended.state)

    await put(claudeFile, claudePrompt('first prompt'))
    const rewritten = await runTick(appended.state, sources)
    expect(rewritten.state.prompts.daily[day]?.prompts).toBe(3)
    expect(
      rewritten.state.prompts.sessions['github_copilot:cli:cli-session']
        ?.promptCount
    ).toBe(2)
    await appendFile(claudeFile, claudePrompt('restored prompt'))
    const restored = await runTick(rewritten.state, sources)
    expect(
      tickPayload(restored.state, { promptActivity: true }).promptActivity
        ?.sessions
    ).toContainEqual({
      sessionId: 'claude-session',
      startedAt: at,
      lastActiveAt: at,
      promptCount: 2,
    })

    const stats = await scanPromptStats()
    if (!stats) throw new Error('fixture prompts were not scanned')
    const staged = await stageFullScan([], { scanned: stats.activity }, sources)
    await staged.commit()
    const rebased = await runTick(await loadScanState(), sources)
    expect(rebased.state.prompts.daily[day]?.prompts).toBe(4)
    expect(
      tickPayload(rebased.state, { promptActivity: true }).promptActivity
    ).toBeUndefined()
    expect((await runTick(rebased.state, sources)).changed).toBe(false)
  })

  it('does not read IDE transcripts when the current source scope is not consented', async () => {
    const scan = vi.fn(async () => {
      throw new Error('must not read prompts')
    })
    const files = vi.fn(async () => {
      throw new Error('must not discover prompts')
    })
    sources.prompts = [{ id: 'github_copilot', scan, files }]
    const { state } = await runTick(null, sources, { promptActivity: false })
    expect(scan).not.toHaveBeenCalled()
    expect(files).not.toHaveBeenCalled()
    expect(tickPayload(state).promptActivity).toBeUndefined()
  })
})
