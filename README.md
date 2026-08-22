# hacklab

The terminal-native way to join [Hacklab](https://hacklab.so) — a social network
for AI-native hackers. Sign in with GitHub, scan your local AI token usage, share
a card.

## Install

Install, sign in, then scan this machine:

```bash
curl -fsSL https://hacklab.so/install | sh
hacklab login
hacklab scan
```

The script checks for Node 20+ and installs the CLI globally — that's all it
does. After it, `hacklab` is a real command on your PATH; `login` creates or
restores your account and `scan` uploads this machine's usage, shares the card,
and turns on the background daemon. If you already have Node 20 or newer
(including a version manager), you can skip the script:

```bash
npm i -g hacklab@latest
hacklab login
hacklab scan
```

### Windows

On native Windows (PowerShell), use the `.ps1` installer instead — it checks
for Node 20+ and installs the CLI globally, then points you at `hacklab login`
and `hacklab scan`:

```powershell
irm https://hacklab.so/install.ps1 | iex
```

The CLI reads your agents' usage from your Windows home (`%USERPROFILE%\.claude`,
`.codex`, `.grok`, and Cursor's native tracking DB), and `hacklab daemon` registers the
background sync as two Task Scheduler tasks. If you run Claude Code or Codex
**inside WSL**, install there instead with the `curl … | sh` command above, run
from your WSL shell.

The installer also enables local PowerShell scripts for your user
(`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`) so the `hacklab` command
runs. If you install manually instead (`npm i -g hacklab@latest`) and PowerShell
says *"running scripts is disabled on this system"*, run that one line yourself,
or call `hacklab.cmd …` (which no execution policy blocks).

The `curl | sh` installer itself only installs — it never touches your session.

The CLI prints a one-line nudge when a newer version is published (checked at
most once a day); update with `npm i -g hacklab@latest`.

## Scan

```
login → scan this machine → upload → card → share on X → daemon on
```

`hacklab scan` requires `hacklab login`. It reads local AI token usage from
Claude Code, Codex, Cursor, OpenClaw, Hermes, OpenCode, and Grok Build, uploads
it to your profile, and draws the card from the live account (real rank, belt,
streak — not a local postcard). Then it asks whether to share that card on X.
A successful scan summons the daemon so the card stays current; `hacklab scan
--no-daemon` skips the schedule, and `hacklab daemon off` tears it down.
Skip the whole command if this computer isn't yours — it would upload that
machine's usage to your profile. Cursor users with no API key are offered one
(local Cursor data is only an estimate).

## Commands

- `hacklab scan` — scan this machine, upload to your profile, share the card.
  Requires login. Summons the daemon afterwards (`--no-daemon` to skip).
- `hacklab sync` — re-scan local AI usage and sync it to your profile.
- `hacklab daemon` — summon the daemon: two OS-native background jobs (launchd on
  macOS, systemd user timers on Linux, Task Scheduler tasks on Windows) so your
  tokens, rank, and streak stay current without you running anything. A **tick
  every minute** reads only what your tools appended since the last run — no
  network call at all on a minute where nothing happened — and a **full sync once
  a day** re-scans everything and repairs whatever the tick missed. No daemon, no
  streak. Re-running it is idempotent; `hacklab daemon off` tears both down, and
  `hacklab logout` removes them too. On a platform we can't schedule (BSD, a
  locked-down box) it prints the commands to schedule yourself instead of
  pretending it worked. `hacklab sync --install-daily` still forwards here.
- `hacklab whoami` — show who you're logged in as.
- `hacklab drop "message"` — post a drop to your feed (`-u <url>` to attach a
  link). Human output prints its profile URL; `--json` returns a stable envelope
  (`schemaVersion`, `id`, `path`, full `url`).
