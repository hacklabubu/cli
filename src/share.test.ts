import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  confirm: vi.fn(),
  note: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  generateShareCard: vi.fn(),
  displayInTerminal: vi.fn(),
  copyToClipboard: vi.fn(),
  openBrowser: vi.fn(),
}))

vi.mock('@clack/prompts', () => ({
  confirm: m.confirm,
  note: m.note,
  isCancel: () => false,
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
vi.mock('./ui.js', () => ({
  bold: (value: string) => value,
  dim: (value: string) => value,
  info: m.info,
  success: m.success,
}))

import { promptShareOnX, renderShareCard, type ShareCardData } from './share.js'

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  m.generateShareCard.mockResolvedValue('/tmp/card.png')
  m.readFile.mockResolvedValue(Buffer.from('image'))
  m.displayInTerminal.mockReturnValue(true)
  m.copyToClipboard.mockResolvedValue(true)
})

describe('renderShareCard', () => {
  it('shows the card without copying, saving, or prompting', async () => {
    expect(await renderShareCard(card)).toBe('/tmp/card.png')
    expect(m.displayInTerminal).toHaveBeenCalled()
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it('shows a text card when inline images are unsupported', async () => {
    m.displayInTerminal.mockReturnValue(false)
    await renderShareCard(card)
    expect(m.note).toHaveBeenCalledWith(
      expect.stringContaining('@bratos'),
      'your hacklab card'
    )
  })
})

describe('promptShareOnX', () => {
  it('does nothing when sharing is declined', async () => {
    m.confirm.mockResolvedValue(false)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.copyFile).not.toHaveBeenCalled()
    expect(m.copyToClipboard).not.toHaveBeenCalled()
    expect(m.openBrowser).not.toHaveBeenCalled()
  })

  it('saves, copies, and opens X after one confirmation', async () => {
    m.confirm.mockResolvedValue(true)
    await promptShareOnX(card, '/tmp/card.png')
    expect(m.confirm).toHaveBeenCalledWith({
      message: 'Share this card on X?',
    })
    // Build the expected dest the way the code does so the separator matches
    // the host OS (backslashes on Windows, forward slashes elsewhere).
    expect(m.copyFile).toHaveBeenCalledWith(
      '/tmp/card.png',
      join('/home/hacker', 'hacklab-card.png')
    )
    expect(m.copyToClipboard).toHaveBeenCalledWith('/tmp/card.png')
    expect(m.openBrowser).toHaveBeenCalledWith(
      expect.stringContaining('https://x.com/intent/tweet?text=')
    )
  })
})
