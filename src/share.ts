import { copyFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatTokens } from './scanners/util.js'
import type { ShareCardData } from './share-card.js'
import { dim, info, success } from './ui.js'
import { openBrowser } from './utils/openBrowser.js'
import { waitForBareEnter } from './utils/waitForEnter.js'

export type { ShareCardData } from './share-card.js'

const SHARE_ORIGIN = 'https://hacklab.so'

/**
 * Prefill for the X compose window. The paste line is only true when the png
 * really made it onto the clipboard — which only happens on macOS, so cmd is
 * the right modifier whenever it is printed at all.
 */
export function shareTweetText(
  card: Pick<ShareCardData, 'handle' | 'tokensTotal'>,
  clipboardReady = false
): string {
  return [
    `I burned ${formatTokens(card.tokensTotal)} tokens 🔥`,
    ...(clipboardReady ? ['', '(press cmd+v)'] : []),
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
    return cardPath
  } catch {
    return null
  }
}

/**
 * A bare Enter opens X with the card; typing anything first, or a non-TTY,
 * declines. That one opt-in gates every sharing side effect — the Desktop copy
 * included, so declining leaves the user's Desktop untouched.
 */
export async function promptShareOnX(
  card: ShareCardData,
  cardPath: string | null
): Promise<void> {
  console.log('')
  const shareOnX = await waitForBareEnter(
    `(press enter to share) ${dim('· anything else skips')} `
  )
  if (!shareOnX) return

  let clipboardReady = false
  if (cardPath) {
    const dest = desktopCardPath()
    try {
      await copyFile(cardPath, dest)
      success(`saved to ${dest}`)
    } catch {
      // Desktop missing (headless/CI) — the working copy still lives in ~/.hacklab
      info(dim(`could not save ${dest}`))
    }
    try {
      const { copyToClipboard } = await import('./share-card.js')
      clipboardReady = await copyToClipboard(cardPath)
      if (clipboardReady) success('image copied to clipboard')
    } catch {
      info(dim('could not copy the image to the clipboard'))
    }
  } else {
    info(dim('image unavailable — opening X with the post text only.'))
  }

  await openBrowser(
    `https://x.com/intent/tweet?text=${encodeURIComponent(shareTweetText(card, clipboardReady))}`
  )
}
