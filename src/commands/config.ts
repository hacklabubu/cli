import {
  type CursorAuthSource,
  loadConfig,
  resolveCursorAuth,
  saveConfig,
} from '../config.js'
import { dim, error, info, success } from '../ui.js'

/**
 * Note where a value came from. Printing the *effective* value rather than the
 * file's is the point: with an env var or flag set, the file's value is dead
 * weight, and showing it would explain nothing about the numbers the user sees.
 */
function sourceNote(source: CursorAuthSource, envName: string): string {
  return source === 'env' ? dim(` (from ${envName} — overrides this file)`) : ''
}

export async function configCommand(args: string[]) {
  const [key, ...valueParts] = args
  const value = valueParts.join(' ')

  if (!key) {
    const auth = await resolveCursorAuth()
    console.log('')
    info('current config:')
    if (auth.apiKey) {
      info(
        `  cursor-api-key: ${dim(`${auth.apiKey.slice(0, 8)}...`)}${sourceNote(auth.apiKeySource, 'CURSOR_API_KEY')}`
      )
    }
    if (auth.email) {
      info(
        `  cursor-email:   ${auth.email}${sourceNote(auth.emailSource, 'CURSOR_EMAIL')}`
      )
    }
    if (!auth.apiKey && !auth.email) {
      info(`  ${dim('(empty)')}`)
    }
    console.log('')
    info('available keys:')
    info(`  ${dim('cursor-api-key')}  your Cursor API key — exact token counts`)
    info(
      `  ${dim('cursor-email')}    your Cursor account email — scopes a team key to you`
    )
    console.log('')
    info(dim('per-run overrides (both beat this file):'))
    info(dim('  hacklab --cursor-api-key <key> sync'))
    info(dim('  CURSOR_API_KEY=<key> hacklab sync'))
    console.log('')
    return
  }

  if (!value) {
    error(`usage: hacklab config ${key} <value>`)
    process.exit(1)
  }

  const config = await loadConfig()

  switch (key) {
    case 'cursor-api-key':
      config.cursorApiKey = value
      await saveConfig(config)
      success(`cursor-api-key saved`)
      break
    case 'cursor-email':
      config.cursorEmail = value
      await saveConfig(config)
      success(`cursor-email set to ${value}`)
      break
    default:
      error(`unknown config key: ${key}`)
      info(`available: cursor-api-key, cursor-email`)
      process.exit(1)
  }
}
