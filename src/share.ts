import { copyFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatTokens } from './scanners/util.js'
import type { ShareCardData } from './share-card.js'
import { dim, info, success } from './ui.js'
import { openBrowser } from './utils/openBrowser.js'
import { waitForEnter } from './utils/waitForEnter.js'

export type { ShareCardData } from './share-card.js'

const SHARE_ORIGIN = 'https://hacklab.so'

/** Prefill for the X compose window. The png is already on the clipboard. */
export function shareTweetText(
  card: Pick<ShareCardData, 'handle' | 'tokensTotal'>
): string {
  return [
    `I burned ${formatTokens(card.tokensTotal)} tokens 🔥`,
    '',
    '(press cmd+v)',
    '',
    `${SHARE_ORIGIN}/${card.handle}`,
    '',
    '',
    '#joinhacklab #riplinkedin',
  ].join('\n')
}

function desktopCardPath(): string {
  return join(homedir(), 'Desktop', 'hacklab-card.png')
}

/** Generate the stats card and show it inline. Text fallback is the scan receipt. */
export async function renderShareCard(
  card: ShareCardData
): Promise<string | null> {
  try {
    const { generateShareCard, displayInTerminal } = await import(
      './share-card.js'
    )

    const cardPath = await generateShareCard(card)
    const imgBuf = Buffer.from(await readFile(cardPath))
    displayInTerminal(imgBuf)
    try {
      await copyFile(cardPath, desktopCardPath())
    } catch {
      // Desktop missing (headless/CI) — the working copy still lives in ~/.hacklab
    }
    return cardPath
  } catch {
    return null
  }
}

/** Enter opens X with the card; skip (or non-TTY) does nothing. */
export async function promptShareOnX(
  card: ShareCardData,
  cardPath: string | null
): Promise<void> {
  console.log('')
  const shareOnX = await waitForEnter('(press enter to share) ')
  if (!shareOnX) return

  if (cardPath) {
    try {
      const { copyToClipboard } = await import('./share-card.js')
      if (await copyToClipboard(cardPath)) {
        success('image copied to clipboard')
      }
    } catch {
      info(dim('could not copy the image to the clipboard'))
    }
  } else {
    info(dim('image unavailable — opening X with the post text only.'))
  }

  await openBrowser(
    `https://x.com/intent/tweet?text=${encodeURIComponent(shareTweetText(card))}`
  )
}
