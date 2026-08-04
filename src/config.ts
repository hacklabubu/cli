import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type HacklabConfig = {
  cursorApiKey?: string
  cursorEmail?: string
  /**
   * Consent for uploading Claude Code conversation data: 'none' | 'stats' |
   * 'full'. Absent means never asked — see prompt-consent.ts, which owns the
   * tiers and treats an unset value as "ask", never as a yes.
   */
  promptStatsConsent?: string
}

const CONFIG_PATH = join(homedir(), '.hacklab', 'config.json')

/** Where a resolved credential came from, so `config` can show what actually wins. */
export type CursorAuthSource = 'env' | 'config' | 'none'

export type CursorAuth = {
  apiKey?: string
  email?: string
  apiKeySource: CursorAuthSource
  emailSource: CursorAuthSource
}

/**
 * Resolve the Cursor credentials from the three places a user can set them,
 * highest priority first:
 *
 *   1. `--cursor-api-key` / `--cursor-email`
 *   2. `CURSOR_API_KEY` / `CURSOR_EMAIL` in the environment
 *   3. `~/.hacklab/config.json` (written by `hacklab config cursor-api-key`)
 *
 * (1) and (2) collapse into one check here because index.ts parks the flags in
 * those same env vars before any command runs — the same trick `--env` uses for
 * HACKLAB_APP_URL. A flag therefore beats an inherited env var for free, and
 * `apiKeySource: 'env'` covers both.
 *
 * The email matters as much as the key: it scopes a *team* key to one member.
 * Without it, Cursor's filtered-usage-events endpoint returns every teammate's
 * events and we'd credit the whole team's tokens to one profile.
 */
export async function resolveCursorAuth(): Promise<CursorAuth> {
  const config = await loadConfig()
  const pick = (
    envName: string,
    configValue: string | undefined
  ): [string | undefined, CursorAuthSource] => {
    const envValue = process.env[envName]?.trim()
    if (envValue) return [envValue, 'env']
    if (configValue) return [configValue, 'config']
    return [undefined, 'none']
  }

  const [apiKey, apiKeySource] = pick('CURSOR_API_KEY', config.cursorApiKey)
  const [email, emailSource] = pick('CURSOR_EMAIL', config.cursorEmail)

  return { apiKey, email, apiKeySource, emailSource }
}

export async function loadConfig(): Promise<HacklabConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(raw) as HacklabConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: HacklabConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
