import { copyFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as clack from '@clack/prompts'

import { formatTokens } from './scanners/util.js'
import type { ShareCardData } from './share-card.js'
import { bold, dim, info, success } from './ui.js'
import { openBrowser } from './utils/openBrowser.js'

export type { ShareCardData } from './share-card.js'

function displayTextCard(card: ShareCardData) {
  const rank = card.rank > 0 ? `rank #${card.rank}` : 'unranked'
  clack.log.step('your hacklab card')
  clack.log.message(
    `${bold(`@${card.handle}`)} · lv.${card.level} ${card.title} (${card.beltColor} belt)`
  )
  clack.log.message(
    `${formatTokens(card.tokensTotal)} tokens · ${rank} · ${card.streak}d streak`
  )
  clack.log.message(`https://hacklab.so/${card.handle}`)
}

/** Generate the stats card and show it inline, with a text fallback. */
export async function renderShareCard(
  card: ShareCardData
): Promise<string | null> {
  try {
    const { generateShareCard, displayInTerminal } = await import(
      './share-card.js'
    )

    const cardPath = await generateShareCard(card)

    const imgBuf = Buffer.from(await readFile(cardPath))
    if (!displayInTerminal(imgBuf)) {
      displayTextCard(card)
    }

    return cardPath
  } catch {
    displayTextCard(card)
    return null
  }
}

/** One opt-in gates every sharing side effect: copy, save, and opening X. */
export async function promptShareOnX(
  card: ShareCardData,
  cardPath: string | null
): Promise<void> {
  const shareOnX = await clack.confirm({
    message: 'Share this card on X?',
  })
  if (!shareOnX || clack.isCancel(shareOnX)) return

  if (cardPath) {
    const dest = join(homedir(), 'hacklab-card.png')
    try {
      await copyFile(cardPath, dest)
      success(`saved to ${dest}`)
    } catch {
      info(dim(`could not save ${dest}`))
    }
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

  const text = encodeURIComponent(
    `I'm a lv.${card.level} ${card.title} (${card.beltColor} belt) on @hacklab_so with ${formatTokens(card.tokensTotal)} tokens burned.\n\nWhat's your power level?\nhacklab.so/${card.handle}`
  )
  await openBrowser(`https://x.com/intent/tweet?text=${text}`)
}
