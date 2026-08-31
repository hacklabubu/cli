import { createInterface } from 'node:readline'

import { loadConfig, updateConfig } from './config.js'
import { bold, dim, info } from './ui.js'

/**
 * Consent for syncing anything derived from the user's Claude Code
 * conversations.
 *
 * Nothing conversation-derived leaves the machine until someone has answered
 * this explicitly. The tiers are additive:
 *
 *   none   token counts only — nothing prompt-related leaves the machine
 *   stats  + continuous prompt metadata: counts, word counts, timestamps and
 *          session ids, synced every minute alongside tokens, so the profile
 *          can show sessions, concurrent sessions and prompt counts. Prompt
 *          text never leaves the machine.
 *   full   + a rolling sample of the most recent prompts (up to 20,000
 *          characters) sent with the daily sync, used only to estimate a
 *          technical-level score and then discarded. Never stored.
 *
 * The answer is remembered in ~/.hacklab/config.json under `promptSync` so the
 * question is asked once, and can be changed or revoked at any time with
 * `hacklab config prompt-sync <tier>`.
 */

export const PROMPT_SYNC_TIERS = ['none', 'stats', 'full'] as const
export type PromptSyncTier = (typeof PROMPT_SYNC_TIERS)[number]

export function isPromptSyncTier(value: unknown): value is PromptSyncTier {
  return (
    typeof value === 'string' &&
    (PROMPT_SYNC_TIERS as readonly string[]).includes(value)
  )
}

/**
 * The stored answer, or null when the user has never been asked *this*
 * question. The pre-continuous-sync key (`promptStatsConsent`) is deliberately
 * not read: it answered a different question — a one-off scan, not a minutely
 * sync of session metadata — so it can't stand in for this one.
 */
export async function loadPromptSync(): Promise<PromptSyncTier | null> {
  const config = await loadConfig()
  return isPromptSyncTier(config.promptSync) ? config.promptSync : null
}

/**
 * Remember the answer. Read-modify-write via `updateConfig` rather than a bare
 * `saveConfig`, because the background jobs call this too and must never
 * flatten a config file they couldn't read. The obsolete key goes with it, so
 * a machine is never carrying two answers to two different questions.
 */
export async function savePromptSync(tier: PromptSyncTier): Promise<void> {
  await updateConfig((config) => {
    config.promptSync = tier
    delete config.promptStatsConsent
    return config
  })
}

/**
 * Read `--share-prompt-sync[=<tier>]` out of a command's args.
 *
 * This is the agent-friendly path: it answers the question up front so an
 * unattended run never blocks on a prompt it can't see. Bare
 * `--share-prompt-sync` means the metadata-only tier — the safe reading of an
 * unqualified yes, since sending prompt *text* should always be deliberate.
 * `--no-share-prompt-sync` is an explicit refusal.
 *
 * Returns the chosen tier, or null when the flag is absent. `rest` is the args
 * with the flag removed so per-command parsing never sees it.
 */
export function parsePromptSyncFlag(args: string[]): {
  tier: PromptSyncTier | null
  rest: string[]
} {
  const rest: string[] = []
  let tier: PromptSyncTier | null = null

  for (const arg of args) {
    if (arg === '--no-share-prompt-sync') {
      tier = 'none'
      continue
    }
    if (arg === '--share-prompt-sync') {
      tier = 'stats'
      continue
    }
    if (arg.startsWith('--share-prompt-sync=')) {
      const value = arg.slice('--share-prompt-sync='.length)
      tier = isPromptSyncTier(value) ? value : 'stats'
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
  console.log(bold('  sync your prompt activity?'))
  console.log('')
  info('  hacklab can keep your profile up to date with how you work with AI,')
  info(`  reading your Claude Code history from ${dim('~/.claude/projects')}.`)
  console.log('')
  info(`  ${bold('what would be synced, every minute:')}`)
  info('    how many prompts you send, and how long they are in words')
  info('    when each session started and last ran, and its session id')
  info('    a prompt count per project, matched by its git remote')
  console.log('')
  info(`  ${bold('what stays on this machine:')}`)
  info('    the text of your prompts, unless you separately say yes below')
  info('    anything from a project without a git remote')
  console.log('')
  info(dim('  your profile shows your sessions, how many you run at once, and'))
  info(dim('  your prompt counts. change or revoke this any time with'))
  info(dim('  `hacklab config prompt-sync <none|stats|full>`.'))
  console.log('')
}

/**
 * Resolve the prompt-sync tier for this run.
 *
 * Precedence: an explicit flag wins (and is remembered), then the stored
 * answer, then the interactive questions. An unattended run that has never
 * answered gets `none` — silence is never consent.
 */
export async function resolvePromptSync(
  flagTier: PromptSyncTier | null,
  opts: { interactive?: boolean } = {}
): Promise<PromptSyncTier> {
  if (flagTier) {
    await savePromptSync(flagTier)
    return flagTier
  }

  const stored = await loadPromptSync()
  if (stored) return stored

  if (!opts.interactive || !process.stdin.isTTY) return 'none'

  printDisclosure()

  const shareActivity = await askYesNo('  sync this to hacklab?')
  if (shareActivity === null) return 'none'
  if (!shareActivity) {
    await savePromptSync('none')
    console.log('')
    info(dim('  no problem — syncing token counts only.'))
    return 'none'
  }

  console.log('')
  info('  optional: a rolling sample of your most recent prompts (up to 20,000')
  info('  characters) can go out with the daily sync, so a model can estimate')
  info(
    `  how technical your prompting is. hacklab scores it and ${bold('discards it')} —`
  )
  info('  the text is never stored.')
  console.log('')

  const shareText = await askYesNo(
    '  also send a sample of your most recent prompts?'
  )
  const tier: PromptSyncTier = shareText === true ? 'full' : 'stats'
  await savePromptSync(tier)

  console.log('')
  info(
    dim(
      tier === 'full'
        ? '  syncing prompt activity and a text sample.'
        : '  syncing prompt activity. numbers only, no text.'
    )
  )
  return tier
}
