import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  bareEnter: vi.fn(),
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
vi.mock('./utils/waitForEnter.js', () => ({ waitForBareEnter: m.bareEnter }))
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
  m.bareEnter.mockResolvedValue(false)
})

const DESKTOP_CARD = join('/home/hacker', 'Desktop', 'hacklab-card.png')

describe('renderShareCard', () => {
  it('shows the png and touches nothing outside ~/.hacklab', async () => {
    expect(await renderShareCard(card)).toBe('/tmp/card.png')
    expect(m.displayInTerminal).toHaveBeenCalled()
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.bareEnter).not.toHaveBeenCalled()
  })

  it('keeps the png path and skips a text fallback when inline images are unsupported', async () => {
    m.displayInTerminal.mockReturnValue(false)
    expect(await renderShareCard(card)).toBe('/tmp/card.png')
    expect(m.copyFile).not.toHaveBeenCalled()
  })
})

describe('promptShareOnX', () => {
  it('gates on a bare enter and says so in the prompt', async () => {
    m.bareEnter.mockResolvedValue(false)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.bareEnter).toHaveBeenCalledWith(
      '(press enter to share) · anything else skips '
    )
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.openBrowser).not.toHaveBeenCalled()
  })

  it('saves to the desktop, copies the image, and opens X after enter', async () => {
    m.bareEnter.mockResolvedValue(true)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.copyFile).toHaveBeenCalledWith('/tmp/card.png', DESKTOP_CARD)
    expect(m.success).toHaveBeenCalledWith(`saved to ${DESKTOP_CARD}`)
    expect(m.copyToClipboard).toHaveBeenCalledWith('/tmp/card.png')
    expect(m.openBrowser).toHaveBeenCalledWith(
      `https://x.com/intent/tweet?text=${encodeURIComponent(shareTweetText(card, true))}`
    )
  })

  it('drops the cmd+v line from the tweet when the clipboard copy failed', async () => {
    m.bareEnter.mockResolvedValue(true)
    m.copyToClipboard.mockResolvedValue(false)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.success).not.toHaveBeenCalledWith('image copied to clipboard')
    const url = m.openBrowser.mock.calls[0]?.[0] as string
    expect(decodeURIComponent(url)).not.toContain('cmd+v')
  })

  it('says so instead of failing when the desktop copy cannot be written', async () => {
    m.bareEnter.mockResolvedValue(true)
    m.copyFile.mockRejectedValue(new Error('ENOENT'))
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.success).not.toHaveBeenCalledWith(`saved to ${DESKTOP_CARD}`)
    expect(m.info).toHaveBeenCalledWith(`could not save ${DESKTOP_CARD}`)
    expect(m.openBrowser).toHaveBeenCalled()
  })
})

describe('shareTweetText', () => {
  it('is tokens, paste hint, profile, then campaign tags when the image is on the clipboard', () => {
    expect(shareTweetText(card, true)).toBe(
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

  it('leaves out the paste hint when nothing was copied', () => {
    expect(shareTweetText(card)).toBe(
      [
        'I burned 1.5B tokens 🔥',
        '',
        'https://hacklab.so/bratos',
        '',
        '',
        '#joinhacklab #riplinkedin',
      ].join('\n')
    )
  })
})
