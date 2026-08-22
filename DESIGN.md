# CLI design

How new `hacklab` commands should look and behave. `hacklab login` is the
reference. Match it. Do not match older clack trees, boxed notes, or slogans.

This is the terminal UI for this repo. It is not the web app's visual system.

## Reference output

```
copy code
857F-61CE

https://github.com/login/device
(press enter)

signed in as @mattbratos
```

Every line earns its keep. There is no intro (`hacklab login`), no diamond
tree, no box, no `approved` spinner line, no email, no slogan.

## Rules

**No clack chrome on short flows.** Do not use `intro`, `outro`, `note`,
`log.step`, or boxed notes for login-shaped commands. Print with `console.log`
and the helpers in `src/ui.ts` (`bold`, `dim`, `link`). Use clack only when you
actually need a prompt widget (text, password, confirm, spinner *during* a wait).

**Dim label, bold value, no gap between them.**

```
copy code
857F-61CE
```

not

```
copy code

857F-61CE
```

Blank lines separate *beats* (code vs URL vs result), not a label from its
value.

**Don't repeat the command name.** They already typed `hacklab login`. An intro
that says `hacklab login` is noise.

**One job per command.** `login` creates or restores an account. `scan` reads
local usage and makes a card. `sync` uploads. Don't glue those into a ritual.

**Identity is `@handle`.** Print email only when there is no handle, or on
`whoami`. Don't show both unless asked.

**Production is silent.** Don't print `https://hacklab.so`. Name the server
only off production (`--env development`, custom `HACKLAB_APP_URL`).

**URLs are full, clickable, and copyable.** Use `link(url)` from `src/ui.ts`
(OSC-8 + visible URL). Never hide `https://` if someone might need to paste it.
A clickable link is not a substitute for copy: the visible text *is* the URL.

**Don't block background work on a keypress.** If the user can finish some
other way (click the link, authorize on a phone), start that work immediately.
Enter may *also* open a browser. Abort the Enter wait when the work completes
(`waitForEnter(prompt, abort.signal)`). Non-TTY skips the pause and continues.

**No leftover machinery.** Spinner stop text like `approved` is not a user
step. If a wait has no result line, `spinner.clear()` or don't use a spinner.

**Don't invent copy.** No "hack the planet", no "nothing to do — log out
first", no boxed how-tos. If they already did the thing, one line: `you already
joined as @handle` / `signed in as @handle`.

**Prefer deleting a flag to documenting it.** `--browser` died rather than
living as a second auth path.

## When you need a prompt

Ask one thing. Put the hint on the same beat (`(press enter)`, `(enter to
skip)`). Default to the common case. Don't confirm something you can just do
after printing the code they needed to see.

## Helpers

- `src/ui.ts` — `bold`, `dim`, `link`, `success` / `error` / `info` (`✓` / `✗` /
  `→`) for status commands like `whoami`
- `src/utils/waitForEnter.ts` — Enter pause; pass an `AbortSignal` if work
  runs in parallel
- `src/utils/openBrowser.ts` — best-effort open; never the only way to use a URL

## Do not

- Start a second clack session inside another command (`nested` intros)
- Print tool totals as double-spaced `log.message` lines if a tight block will do
- Guess a handle from an email. Fetch the profile (`/api/hackers/me`) if poll
  didn't send one
- Add compatibility shims for old output
