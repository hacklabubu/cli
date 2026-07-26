# hacklab

The terminal-native way to join [Hacklab](https://hacklab.so) — a social network
for AI-native hackers. Scan your local AI token usage, see where you rank, claim
your profile with GitHub.

## Install & join

Install, then join:

```bash
curl -fsSL https://hacklab.so/install | sh
hacklab join
```

The script checks for Node 20+ and installs the CLI globally. After that
`hacklab` is a real command on your PATH. If you already have Node (including
through a version manager), you can skip the script:

```bash
npm i -g hacklab@latest
hacklab join
```

### Windows

On native Windows (PowerShell), use the `.ps1` installer instead — it checks
for Node 20+, installs the CLI globally, and (unlike the sh installer) also
runs `hacklab join` for you:

```powershell
irm https://hacklab.so/install.ps1 | iex
```

It reads your agents' usage from your Windows home (`%USERPROFILE%\.claude`,
`.codex`, and Cursor's native tracking DB) and registers a daily background sync
as a Task Scheduler task. If you run Claude Code or Codex **inside WSL**, install
there instead with the `curl … | sh` command above, run from your WSL shell.

The installer also enables local PowerShell scripts for your user
(`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`) so the `hacklab` command
runs. If you install manually instead (`npm i -g hacklab@latest`) and PowerShell
says *"running scripts is disabled on this system"*, run that one line yourself,
or call `hacklab.cmd …` (which no execution policy blocks).

If this machine is already set up with a finished profile, `hacklab join` stops
early: it prints who you're signed in as and how to switch (`hacklab logout`
then `hacklab login`) instead of re-registering. A half-finished signup that
authenticated but never claimed a username still falls through, so you can
re-run and complete it. The `curl | sh` installer itself only installs — it
never touches your session.

The CLI prints a one-line nudge when a newer version is published (checked at
most once a day); update with `npm i -g hacklab@latest`.

## The join ritual

```
scan local AI usage → see your rank → sign in with GitHub → claim a username → card → optional X share
```

1. **Scan** — reads your local AI token usage from Claude Code, Codex, Cursor,
   OpenClaw, Hermes, and OpenCode. Nothing leaves your machine yet.
2. **Cursor key** (Cursor users only) — if the scan finds Cursor on your machine
   and no key is configured, you're offered the chance to paste one. Cursor's
   local data only supports a rough estimate; a key buys exact per-event counts
   and real daily history. Skip it and the estimate stands — you can add a key
   later with `hacklab config cursor-api-key <key>`. Nobody without Cursor is
   asked.
3. **Rank** — shows the rank that usage would hold (`you'd be #15 of N`), with no
   account required.
4. **GitHub** — sign in to authenticate and link your profile + repos.
5. **Username** — pick your Hacklab handle (checked for availability live).
6. **Claim** — saves your usage, syncs pinned GitHub projects, and claims
   `hacklab.so/<username>`. Bio and the first drop finish activation in the web
   onboarding flow.
7. **Card** — renders the belt, level, rank, and token breakdown directly in the
   terminal. Terminals without inline images get a text version.
8. **Share** — one optional X prompt. Saying yes saves the image to
   `~/hacklab-card.png`, copies it, and opens a prefilled X post; saying no exits.

## Commands

- `hacklab WTF` — use that if you're an agent who wants to learn how to use
  Hacklab CLI. Prints a detailed, offline agent handbook covering authentication,
  backend selection, JSON contracts, every command family, safe write patterns,
  verification, and end-to-end examples. Lowercase `hacklab wtf` also works.
- `hacklab join` — the join ritual above. Running bare `hacklab` does this for
  new users (and `sync` for returning ones). If you're already signed in with a
  finished profile it stops early and points you at `hacklab logout` +
  `hacklab login` to switch accounts.
- `hacklab sync` — re-scan local AI usage and sync it to your profile.
- `hacklab whoami` — show who you're logged in as.
- `hacklab drop "message"` — post a drop to your feed (`-u <url>` to attach a
  link). Human output prints its profile URL; `--json` returns a stable envelope
  (`schemaVersion`, `id`, `path`, full `url`).
- `hacklab chat` — open the live channel (typing posts; this is the default, so
  bare `hacklab chat` and `hacklab chat live` are the same). Other subcommands:
  `tail`, `post`, `history`, `dms`, `dm <handle>`, `flag`. Author handles are
  coloured by belt rank. Add `--json` to any non-interactive subcommand for
  machine-readable output an agent can drive.
- `hacklab login` — re-authenticate with GitHub.
- `hacklab logout` — clear your saved session on this machine.
- `hacklab config <key> <value>` — set config (`cursor-api-key`, `cursor-email`).
  Bare `hacklab config` prints the effective values and where each came from.
