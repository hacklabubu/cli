// The real CLI. Loaded via a dynamic import from index.ts *after* its Node
// version guard passes — so the Node 20+ APIs these imports reach (e.g.
// @clack/core's `styleText` from node:util) never link on an unsupported Node.
import { createRequire } from 'node:module'
import { clearSyncPaused, readSyncPaused } from './daily-sync.js'
import {
  captureException,
  maybePrintTelemetryNotice,
  shutdownTelemetry,
} from './posthog.js'
import { COMMANDS, findCommand } from './registry.js'
import { resolveCommand } from './resolve-command.js'
import {
  HACKLAB_ENVIRONMENTS,
  loadSession,
  resolveHacklabEnv,
} from './session.js'
import { banner, bold, dim } from './ui.js'
import { notifyIfOutdated } from './utils/updateCheck.js'

// Single source of the published version: read it from package.json (one level
// up from this module in both `dist/` and `src/`) instead of hardcoding a string
// that silently drifts from the real package version. `createRequire` resolves
// JSON the same way under tsx (dev) and the compiled bin.
const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json') as { version: string }

/**
 * The global flags, each mapping onto the env var the rest of the CLI already
 * reads. Going through the env is what makes precedence fall out for free: the
 * flag overwrites any inherited value, and the readers (getAppUrl,
 * resolveCursorAuth) prefer the env over the config file. It also means a value
 * passed once on the command line reaches anything the command shells out to.
 */
const GLOBAL_FLAGS: Record<string, (value: string) => void> = {
  '--env': (value) => {
    const env = resolveHacklabEnv(value)
    if (!env) {
      console.error(
        `--env must be one of: ${Object.keys(HACKLAB_ENVIRONMENTS).join(', ')} (abbreviations like dev/prod/stag work)`
      )
      process.exit(1)
    }
    process.env.HACKLAB_APP_URL = HACKLAB_ENVIRONMENTS[env]
  },
  '--cursor-api-key': (value) => {
    process.env.CURSOR_API_KEY = value
  },
  '--cursor-email': (value) => {
    process.env.CURSOR_EMAIL = value
  },
}

/**
 * Pull the global flags out of argv and apply them, returning the remaining args
 * so per-command parsing never sees them. Both `--flag value` and `--flag=value`
 * spellings work.
 */
function applyGlobalFlags(argv: string[]): string[] {
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const apply = GLOBAL_FLAGS[name]
    if (!apply) {
      rest.push(arg)
      continue
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (!value) {
      console.error(`${name} requires a value`)
      process.exit(1)
    }
    apply(value)
  }
  return rest
}

const [cmd, ...args] = applyGlobalFlags(process.argv.slice(2))

function printHelp() {
  banner()
  console.log('')
  console.log(bold('usage:'))
  // Align the descriptions: pad to the widest `name + args` so the summaries
  // line up no matter how the registry grows.
  const rows = COMMANDS.map((c) => ({
    label: c.args ? `${c.name} ${c.args}` : c.name,
    summary: c.summary,
  }))
  const width = Math.max(...rows.map((r) => r.label.length))
  for (const { label, summary } of rows) {
    console.log(
      `  hacklab ${dim(label)}${' '.repeat(width - label.length)}  ${summary}`
    )
  }
  console.log('')
  console.log(
    `  ${dim('--env')} ${dim('<production|development>')}          pick the backend (default: production)`
  )
  console.log(
    `  ${dim('--cursor-api-key')} ${dim('<key>')}                  exact Cursor usage (or ${dim('CURSOR_API_KEY')})`
  )
  console.log(
    `  ${dim('--cursor-email')} ${dim('<email>')}                  scope a Cursor team key to you (or ${dim('CURSOR_EMAIL')})`
  )
  console.log('')
}

// Node-version guard (T9). The CLI uses modern Node APIs (global fetch,
// AbortSignal.timeout). Fail fast with a clear message instead of a cryptic
// runtime error on an old runtime. The nvm hint matters because a piped
async function main() {
  // Bare `hacklab` (no command) prints help, same as `--help`/`-h`. Runs before
  // the update nudge so it reads as plain help, matching the `--help` path.
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp()
    process.exit(0)
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION)
    process.exit(0)
  }

  // One-time anonymous-telemetry notice (interactive only, shown once). Before
  // the update nudge so, on the very first run, consent is disclosed above any
  // other output.
  await maybePrintTelemetryNotice()

  // One-line nudge if a newer hacklab is published (interactive only, cached
  // daily, timeout-guarded). Must run before any command output so it reads as
  // a header, not buried in results.
  await notifyIfOutdated(VERSION)

  // Resolve a possibly-abbreviated command to its full name (e.g. `sy` -> sync,
  // `or` -> org). Exact matches always win; an ambiguous prefix is
  // rejected with the candidates so the user can disambiguate.
  const resolution = resolveCommand(cmd)
  if (resolution.kind === 'ambiguous') {
    console.error(
      `ambiguous command "${cmd}": ${resolution.matches.join(' or ')}?`
    )
    process.exit(1)
  }

  const command =
    resolution.kind === 'match' ? findCommand(resolution.name) : undefined
  if (!command) {
    console.error(`unknown command: ${cmd}`)
    console.error('run hacklab --help for usage')
    process.exit(1)
  }

  // Surface a paused daily background sync (e.g. the session expired while the
  // machine was off) once, then clear the marker. Skipped for the auth commands
  // that fix it (login/join), so we never nag mid-fix.
  if (
    process.stdout.isTTY &&
    command.name !== 'login' &&
    command.name !== 'join'
  ) {
    const paused = await readSyncPaused()
    if (paused) {
      console.error(dim(`paused: daily background sync — ${paused}`))
      await clearSyncPaused()
    }
  }

  await command.run(args)

  // Best-effort final flush for the happy path. Per-event captures already flush
  // eagerly (flushAt: 1), so this mainly drains any autocaptured exception.
  await shutdownTelemetry()
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  const session = await loadSession().catch(() => null)
  await captureException(err, session?.handle)
  await shutdownTelemetry()
  process.exit(1)
})
