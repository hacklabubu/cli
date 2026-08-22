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
import { findCommand } from './registry.js'
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

// The help page is a curated, hand-grouped tour of the CLI — not a dump of the
// registry. That's deliberate: the registry stays the source of truth for
// dispatch, while this listing groups commands by what the user is trying to do
// and leaves out the niche ones (book, jobs, keys, scout) that would drown the
// core flow. Adding a command to the registry does NOT add it here — decide
// whether it belongs on the front page.
const HELP_GROUPS: Array<{
  title: string
  rows: Array<{ label: string; summary: string }>
}> = [
  {
    title: 'start here',
    rows: [
      {
        label: 'setup',
        summary: 'first run: scan, sign in, start the background sync',
      },
    ],
  },
  {
    title: 'auth',
    rows: [
      { label: 'login', summary: 'sign in with github' },
      { label: 'logout', summary: "clear this machine's session" },
      { label: 'whoami', summary: "who you're logged in as" },
    ],
  },
  {
    title: 'you',
    rows: [
      { label: 'profile', summary: 'view and edit your profile' },
      { label: 'referral', summary: 'your invite link' },
    ],
  },
  {
    title: 'game',
    rows: [
      { label: 'rules', summary: 'understand how the ranking works' },
      { label: 'scan', summary: 'scan this machine and share the card' },
      { label: 'sync', summary: 'upload local AI usage to your profile' },
    ],
  },
  {
    title: 'posting',
    rows: [
      { label: 'drop <message>', summary: 'post a drop' },
      { label: 'drops', summary: 'your drops' },
      { label: 'project', summary: 'add, list, and edit your projects' },
      { label: 'essay', summary: 'post, list, and update your essays' },
    ],
  },
  {
    title: 'people',
    rows: [
      { label: 'chat', summary: 'the live public chat channel' },
      { label: 'hacker', summary: 'view hacker profiles' },
    ],
  },
  {
    title: 'organisations',
    rows: [{ label: 'org', summary: 'create and edit your organisations' }],
  },
  {
    title: 'hackathons',
    rows: [{ label: 'hackathon', summary: 'RSVP, team up, and submit' }],
  },
  {
    title: 'manuals',
    rows: [
      { label: 'rtfm', summary: 'list all manuals' },
      {
        label: 'rtfm <topic>',
        summary:
          'print the manual: exact commands, prereqs, done-when criteria',
      },
    ],
  },
  {
    title: 'settings',
    rows: [
      { label: 'update', summary: 'update this CLI' },
      {
        label: 'daemon [off]',
        summary: 'summon the background sync (off tears it down)',
      },
      {
        label: 'config <key> <val>',
        summary: 'cursor key, email, prompt-stats',
      },
    ],
  },
  {
    title: 'flags',
    rows: [
      {
        label: '--json',
        summary: 'machine-readable output (agents: always use this)',
      },
      { label: '--help / -h', summary: 'show help for a command' },
      { label: '--version / -v', summary: 'show CLI version' },
    ],
  },
]

function printHelp() {
  banner()
  // Align the summaries: pad every label to the widest one across all groups so
  // the whole page reads as one table.
  const width = Math.max(
    ...HELP_GROUPS.flatMap((g) => g.rows.map((r) => r.label.length))
  )
  for (const { title, rows } of HELP_GROUPS) {
    console.log('')
    console.log(bold(`  ${title}`))
    for (const { label, summary } of rows) {
      console.log(`    ${dim(label.padEnd(width))}  ${summary}`)
    }
  }
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
  // that fix it (login), so we never nag mid-fix.
  if (process.stdout.isTTY && command.name !== 'login') {
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