- `hacklab chat` — open the live channel (typing posts; this is the default, so
  bare `hacklab chat` and `hacklab chat live` are the same). Other subcommands:
  `tail`, `post`, `history`, `dms`, `dm <handle>`, `flag`. Author handles are
  coloured by belt rank. Add `--json` to any non-interactive subcommand for
  machine-readable output an agent can drive.
- `hacklab login` — sign in with GitHub (creates an account if you don't have one).
- `hacklab logout` — clear your saved session on this machine.
- `hacklab config <key> <value>` — set config (`cursor-api-key`, `cursor-email`,
  `prompt-stats`).
  Bare `hacklab config` prints the effective values and where each came from.
- `hacklab project` — agent help for publishing a project to your profile.
  `project add --title "…" --url <url> [--desc "…"]` posts it (`--json` for
  agents). A github.com URL becomes the repo link; anything else is the live
  site. Re-run with the same title to update. `project view <handle>` lists
  someone else's work; `project view <handle>/<slug>` prints the full page.
  `project delete <slug>` removes one of yours.
- `hacklab essay` — agent help for posting an essay. `essay post --title "…"
  --content <md>` publishes it (`--file` for a markdown file on disk, `--json`
  for agents). `essay update <id>` replaces the body at the same URL.
  `essay view <id>` reads one; `essay view <handle>` lists theirs.
  `essay delete <id>` removes one of yours.
- `hacklab org` — hub for company management. If you already own a company, pick
  a field, type the new value, and it saves as you go. If you don't own one yet,
  it offers to claim or create. Subcommands: `hacklab org claim` (take ownership
  of a YC-seeded company you're a member of, or whose domain matches your login
  email) and `hacklab org create` (register a brand-new company from the CLI).
- `hacklab org access` — manage who controls a company, and at what level.
  Several people can be on one company's access list, at one of two roles:
  **admin**, who can do everything (edit the profile, change this list, post
  jobs), and **recruiter**, who can only reach `hacklab org jobs`. Bare `org
  access` (or `org access list`) shows everyone and their role; `org access
  grant <handle> [--role admin|recruiter]` adds someone (defaulting to admin —
  re-granting an existing person changes their role); `org access revoke
  <handle>` removes them — including yourself, though the last remaining
  **admin** can't be removed or demoted. Only admins change the list; a
  recruiter can stand down but nothing else. Use `--org <slug>` when you're on
  more than one, and `--json` on any of them for agents.
- `hacklab org jobs` — your company's Job Shop listings. Bare `org jobs` (or
  `org jobs list`) shows every listing you've posted and its status; `org jobs
  view <id>` reads one; `org jobs post` creates one, interactively or from
  flags (`--role`, `--description`, `--apply-url`, `--contact`, plus optional
  `--company`, `--company-url`, `--salary`, `--work-style`, `--min-belt`);
  `org jobs close <id>` takes a live one down early. A listing costs
  **$1,000**, so `post` can't finish in the terminal — it creates the listing
  and hands back a Stripe checkout link to open. Once that's paid we review it
  before it goes live, and it runs for 30 days. Admins and recruiters both
  reach all of this; `--json` on any subcommand for agents.
- `hacklab jobs` — browse the Job Shop. Bare `hacklab jobs` (or `jobs list`,
  with `--limit 1-100`) lists what's hiring; `jobs view <id>` reads one listing
  in full with its apply link. Read-only — posting is `hacklab org jobs post`.
  `hacklab jo` resolves to `jobs`.
- `hacklab profile` — view and edit your own profile. Bare `profile` (or
  `profile view`) shows it; `profile edit` is an org-style autosave editor;
  `profile set <field> <value>` writes one field (`--clear` unsets, handles like
  `x mattbratos` become full links); `profile set https://x.com/mattbratos`
  picks the field from the host (x, youtube, instagram, goodreads); `profile
  set readme --file profile.md` writes a long Markdown README without shell
  quoting; `profile apply profile.yaml` writes many fields in one shot. Fields:
  `name`, `bio`, `readme`, `website`, `blog`, `x`, `youtube`, `instagram`,
  `goodreads`, `rss`, `open-to-work`.
  Add `--json` to `view`/`set`/`apply` for machine-readable output.
