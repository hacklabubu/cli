import { createInterface } from 'node:readline'

import { loadConfig, saveConfig } from './config.js'
import { bold, dim, info } from './ui.js'

/**
 * Consent for uploading anything derived from the user's Claude Code
 * conversations.
 *
 * Nothing conversation-derived leaves the machine until someone has answered
 * this explicitly. The tiers are additive:
 *
 *   none   token counts only — exactly what the CLI did before this existed
 *   stats  + prompt-length histogram and per-project prompt counts (numbers
 *          only; no prompt text ever leaves the machine)
 *   full   + a sample of the raw prompt text, so the backend can score how
 *          technical the prompting is. It scores the sample and discards it.
 *
 * The answer is remembered in ~/.hacklab/config.json so the question is asked
 * once, and can be changed or revoked at any time with
 * `hacklab config prompt-stats <tier>`.
 */

export const PROMPT_CONSENT_TIERS = ['none', 'stats', 'full'] as const
export type PromptConsentTier = (typeof PROMPT_CONSENT_TIERS)[number]

export function isPromptConsentTier(
  value: unknown
): value is PromptConsentTier {
  return (
    typeof value === 'string' &&
    (PROMPT_CONSENT_TIERS as readonly string[]).includes(value)
  )
}

/** The stored answer, or null when the user has never been asked. */
export async function loadPromptConsent(): Promise<PromptConsentTier | null> {
  const config = await loadConfig()
  return isPromptConsentTier(config.promptStatsConsent)
    ? config.promptStatsConsent
    : null
}

export async function savePromptConsent(
  tier: PromptConsentTier
): Promise<void> {
  const config = await loadConfig()
  config.promptStatsConsent = tier
  await saveConfig(config)
}

/**
 * Read `--share-prompt-stats[=<tier>]` out of a command's args.
 *
 * This is the agent-friendly path: it answers the question up front so an
 * unattended run never blocks on a prompt it can't see. Bare
 * `--share-prompt-stats` means the numbers-only tier — the safe reading of an
 * unqualified yes, since sending prompt *text* should always be deliberate.
 * `--no-share-prompt-stats` is an explicit refusal.
 *
 * Returns the chosen tier, or null when the flag is absent. `rest` is the args
 * with the flag removed so per-command parsing never sees it.
 */
export function parsePromptStatsFlag(args: string[]): {
  tier: PromptConsentTier | null
  rest: string[]
} {
  const rest: string[] = []
  let tier: PromptConsentTier | null = null

  for (const arg of args) {
    if (arg === '--no-share-prompt-stats') {
      tier = 'none'
      continue
    }
    if (arg === '--share-prompt-stats') {
      tier = 'stats'
      continue
    }
    if (arg.startsWith('--share-prompt-stats=')) {
      const value = arg.slice('--share-prompt-stats='.length)
      tier = isPromptConsentTier(value) ? value : 'stats'
      continue
    }
    rest.push(arg)
  }

  return { tier, rest }
}

/**
 * Ask a yes/no question with no default: Enter alone re-asks, and only `y` or
 * `n` settles it. Deliberately not @clack/prompts' confirm, which ships a
 * highlighted default that can be accepted with a stray Enter — consent to
 * upload conversation data should never be something you agree to by
 * reflex.
 *
 * Returns null on a non-TTY stdin or EOF, which callers treat as "unanswered"
 * rather than as a yes.
 */
export async function askYesNo(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = await new Promise<string | null>((resolve) => {
        rl.question(`${question} ${dim('[y/n]')} `, (value) => resolve(value))
        rl.once('close', () => resolve(null))
      })
      if (answer === null) return null
      const normalized = answer.trim().toLowerCase()
      if (normalized === 'y' || normalized === 'yes') return true
      if (normalized === 'n' || normalized === 'no') return false
      // Anything else (including a bare Enter) is not an answer.
      console.log(dim('  please press y or n.'))
    }
  } finally {
    rl.close()
  }
}

/** The disclosure. Printed verbatim before the first question. */
function printDisclosure(): void {
  console.log('')
  console.log(bold('  share prompt stats?'))
  console.log('')
  info(
    '  hacklab can read your local Claude Code history to chart how you prompt.'
  )
  info(`  it is read on this machine, from ${dim('~/.claude/projects')}.`)
  console.log('')
  info(`  ${bold('what would be uploaded')}`)
  info('    how many prompts you have sent, and how long they are in words')
  info('    a prompt count per project, matched by its git remote')
  console.log('')
  info(`  ${bold('what would not')}`)
  info('    the text of your prompts, unless you separately say yes below')
  info('    anything from a project without a git remote')
  console.log('')
  info(
    dim('  hacklab stores the numbers on your profile. you can change or revoke')
  )
  info(dim('  this later with `hacklab config prompt-stats <none|stats|full>`.'))
  console.log('')
}

/**
 * Resolve the consent tier for this run.
 *
 * Precedence: an explicit flag wins (and is remembered), then the stored
 * answer, then the interactive questions. An unattended run that has never
 * answered gets `none` — silence is never consent.
 */
export async function resolvePromptConsent(
  flagTier: PromptConsentTier | null,
  opts: { interactive?: boolean } = {}
): Promise<PromptConsentTier> {
  if (flagTier) {
    await savePromptConsent(flagTier)
    return flagTier
  }

  const stored = await loadPromptConsent()
  if (stored) return stored

  if (!opts.interactive || !process.stdin.isTTY) return 'none'

  printDisclosure()

  const shareNumbers = await askYesNo('  share these numbers with hacklab?')
  if (shareNumbers === null) return 'none'
  if (!shareNumbers) {
    await savePromptConsent('none')
    console.log('')
    info(dim('  no problem — syncing token counts only, as before.'))
    return 'none'
  }

  console.log('')
  info(
    '  optional: a sample of your prompt text (up to 20k characters) can be'
  )
  info('  sent so an LLM can score how technical your prompting is. hacklab')
  info(`  scores it and ${bold('discards it')} — the text is never stored.`)
  console.log('')

  const shareText = await askYesNo('  also send a sample of your prompt text?')
  const tier: PromptConsentTier = shareText === true ? 'full' : 'stats'
  await savePromptConsent(tier)

  console.log('')
  info(
    dim(
      tier === 'full'
        ? '  sharing prompt stats and a text sample.'
        : '  sharing prompt stats. numbers only, no text.'
    )
  )
  return tier
}
