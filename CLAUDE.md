# claude

Use `AGENTS.md` for project context and `docs/offload.md` for the full compute policy.

## Compute — optional build/test offloading

Machines marked with `~/.hacklab-sandbox` or `HACKLAB_SANDBOX=1` opt into
build/test offloading. On those machines, a `PreToolUse` hook blocks
`pnpm build` / `pnpm test` / `pnpm check` and `tsc` / `vitest`. Verify with
`./scripts/verify-remote.sh` (push → GitHub Actions builds + tests).
Running the CLI (`pnpm dev <cmd>`, `node dist/index.js <cmd>`) and `pnpm install`
remain allowed. For a genuine one-off, prefix with `HACKLAB_ALLOW_HEAVY=1`.
Unmarked machines build and test freely. Full policy in `docs/offload.md`.

## Conventions

- **Package manager:** pnpm (`pnpm@10.11.1`). Single-package repo — no workspace.
- **Language / build:** TypeScript → `tsc` (`pnpm build` = `rm -rf dist && tsc && chmod +x`).
- **Lint / format:** Biome — 2-space indent, single quotes, no semicolons (`pnpm exec biome check .`).
- **Tests:** Vitest (`pnpm test`); configuration in `vitest.config.ts`.
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
