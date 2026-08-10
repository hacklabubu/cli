import { book, parseBookArgs } from './commands/book.js'
import { chat } from './commands/chat.js'
import { configCommand } from './commands/config.js'
import { daemon } from './commands/daemon.js'
import { drop, parseDropArgs } from './commands/drop.js'
import { essay } from './commands/essay.js'
import { hackathon } from './commands/hackathon.js'
import { hacker } from './commands/hacker.js'
import { jobs } from './commands/jobs.js'
import { join } from './commands/join.js'
import { keys } from './commands/keys.js'
import { login } from './commands/login.js'
import { logout } from './commands/logout.js'
import { org } from './commands/org.js'
import { profile } from './commands/profile.js'
import { project } from './commands/project.js'
import { referral } from './commands/referral.js'
import { scout } from './commands/scout.js'
import { sync } from './commands/sync.js'
import { update } from './commands/update.js'
import { whoami } from './commands/whoami.js'

// A single command registry: the one place a top-level `hacklab` subcommand is
// declared. Dispatch (index.ts), prefix resolution (resolve-command.ts), and the
// `--help` listing all derive from this array, so adding or renaming a command
// is a one-line change here instead of three edits that can drift apart.
export type CommandSpec = {
  /** The full command name, e.g. `chat`. */
  name: string
  /** Args shown after the name in help, e.g. `<key> <val>`. Omit if it takes none. */
  args?: string
  /** One-line description shown in `hacklab --help`. */
  summary: string
  /** Run the command with the per-command args (the global `--env` is already stripped). */
  run: (args: string[]) => Promise<void> | void
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'join',
    args: '[--browser]',
    summary: 'join hacklab from your terminal',
    run: (args) => join({ browser: args.includes('--browser') }),
  },
  {
    name: 'sync',
    summary: 'sync AI token usage to your profile',
    run: (args) => sync(args),
  },
  {
    name: 'daemon',
    args: '[off]',
    summary: 'summon the daily background sync (off tears it down)',
    run: (args) => daemon(args),
  },
  {
    name: 'whoami',
    summary: "check who you're logged in as",
    run: () => whoami(),
  },
  {
    name: 'drop',
    args: '"message"',
    summary: 'post a drop to your feed (--json for agents)',
    run: (args) => {
      const { text, url, json } = parseDropArgs(args)
      return drop(text, url, json)
    },
  },
  {
    name: 'login',
    args: '[--browser]',
    summary:
      're-authenticate with github (--browser for the local browser flow)',
    run: (args) => login({ browser: args.includes('--browser') }),
  },
  {
    name: 'logout',
    summary: 'clear your saved session on this machine',
    run: () => logout(),
  },
  {
    name: 'config',
    args: '<key> <val>',
    summary: 'set config (cursor-api-key, cursor-email)',
    run: (args) => configCommand(args),
  },
  {
    name: 'project',
    args: '[add|apply|list|view|edit|delete]',
    summary: 'publish & manage your projects (--json for agents)',
    run: (args) => project(args),
  },
  {
    name: 'book',
    args: '"Title" --author "Name"',
    summary: 'shelve a book you have read (--takeaways "…")',
    run: (args) => book(parseBookArgs(args)),
  },
  {
    name: 'org',
    args: '[list|view|set|apply|claim|create|access|jobs]',
    summary:
      'claim, create, edit, share, or hire for your organization (--json for agents)',
    run: (args) => org(args),
  },
  {
    name: 'jobs',
    args: '[list|view]',
    // Note `jo` is now ambiguous (jobs/join) — `job` and `joi` still resolve.
    // Same trade already taken for `org a` (access/apply): a real command is
    // worth more than one saved keystroke on an abbreviation.
    summary: 'browse the job shop (--json for agents)',
    run: (args) => jobs(args),
  },
  {
    name: 'chat',
    args: '[sub]',
    summary: 'open the live channel (or tail/post/dm/…; --json for agents)',
    run: (args) => chat(args),
  },
  {
    name: 'essay',
    args: '[sub]',
    summary: 'post and manage essays (post/list/view/update/delete)',
    run: (args) => essay(args),
  },
  {
    name: 'hacker',
    args: '[view|list]',
    summary: 'view a hacker or list newest members (--json for agents)',
    run: (args) => hacker(args),
  },
  {
    name: 'hackathon',
    args: '[list|view|rsvp|invite|team|track|tracks|submit|export]',
    summary: 'RSVP, team up, and submit for a hackathon (--json for agents)',
    run: (args) => hackathon(args),
  },
  {
    name: 'scout',
    args: 'search|picks [flags]',
    summary:
      'talent scouting for partners: search the pool, or our curated picks (invite-only)',
    run: (args) => scout(args),
  },
  {
    name: 'profile',
    args: '[view|set|edit|apply]',
    summary: 'view and edit your own profile (--json for agents)',
    run: (args) => profile(args),
  },
  {
    name: 'referral',
    args: '[--json]',
    summary:
      'get your referral link to invite hacker friends (--json for agents)',
    run: (args) => referral(args),
  },
  {
    name: 'keys',
    args: '[create|list|revoke]',
    summary: 'manage API keys for your agent profile endpoint',
    run: (args) => keys(args),
  },
  {
    name: 'update',
    summary: 'update the hacklab CLI to the latest version',
    run: () => update(),
  },
]

/** Every command name, in registry order — the source of truth for resolution. */
export const COMMAND_NAMES = COMMANDS.map((c) => c.name)

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name)
}
