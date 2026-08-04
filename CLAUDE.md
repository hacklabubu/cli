# claude

Use `AGENTS.md` for project context and `docs/offload.md` for the full compute policy.

## Compute — offload heavy Node (on the shared sandbox box only)

Agents run in several places. On the **shared sandbox box** — a machine marked
with `~/.hacklab-sandbox` or `HACKLAB_SANDBOX=1` — build/test runs pile up across
many agents and bog the box, so a `PreToolUse` hook blocks them there: **don't
`pnpm build` / `pnpm test` / `pnpm check` or run `tsc` / `vitest` locally.** Verify
remotely instead: `./scripts/verify-remote.sh` (push → GitHub Actions builds +
tests). Running the CLI itself (`pnpm dev <cmd>`, `node dist/index.js <cmd>`) is
fine, as is `pnpm install`. Escape hatch for a genuine one-off: prefix with
`HACKLAB_ALLOW_HEAVY=1`. On unmarked machines (laptops, CI) nothing is blocked —
build and test freely. Full policy in `docs/offload.md`.

## Conventions

- **Package manager:** pnpm (`pnpm@10.11.1`). Single-package repo — no workspace.
- **Language / build:** TypeScript → `tsc` (`pnpm build` = `rm -rf dist && tsc && chmod +x`).
- **Lint / format:** Biome — 2-space indent, single quotes, no semicolons (`pnpm exec biome check .`).
- **Tests:** Vitest (`pnpm test`). On the sandbox box vitest is auto-capped to one
  thread (see `vitest.config.ts`); laptops and CI run fully parallel.
- **Run it locally:** `pnpm dev <command>` (tsx) or `node dist/index.js <command>`.
- **Error handling:** never swallow an error in a way that hides a real failure.

## Shipping

- Branch off `main`, commit, open a PR to **`main`** (the default branch). CI
  (`.github/workflows/ci.yml`) runs Biome + the `tsc` build (typecheck) + the
  Vitest suite, including a **native-Windows** test job.
- **Publish** is automatic (`.github/workflows/publish-cli.yml`) via **npm Trusted
  Publishing (OIDC)** — no token/secret:
  - push to `main` → publishes `package.json`'s version to the **`latest`** npm
    dist-tag (idempotent; no-ops if that version is already published).
  - any non-`main` push / manual dispatch → a throwaway `-staging.<run>`
    prerelease to the **`staging`** tag, so `latest` is never touched.
  - So: **bump `package.json` `version`** when shipping a user-facing change.
    CI's **Version bump** job fails any PR touching `src/` that doesn't, because
    the alternative is a silent no-op: everything green, merged, and never
    published. Name the version in the PR title (`v0.10.5 — feat(...): ...`).
  - `/ship-lite` does all of this for you — prefer it over hand-rolling a PR.