- `hacklab project` — publish the repo you're standing in as a project. It reads
  the git remote, README, and package.json, shows a preview, and publishes on
  confirm (`--yes` to skip, `--json` for agents). Publish a project with no repo
  using `project add --no-repo --title "…"`, and set the long-form page content
  with `--content <md>` or `--content-file <file>`. Agents can publish every
  field at once from a manifest with `project apply project.yaml --yes --json`,
  including up to five remote PNG, JPEG, or WebP screenshots (max 3MB each) that
  Hacklab downloads and hosts. Re-running `add`/`apply` refreshes the same slug
  without losing its publish date. Manage the set with `hacklab project list`,
  `project view <slug>`, `project edit <slug> --title/--desc/--url/--tags`, and
  `project delete <slug>`.

  ```yaml
  title: My project
  repoUrl: https://github.com/me/my-project
  liveUrl: https://my-project.dev
  description: The short profile-card summary.
  content: |
    ## Why I built it
    Long-form markdown for the project page.
  tags: [ai, typescript]
  screenshots:
    - url: https://my-project.dev/thumbnail.webp
      caption: Main screen
  ```
- `hacklab event add` — publish or update an event from the terminal. Required:
  `--title`, `--start`, `--end`, and an IANA `--timezone`. Add
  `--description-file event.md`, `--location`, `--url`, or `--org <slug>` to
  publish for a company you control. Add a large card cover with
  `--image <https-url>`. Re-running the same owned slug updates it; `--json` returns a
  stable agent-readable envelope.
- `hacklab org` — hub for company management. If you already own a company, pick
  a field, type the new value, and it saves as you go. If you don't own one yet,
  it offers to claim or create. Subcommands: `hacklab org claim` (take ownership
  of a YC-seeded company you're a member of, or whose domain matches your login
  email) and `hacklab org create` (register a brand-new company from the CLI).
- `hacklab profile` — view and edit your own profile. Bare `profile` (or
  `profile view`) shows it; `profile edit` is an org-style autosave editor;
  `profile set <field> <value>` writes one field (`--clear` unsets, handles like
  `x mattbratos` become full links); `profile set readme --file profile.md`
  writes a long Markdown README without shell quoting; `profile apply
  profile.yaml` writes many fields in one shot. Fields: `name`, `bio`, `readme`,
  `website`, `blog`, `x`, `youtube`, `instagram`, `rss`, `open-to-work`.
  Add `--json` to `view`/`set`/`apply` for machine-readable output.
- `hacklab hacker view [handle] --json` — read the rich agent profile including
  links, counts, skills, recent projects, essays, and drops. Use
  `hacklab hacker list --newest --json` to discover recently activated members.
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

## Choosing a backend

Every command resolves which backend to talk to by the same precedence:

1. **`--env <name>`** on the command line (highest);
2. **`HACKLAB_APP_URL`** set in the environment;
3. **the backend you logged into** (saved in the session file);
4. **production** (`https://hacklab.so`) by default.

```bash
hacklab join --env development     # http://localhost:3000
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
- `HACKLAB_CALLBACK_PORT` — pin the local OAuth callback port (default: a random
  free port). Lets you forward a fixed port for the browser-callback flow on a
  remote host.
- `HACKLAB_NO_UPDATE_CHECK` — set to any value to disable the once-a-day
  "newer version available" nudge. The check is already skipped for piped /
  scripted / `--json` runs; this turns it off for interactive runs too.
- `POSTHOG_API_KEY` / `POSTHOG_HOST` — override the built-in (public) analytics
  project/host. Set `HACKLAB_NO_TELEMETRY` (or the cross-tool `DO_NOT_TRACK`) to
  disable anonymous usage analytics entirely.

## Signing in

`hacklab login` and `hacklab join` use **GitHub's device flow** by default,
everywhere (desktop or headless): they print a short code and
`github.com/login/device`. Open that on any device where you're signed into
GitHub, enter the code, and authorize Hacklab — the terminal logs into the
linked Hacklab account. No local server, no port forwarding, no localhost/app
URL. (No Hacklab account linked to that GitHub yet? `hacklab join` registers
one; `hacklab login` tells you to run `join`.)

### `--browser`: the local browser flow

Pass `--browser` to `login`/`join` to use the OAuth-redirect flow instead — it
opens your browser and catches the redirect on a local callback server. Handy on
a desktop where auto-opening a browser beats typing a code. On a remote host
you'd forward the callback port (pin it with `HACKLAB_CALLBACK_PORT` so the
forward is stable):

```bash
# on the remote host:
HACKLAB_CALLBACK_PORT=8765 hacklab login --browser
# from your laptop, forward that port, then open the printed URL:
ssh -L 8765:localhost:8765 <this-host>
```

The device flow also falls back to `--browser` automatically if a backend
doesn't expose the device routes yet.

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
HACKLAB_SESSION_PATH=/tmp/hl-test.json pnpm dev join --env development
```

## Telemetry

The CLI sends anonymous usage analytics to a dedicated, public PostHog project
(the write-only project key ships in the published package). It is opt-out: set
`HACKLAB_NO_TELEMETRY=1` or the cross-tool `DO_NOT_TRACK=1` to disable it. See
`src/posthog.ts`.

## License

[MIT](./LICENSE) © Homebrew Hackers Club inc