- `hacklab hacker <username> --json` — read the rich agent profile including
  links, counts, skills, recent projects, essays, and drops.
- `hacklab hackathon` — RSVP, team up, and submit for a hacklab hackathon. Each
  event has a challenge mode — `open` (build anything, no theme or tracks),
  `theme` (one subject everyone builds to), or `tracks` (teams each pick one
  of several) — and the organizer may keep the theme/track list hidden from
  participants until the hackathon starts.
  `hackathon list [--past]` shows upcoming (or past) events; `hackathon view
  <slug>` shows one event's phase, highlights its next deadline (RSVP
  closes / teams lock / tracks lock / submissions due), and shows the
  challenge — the theme/tracks if revealed, or a note that it's announced
  when the hackathon starts; `hackathon rsvp <slug> [--token <t>]` RSVPs (an
  invite link from the organizer also works if you're not on the invite
  list); `hackathon invite <slug> --file <path>` or `--emails
  a@b.com,c@d.com` sends invites and lists every rejected line; `hackathon
  team create <slug> --name "X" [--summary S] [--max N] [--closed]` starts a
  team, `team join <slug> <teamSlug>` requests to join one, `team
  accept|reject <slug> <teamSlug> <handle>` decides a request, and `team list
  <slug>` lists teams; `hackathon track <slug> <teamSlug> <trackSlug>` sets a
  team's track (refused once the challenge is locked, or if this hackathon
  has no tracks); `hackathon tracks <slug>` prints the theme or track list on
  its own, honouring the same reveal rule; `hackathon submit <slug>
  <teamSlug> --title T --description D [--repo/--video/--site/--track]`
  submits a project; `hackathon export <slug> [--format csv|json] [--out
  <path>]` downloads the participant list (this contains personal data —
  handle exported files carefully). Every subcommand takes `--json` for
  agents.
- `hacklab --version` / `hacklab --help`.

## Cursor usage

Cursor is the one tool whose local data can't give exact numbers. Without a key
the scanner estimates from Cursor's commit-tracking database (AI lines written
× 30, all attributed to today, so no real daily history). With a key it reads
exact per-event token counts and real dates from Cursor's API.

Supply a key three ways, highest priority first:

```sh
hacklab --cursor-api-key <key> sync    # flag: one run
CURSOR_API_KEY=<key> hacklab sync      # env var: one shell / CI
hacklab config cursor-api-key <key>    # config file: persists
```

`--cursor-email <email>` / `CURSOR_EMAIL` / `hacklab config cursor-email` set the
account email, which resolves independently of the key. **If your key is a team
key, set the email.** Cursor's usage endpoint returns every team member's events
otherwise, and all of it would land on your profile as your own.

If a key is set but Cursor rejects it, the scan says so and falls back to the
local estimate — it won't quietly hand you an estimate you think is exact.

## Prompt stats

`sync` can also chart *how* you prompt, not just how many tokens you burned:
a histogram of your prompt lengths and a prompt count per project, shown on the
AI Usage tab of your profile. It reads your local Claude Code transcripts
(`~/.claude/projects`) on this machine.

Nothing conversation-derived is uploaded until you say so. The first
interactive `sync` asks, remembers the answer, and never asks again. There are
three tiers:

| Tier    | What leaves your machine |
| ------- | ------------------------ |
| `none`  | token counts only — exactly what the CLI did before this existed |
| `stats` | + prompt-length histogram and per-project counts. Numbers only; no prompt text |
| `full`  | + a sample of your prompt text (≤20k chars), scored for how technical it is and then discarded server-side |

Projects are matched by their git `origin` remote, so a prompt count only lands
on a project you've already added to hacklab (`hacklab brag`). Directories
without a git remote are skipped entirely.

