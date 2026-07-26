# Offloading build/test on the shared box

hacklab's AI agents run in more than one place. Some run on a small **shared
sandbox box** where many agents work at once. This CLI is light — a `tsc` build
and a Vitest suite, seconds each, with no dev server / bundler / e2e — but when a
dozen agents all build and test at the same time it still bogs the box (and the
human's terminal). Others run on personal laptops or in CI, where building and
testing locally is completely fine.

So on the **sandbox box only**, build/test is **offloaded**: push the branch and
let **GitHub Actions** build + test it. There's no preview deployment to drive —
for a CLI, **CI is the whole verification**.

**This is enforced per machine, opt-in.** A machine counts as the sandbox only if
it's marked with `HACKLAB_SANDBOX=1` or a `~/.hacklab-sandbox` file — unmarked
machines (laptops, CI, fresh clones) are never restricted.

## The rule (on the sandbox box)

**Don't run these locally** (a `PreToolUse` hook blocks them there):

- `pnpm build`, `pnpm check`, bare `tsc` — the build / typecheck
- `pnpm test`, bare `vitest` — the test run
- `pnpm prepack` — build (runs during publish)

**Verify remotely instead:**

```sh
./scripts/verify-remote.sh
```

It pushes the branch, ensures a draft PR to `main`, and watches CI (Biome + the
`tsc` build + Vitest, incl. the native-Windows job). Green = good.

## What's fine locally (even on the sandbox)

- **Running the CLI** — `pnpm dev <command>` (tsx) or `node dist/index.js <command>`.
  You're executing the CLI, not building it.
- `pnpm install`, `git`, `gh`, `pnpm exec biome check .` — all light, all allowed.
- Vitest, when it *does* run (laptops/CI, or via the escape hatch), is **auto-capped
  to a single thread on the sandbox box** — see `vitest.config.ts` (`HACKLAB_SANDBOX`
  / `~/.hacklab-sandbox`, same marker). Laptops and CI run fully parallel.

## The enforcement hook (opt-in per machine)

`.claude/hooks/block-heavy-node.sh` is a `PreToolUse` Bash hook registered in
`.claude/settings.json`. It *loads* everywhere but only **enforces** on a marked
box:

- **Mark a box as the sandbox** (turn the block on): `touch ~/.hacklab-sandbox`
  (or export `HACKLAB_SANDBOX=1`).
- **Unmarked machines** (laptops, CI): the hook is a no-op — every command passes.
- **Un-mark:** `rm ~/.hacklab-sandbox`.

The marker is machine-local (never committed). The hook is **fail-open**: if it
can't parse a command it allows it, so it never wedges Bash.

**Escape hatch (on a marked box):** prefix a genuine one-off with `HACKLAB_ALLOW_HEAVY=1`:

```sh
HACKLAB_ALLOW_HEAVY=1 pnpm test
```

### Tuning

Because this CLI's build/test are so light, the block is as much about avoiding
pile-ups as preventing freezes. If you'd rather allow the fast local build/test
and lean only on the vitest single-thread cap, trim `build|check|test`, `tsc`, or
`vitest` out of the `HEAVY` pattern in `.claude/hooks/block-heavy-node.sh`.
