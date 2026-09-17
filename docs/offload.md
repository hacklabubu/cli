# Optional build/test offloading

Build/test offloading is an **opt-in, per-machine** setting for a resource-constrained
dev sandbox. It is not required for contributors.

Enable it with `HACKLAB_SANDBOX=1` or a `~/.hacklab-sandbox` file. On marked
machines, push the branch and let **GitHub Actions** build + test it instead of
running builds and tests locally. Unmarked machines are unrestricted.

## The rule (on marked machines)

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

## What's fine locally

- **Running the CLI** — `pnpm dev <command>` (tsx) or `node dist/index.js <command>`.
  You're executing the CLI, not building it.
- `pnpm install`, `git`, `gh`, `pnpm exec biome check .` — all light, all allowed.
- Vitest, when run via the escape hatch, is **auto-capped to a single thread**
  on marked machines — see `vitest.config.ts` (`HACKLAB_SANDBOX` /
  `~/.hacklab-sandbox`, same marker). Unmarked machines and CI run fully parallel.

## The enforcement hook (opt-in per machine)

`.claude/hooks/block-heavy-node.sh` is a `PreToolUse` Bash hook registered in
`.claude/settings.json`. It *loads* everywhere but only **enforces** on a marked
machine:

- **Enable offloading**: `touch ~/.hacklab-sandbox`
  (or export `HACKLAB_SANDBOX=1`).
- **Unmarked machines** (laptops, CI): the hook is a no-op — every command passes.
- **Un-mark:** `rm ~/.hacklab-sandbox`.

The marker is machine-local (never committed). The hook is **fail-open**: if it
can't parse a command it allows it, so it never wedges Bash.

**Escape hatch (on a marked machine):** prefix a genuine one-off with `HACKLAB_ALLOW_HEAVY=1`:

```sh
HACKLAB_ALLOW_HEAVY=1 pnpm test
```

### Tuning

To allow local build/test and keep only the Vitest single-thread cap, trim
`build|check|test`, `tsc`, or `vitest` out of the `HEAVY` pattern in
`.claude/hooks/block-heavy-node.sh`.
