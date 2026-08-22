import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  waitForEnter: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  generateShareCard: vi.fn(),
  displayInTerminal: vi.fn(),
  copyToClipboard: vi.fn(),
  openBrowser: vi.fn(),
  logs: [] as string[],
}))

vi.mock('node:fs/promises', () => ({
  readFile: m.readFile,
  copyFile: m.copyFile,
}))
vi.mock('node:os', () => ({ homedir: () => '/home/hacker' }))
vi.mock('./share-card.js', () => ({
  generateShareCard: m.generateShareCard,
  displayInTerminal: m.displayInTerminal,
  copyToClipboard: m.copyToClipboard,
}))
vi.mock('./utils/openBrowser.js', () => ({ openBrowser: m.openBrowser }))
vi.mock('./utils/waitForEnter.js', () => ({ waitForEnter: m.waitForEnter }))
vi.mock('./ui.js', () => ({
  bold: (value: string) => value,
  dim: (value: string) => value,
  info: m.info,
  success: m.success,
}))

import {
  promptShareOnX,
  renderShareCard,
  type ShareCardData,
  shareTweetText,
} from './share.js'

const card: ShareCardData = {
  handle: 'bratos',
  level: 28,
  title: 'ronin',
  beltColor: 'red',
  tokensTotal: 1_500_000_000,
  rank: 7,
  streak: 5,
  longestStreak: 10,
  progressPercent: 50,
  estimatedCost: 100,
  toolBreakdown: { claudeCode: 1, codex: 2, cursor: 3 },
  models: [],
  dailyActivity: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  m.logs.length = 0
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    m.logs.push(String(msg ?? ''))
  })
  m.generateShareCard.mockResolvedValue('/tmp/card.png')
  m.readFile.mockResolvedValue(Buffer.from('image'))
  m.displayInTerminal.mockReturnValue(true)
  m.copyToClipboard.mockResolvedValue(true)
  m.waitForEnter.mockResolvedValue(false)
})

describe('renderShareCard', () => {
  it('shows the png and saves it to the desktop', async () => {
    expect(await renderShareCard(card)).toBe('/tmp/card.png')
    expect(m.displayInTerminal).toHaveBeenCalled()
    expect(m.copyFile).toHaveBeenCalledWith(
      '/tmp/card.png',
      join('/home/hacker', 'Desktop', 'hacklab-card.png')
    )
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.waitForEnter).not.toHaveBeenCalled()
  })

  it('keeps the png path and skips a text fallback when inline images are unsupported', async () => {
    m.displayInTerminal.mockReturnValue(false)
    expect(await renderShareCard(card)).toBe('/tmp/card.png')
    expect(m.copyFile).toHaveBeenCalledWith(
      '/tmp/card.png',
      join('/home/hacker', 'Desktop', 'hacklab-card.png')
    )
  })
})

describe('promptShareOnX', () => {
  it('does nothing when they skip enter', async () => {
    m.waitForEnter.mockResolvedValue(false)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.waitForEnter).toHaveBeenCalledWith('(press enter to share) ')
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.openBrowser).not.toHaveBeenCalled()
  })

  it('copies the image and opens X after enter — desktop save already happened', async () => {
    m.waitForEnter.mockResolvedValue(true)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.copyToClipboard).toHaveBeenCalledWith('/tmp/card.png')
    expect(m.openBrowser).toHaveBeenCalledWith(
      `https://x.com/intent/tweet?text=${encodeURIComponent(shareTweetText(card))}`
    )
  })
})

describe('shareTweetText', () => {
  it('is tokens, paste hint, profile, then campaign tags', () => {
    expect(shareTweetText(card)).toBe(
      [
        'I burned 1.5B tokens 🔥',
        '',
        '(press cmd+v)',
        '',
        'https://hacklab.so/bratos',
        '',
        '',
        '#joinhacklab #riplinkedin',
      ].join('\n')
    )
  })
})
