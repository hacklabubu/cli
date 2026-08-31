import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What the OS-native background jobs were last installed with — written by
 * daily-sync.ts on a successful install, cleared on uninstall. `command`
 * fingerprints the scheduled `node <script>` pair plus the template generation
 * that produced the jobs, so a routine run can tell a working schedule from one
 * worth replacing; hour/minute pin the daily slot so a reinstall doesn't re-roll
 * it. Opaque here: daily-sync.ts owns the format.
 */
export type DailySyncRecord = {
  command: string
  hour?: number
  minute?: number
  /** False when the scheduler accepted the daily job but refused the minutely
   * tick (a Windows policy cap), so a later run doesn't read that machine as a
   * half-install and reinstall on every scan. */
  tick?: boolean
}

export type HacklabConfig = {
  cursorApiKey?: string
  cursorEmail?: string
  dailySync?: DailySyncRecord
  /**
   * Consent for syncing Claude Code conversation data: 'none' | 'stats' |
   * 'full'. Absent means never asked — see prompt-consent.ts, which owns the
   * tiers and treats an unset value as "ask", never as a yes.
   */
  promptSync?: string
  /**
   * The obsolete one-off prompt-stats consent. Declared only so
   * `savePromptSync` can delete it: it answered a narrower question (a scan
   * uploaded once a day) than `promptSync` asks, so it never carries over.
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

/**
 * Read-modify-write the config file for background callers that must not lose
 * the rest of it. Unlike `loadConfig`, which flattens every read failure to
 * `{}`, this refuses to write when the file exists but can't be parsed —
 * spreading `{}` over an unreadable config would silently drop the user's cursor
 * key and prompt-sync consent, and nothing here is worth that.
 *
 * `mutate` returns the config to write, or null for "nothing to change" (no
 * write at all — a background job shouldn't rewrite config.json for nothing).
 * Never throws: resolves true when the config reflects the mutation, false when
 * the write was refused or failed, so the caller can react to not being
 * remembered.
 */
export async function updateConfig(
  mutate: (config: HacklabConfig) => HacklabConfig | null
): Promise<boolean> {
  let current: HacklabConfig = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    // A file that parses to a non-object (`null`, an array, a bare string) is
    // just as unreadable as one that doesn't parse: refuse it too.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false
    }
    current = parsed as HacklabConfig
  } catch (err) {
    // No config yet is the normal first-run case; anything else means there IS
    // content we can't see, so leave it alone.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return false
  }

  const next = mutate(current)
  if (!next) return true
  try {
    await saveConfig(next)
    return true
  } catch {
    // Read-only home, no permission, disk full — the caller decides what to say.
    return false
  }
}
