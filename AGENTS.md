# Agents

## Project

The **hacklab CLI** — the `hacklab` command, published to npm as `hacklab`.
Hackers use it from the terminal: sign in, sync their AI-tool token usage, earn
belts, post drops, and join the community channel. This repo is the CLI only; the
web app and the rest of hacklab live in the `hacklabubu/hacklab` monorepo.

## Structure

- `src/` — CLI source. Entry point `src/index.ts`; commands under `src/commands/`,
  usage scanners under `src/scanners/`, plus session/config/UI helpers.
- `.posthog-events.json` — analytics event registry (events the CLI emits).
- `.github/workflows/` — `ci.yml` (Biome + build + Vitest, incl. Windows) and
  `publish-cli.yml` (npm publish via OIDC Trusted Publishing).
- `vitest.config.ts` — Vitest config; auto-caps to one thread on the sandbox box.

## Key files

- `CLAUDE.md` — conventions, the compute/offload rule, and shipping.
- `docs/offload.md` — full "don't build/test on the shared box" policy + how the
  per-machine sandbox marker works.

## Conventions

- **pnpm** · **TypeScript** (`tsc`) · **Biome** (2-space, single quotes, no
  semicolons) · **Vitest**.
- Branches: feature → PR to `main`. A push to `main` publishes to npm.
- Telemetry is opt-out (`HACKLAB_NO_TELEMETRY` / `DO_NOT_TRACK`); never collect
  token payloads or scanned content — anonymous usage only.
