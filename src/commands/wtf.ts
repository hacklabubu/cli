/**
 * A self-contained operating manual for autonomous agents. Keep this output
 * plain and dependency-free: it must work before login, without a network, and
 * remain easy to paste directly into an agent context window.
 */
export const WTF_GUIDE = `# Hacklab CLI agent handbook

Use this document when you are an AI agent operating Hacklab on behalf of a
human. It explains how to discover people, publish work, manage a profile or
organization, create events, participate in the community, and do all of that
without guessing at state or corrupting machine-readable output.

This command is documentation only. It does not log in, contact the network, or
grant permission to change anything. Your authority still comes from the human
who invoked you. Treat every write, deletion, public post, direct message,
organization claim, and API-key operation according to that authority.

## The shortest safe operating loop

1. Establish the target backend. Production is https://hacklab.so. Local
   development is http://localhost:3000. Never assume which one the operator
   intended when the distinction matters.
2. Check authentication with hacklab whoami. A session belongs to the backend
   where it was created; a production token will not authenticate locally.
3. Read current state with a view or list command and --json before changing it.
4. Make the smallest explicit change. Prefer non-interactive subcommands,
   complete flags, manifests, --yes where authorization is already clear, and
   --json when the command supports it.
5. Parse stdout as data. Treat a non-zero exit code or an error envelope as a
   failure. Do not scrape decorative human output when JSON is available.
6. Verify the result with a fresh view/list call. Report the returned slug, id,
   path, or URL to the operator.

## Invocation and command discovery

The executable is hacklab. Run hacklab with no arguments for the short command
index, hacklab --help for the same index, and hacklab WTF for this handbook.
Top-level command names accept an unambiguous prefix, but agents should use full
names in generated scripts so a future command cannot make a prefix ambiguous.

Global flags may appear before or after a command. The important one is:

    hacklab --env production whoami
    hacklab whoami --env development

Accepted environment names are production and development. Unambiguous forms
such as prod and dev work, as do local and localhost for development. A custom
backend can be selected with HACKLAB_APP_URL. Resolution order is:

1. --env on this invocation
2. HACKLAB_APP_URL in the process environment
3. the appUrl stored with the current session
4. https://hacklab.so

The CLI does not load .env files for you. HACKLAB_SESSION_PATH selects an
alternate session file, which is useful for isolated automation or local tests.
Never print, commit, upload, or expose that file: it contains a bearer token.

## Authentication

Use hacklab join for a GitHub identity that has never joined Hacklab. Use
hacklab login to authenticate an existing account. Both use GitHub's device
flow by default and can use the browser callback flow with --browser.

    hacklab join
    hacklab login
    hacklab login --env development
    hacklab login --browser
    hacklab whoami
    hacklab logout

Login sessions are backend-specific. If a JSON request returns unauthorized
after changing --env, authenticate against that target instead of retrying the
same token. Logout deletes the saved local session; treat that as a state change
and do not invoke it merely to diagnose a request.

## Machine-readable behavior

Prefer --json for agent-driven, non-interactive work. Commands that support it
write their data to stdout and send human diagnostics to stderr. Successful
responses generally include schemaVersion: 1 plus command-specific fields.
Failures generally use this shape:

    {
      "schemaVersion": 1,
      "error": {
        "code": "machine_readable_code",
        "message": "actionable explanation"
      }
    }

Do not assume every command has identical success fields. Read the actual JSON,
preserve full identifiers, and use returned paths and URLs. A non-zero process
exit means the action did not complete even if stderr contains a helpful hint.
Do not mix human output into a JSON parser. Commands such as interactive chat,
profile edit, and the bare organization hub are for humans; choose their direct
subcommands for automation.

## Identity and profile

Read your own profile before editing it:

    hacklab profile view --json

Set one field explicitly:

    hacklab profile set bio "Building useful agents" --json
    hacklab profile set website https://example.com --json
    hacklab profile set open-to-work yes --json
    hacklab profile set readme --file profile.md --json
    hacklab profile set x --clear --json

Supported profile fields are name, bio, readme, website, blog, x, youtube,
instagram, rss, and open-to-work. Use --file for long Markdown instead of
forcing it through shell quoting. Use --clear only when the operator has asked
to remove a value.

Apply several fields atomically from YAML or JSON:

    hacklab profile apply profile.yaml --json

Example profile.yaml:

    name: Ada Builder
    bio: I build tools that help agents ship.
    website: https://ada.example
    open-to-work: true
    readme: |
      ## Current focus
      Reliable agent infrastructure and human-agent collaboration.

The bare hacklab profile and hacklab profile edit commands open interactive
human interfaces. Agents should use view, set, or apply.

## Discovering hackers

Read a rich public profile, including links, counts, skills, recent projects,
essays, and drops:

    hacklab hacker view mattbratos --json
    hacklab hacker view --json

With no handle, view uses the authenticated hacker when possible. Discover
recently activated people with a bounded result set:

    hacklab hacker list --newest --limit 20 --json

Never infer a person's identity from display name alone. Keep the exact handle
returned by Hacklab when constructing profile paths, direct messages, or
reports.

## Projects

Read before writing:

    hacklab project list --json
    hacklab project view <slug> --json

Publish the repository in the current directory:

    hacklab project add . --yes --json

The add command can infer the git remote, README, and package metadata. Override
fields explicitly with --title, --desc, --url, --repo, --live, --tags, --slug,
--content, or --content-file. Use --no-repo with --title to publish work that
does not have a repository.

For deterministic agent writes, prefer a YAML or JSON manifest:

    hacklab project apply project.yaml --yes --json

Example project.yaml:

    title: My Agent Project
    repoUrl: https://github.com/example/agent-project
    liveUrl: https://agent-project.example
    description: A short profile-card summary.
    content: |
      ## Why it exists
      Long-form Markdown for the project page.
    tags:
      - agents
      - typescript
    screenshots:
      - url: https://agent-project.example/cover.webp
        caption: Main screen

Remote screenshots must be PNG, JPEG, or WebP, up to five files and 3 MB each.
Re-running add or apply for the same owned project refreshes it without losing
its original publication date.

Edit or delete only after resolving the exact slug:

    hacklab project edit <slug> --title "New title" --json
    hacklab project edit <slug> --clear-live --json
    hacklab project delete <slug> --yes --json

Deletion is destructive. Do not add --yes unless the operator clearly approved
the exact target.

## Events and hackathons

Publish an event with explicit ISO timestamps and an IANA timezone:

    hacklab event add \\
      --title "Warsaw Agent Hack" \\
      --summary "A weekend for building ambitious agent-native software." \\
      --start "2026-09-12T09:00:00+02:00" \\
      --end "2026-09-13T18:00:00+02:00" \\
      --timezone "Europe/Warsaw" \\
      --location "Warsaw, Poland" \\
      --url "https://example.com/hackathon" \\
      --image "https://example.com/hackathon-cover.webp" \\
      --json

Required fields are --title, --start, --end, and --timezone. Optional fields are
--slug, --summary, --description, --description-file, --location, --url,
--image, and --org. Use --description-file for long Markdown. URLs must use
HTTP or HTTPS, the end must be after the start, and the timezone must be a
valid IANA name.

Without --org, the authenticated hacker is the public organizer. With
--org <slug>, the organization is displayed as organizer and the server verifies
that the authenticated user controls it. Never claim organizational authority
without checking hacklab org list --json first.

The title derives the slug unless --slug is supplied. Re-running an event slug
owned by the same hacker updates that event; another hacker cannot overwrite it.
Capture the event.path returned in JSON and verify it on the Events page.

Join an event and make your team intent public:

    hacklab event going <event-slug> --json
    hacklab event going <event-slug> --status looking --json
    hacklab event going <event-slug> --status solo --json

The default status is going. Looking means you want teammates; solo means you
intend to ship alone. Once accepted onto a team, your public state becomes that
team and you must leave it before switching back to looking or solo.

Browse the real roster and team directory before taking action:

    hacklab event hackers <event-slug> --json
    hacklab event teams <event-slug> --json
    hacklab event team view <event-slug> <team-slug> --json

Create a team with a bounded capacity and Markdown briefing:

    hacklab event team create <event-slug> \
      --name "Terminal Goblins" \
      --summary "Agent infrastructure with sharp edges." \
      --readme-file team.md \
      --avatar "https://example.com/team.webp" \
      --max-members 4 \
      --json

The creator becomes captain. Team images are square in the interface. Add
--closed when the team should be visible but not accept requests. A hacker can
belong to only one accepted team per event.

Joining uses a private request that only the captain can review:

    hacklab event team request <event-slug> <team-slug> --json
    hacklab event team accept <event-slug> <team-slug> <handle> --json
    hacklab event team reject <event-slug> <team-slug> <handle> --json
    hacklab event team leave <event-slug> <team-slug> --json

Pending requests are intentionally not exposed in the public roster. Do not
accept or reject for a captain unless the operator explicitly authorized that
decision. Captains cannot leave their own team in this first version.

## Organizations

Discover the organizations the current user manages or may claim:

    hacklab org list --json
    hacklab org view --org <slug> --json

Edit one field or apply a manifest:

    hacklab org set description "We build developer tools." --org <slug> --json
    hacklab org set website https://example.com --org <slug> --json
    hacklab org set hiring yes --org <slug> --json
    hacklab org apply org.yaml --org <slug> --json

Claiming and creating organizations change public ownership state. First read
the candidate list, confirm the exact slug and the operator's authority, then:

    hacklab org claim <slug> --json
    hacklab org create --name "Example Labs" --slug example-labs --json

The bare hacklab org command is an interactive human hub. Agents should use
list, view, set, apply, claim, or create with explicit arguments.

## Drops, chat, essays, books, and referrals

Post a short public update with an optional link:

    hacklab drop "Shipping our first agent workflow today." --json
    hacklab drop "Demo and source" --url https://example.com --json

A drop is public communication. Preserve the operator's voice and do not post
speculative claims, secrets, private links, or content they did not authorize.

Use non-interactive chat verbs for agents:

    hacklab chat tail --json
    hacklab chat history --before <cursor> --json
    hacklab chat post "message" --json
    hacklab chat dms --json
    hacklab chat dm <handle> --json
    hacklab chat dm <handle> "message" --json
    hacklab chat flag <message-id> <reason> --json

Bare hacklab chat opens a live interactive channel. Do not use it in automation.
Direct messages and moderation flags have real social consequences; confirm the
recipient or target id and the operator's intent.

Publish and manage Markdown essays:

    hacklab essay post essay.md --title "Title" --json
    hacklab essay list --json
    hacklab essay list <handle> --page 2 --json
    hacklab essay list org <slug> --json
    hacklab essay view <id> --json
    hacklab essay update <id> essay.md --title "Updated title" --json
    hacklab essay delete <id> --yes --json

Essay IDs may be addressed by a unique prefix, but agents should retain and use
the full id from JSON whenever possible. Delete only with explicit approval.

Record a book and an optional takeaway:

    hacklab book "The Pragmatic Programmer" --author "David Thomas and Andrew Hunt"
    hacklab book "Designing Data-Intensive Applications" \\
      --author "Martin Kleppmann" --takeaways "Make state and failure explicit."

Get an authenticated referral link in a machine-readable envelope:

    hacklab referral --json

## Usage synchronization and Cursor configuration

Synchronize supported local AI-tool usage to the authenticated profile:

    hacklab sync
    hacklab sync --install-daily

The daily option installs recurring local automation. Do not install background
jobs without the operator's permission. Cursor usage can be configured with:

    hacklab config cursor-api-key <key>
    hacklab config cursor-email <email>

An API key is sensitive. Prefer environment variables for ephemeral automation:
CURSOR_API_KEY and CURSOR_EMAIL. If using a team Cursor key, provide the email
so another member's usage is not attributed to the operator.

## Talent scouting and API keys

Partner-only scouting commands are invite-gated:

    hacklab scout search --new-this-week --open-to-work --limit 20 --json
    hacklab scout search --new-since <iso> --sort streak --json
    hacklab scout picks --json

Treat scouting data as people data. Use it only for the purpose authorized by
the operator, keep result sets bounded, and do not bulk-message candidates.

Personal Hacklab API keys are managed with:

    hacklab keys create "my agent"
    hacklab keys list
    hacklab keys revoke <id>

Key creation returns a secret that may be shown only once. Never place it in a
prompt transcript, command log, commit, issue, or chat message. Revocation is a
write: resolve the exact key id and confirm intent first.

## Reliability rules for agents

- Prefer full command and flag names over abbreviations.
- Prefer --json and explicit subcommands over interactive interfaces.
- Keep stdout clean when another process will parse it.
- Quote shell values. Use files or manifests for multiline Markdown.
- Treat handles, slugs, ids, cursors, and returned paths as opaque identifiers.
- Use ISO 8601 timestamps with explicit offsets and an IANA timezone for events.
- Read current state before editing or deleting it.
- Do not retry unauthorized requests blindly; verify the backend and session.
- Do not retry validation errors unchanged; fix the named field.
- A 409 conflict usually needs a different slug or a fresh read, not force.
- Bound list and scouting requests with --limit or pagination.
- Never expose session tokens, API keys, OAuth credentials, or private content.
- Do not invoke --yes unless approval for that exact write already exists.
- Verify every public write and report the resulting URL or path.
- Stop and ask when identity, ownership, target, visibility, or destructive
  intent is ambiguous.

## End-to-end examples

Inspect and improve the current profile:

    hacklab whoami
    hacklab profile view --json
    hacklab profile set bio "Building reliable coding agents." --json
    hacklab profile view --json

Publish a repository deterministically:

    hacklab project list --json
    hacklab project apply project.yaml --yes --json
    hacklab project view <returned-slug> --json

Create an organization-backed hackathon:

    hacklab org list --json
    hacklab event add --title "Agent Weekend" \\
      --start "2026-10-03T09:00:00+02:00" \\
      --end "2026-10-04T18:00:00+02:00" \\
      --timezone "Europe/Warsaw" --org <controlled-org-slug> --json

Participate without entering an interactive UI:

    hacklab chat tail --json
    hacklab hacker view <handle> --json
    hacklab drop "A factual, operator-approved update." --json

When finished, return a concise report: backend used, reads performed, writes
performed, ids/slugs/URLs returned, verification results, and any remaining
uncertainty. Do not claim success from a command you did not verify.`

export function wtf(): void {
  console.log(WTF_GUIDE)
}
