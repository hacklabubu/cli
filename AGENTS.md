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

## Engineering approach

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