Answer up front, without the prompt — the agent-friendly path:

```sh
hacklab sync --share-prompt-stats         # numbers only
hacklab sync --share-prompt-stats=full    # numbers + text sample
hacklab sync --no-share-prompt-stats      # refuse
```

Change or revoke it any time:

```sh
hacklab config prompt-stats none    # stop sharing; nothing further is uploaded
hacklab config                      # show the current tier
```

The unattended daily sync never asks. A machine that has never answered
uploads token counts only.

## Choosing a backend

Every command resolves which backend to talk to by the same precedence:

1. **`--env <name>`** on the command line (highest);
2. **`HACKLAB_APP_URL`** set in the environment;
3. **the backend you logged into** (saved in the session file);
4. **production** (`https://hacklab.so`) by default.

```bash
hacklab login --env development    # http://localhost:3000
hacklab drop "hi" --env dev        # the override applies to every command, not just login
```

`--env` accepts the named backends `production` and `development` (any
unambiguous abbreviation — `prod`, `dev` — plus the aliases `local`/`localhost`
for development). Under the hood it just sets `HACKLAB_APP_URL` for that run, so
an explicit `--env` overrides an inherited `HACKLAB_APP_URL`. To target any other
backend, set `HACKLAB_APP_URL` to its base URL directly:

```bash
HACKLAB_APP_URL=https://your-backend.example.com hacklab login
```

Note that **sessions are per-backend**: your token is only valid on the backend
you logged into. Overriding `--env` (or `HACKLAB_APP_URL`) to a backend you
haven't authenticated against will 401 until you `hacklab login` there.
`hacklab whoami` shows the effective backend and warns when it differs from where
you logged in.

## Environment

- `HACKLAB_APP_URL` — explicit app base URL (read from the real environment; the
  CLI does not load any `.env` file). A command-line `--env` sets this for the
  run, so `--env` wins over an inherited value. See **Choosing a backend** for
  the full precedence.
- `HACKLAB_SESSION_PATH` — custom path for the session file
  (default `~/.hacklab/session.json`).
- `HACKLAB_NO_UPDATE_CHECK` — set to any value to disable the once-a-day
  "newer version available" nudge. The check is already skipped for piped /
  scripted / `--json` runs; this turns it off for interactive runs too.
- `POSTHOG_API_KEY` / `POSTHOG_HOST` — override the built-in (public) analytics
  project/host. Set `HACKLAB_NO_TELEMETRY` (or the cross-tool `DO_NOT_TRACK`) to
  disable anonymous usage analytics entirely.

## Signing in

`hacklab login` uses **GitHub's device flow**, everywhere (desktop or headless):
it prints a short code and `github.com/login/device`. Open that on any device
where you're signed into GitHub, enter the code, and authorize Hacklab — the
terminal logs into the linked Hacklab account, creating one if needed. No local
server, no port forwarding, no localhost/app URL.

## Local development

Requires Node 20+ and [pnpm](https://pnpm.io). From the repo root:

```bash
pnpm install
pnpm dev <command>     # run from source (tsx, no build), e.g. `pnpm dev chat`
pnpm build             # compile to dist/
pnpm test              # run the vitest suite
```

`pnpm dev` is `tsx src/index.ts`, so it defaults to the **production** backend
like the published package. Point it elsewhere per-command with `--env
development` (localhost) or `HACKLAB_APP_URL=<url>`. Use a throwaway session to
avoid touching a real account:

```bash
HACKLAB_SESSION_PATH=/tmp/hl-test.json pnpm dev login --env development
```

## Telemetry

The CLI sends anonymous usage analytics to a dedicated, public PostHog project
(the write-only project key ships in the published package). It is opt-out: set
`HACKLAB_NO_TELEMETRY=1` or the cross-tool `DO_NOT_TRACK=1` to disable it. See
`src/posthog.ts`.

## License

[MIT](./LICENSE) © Homebrew Hackers Club inc
