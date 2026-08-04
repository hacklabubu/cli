---
name: ship-lite
description: This skill should be used when the user wants to quickly get a branch onto a PR — e.g. "make a PR for this", "open/create a PR", "PR this branch", "do a quick ship", "ship-lite", "quick ship", "lean ship", or "push this branch". It's a lightweight ship for the hacklab CLI repo: it commits the work, bumps the version when src/ changed, pushes, and creates or updates a GitHub PR to main.
---

# Ship Lite

Commit, push, and open (or update) a GitHub PR to `main` for this repo (the `hacklab` CLI). It deliberately **skips** the heavier gates — no local test run, no diff review, no merge. CI (lint + build + tests, Linux + native Windows) runs on the PR, so let it go green and give the diff a look before merging.

**Shipping a code change means bumping the version.** Publishing is automatic: when a commit lands on `main` with a `package.json` version that isn't on npm yet, `.github/workflows/publish-cli.yml` publishes it (OIDC Trusted Publishing, no token). npm rejects a same-version publish, so a real bump is required to ship CLI code. See Step 2.

CI enforces this: the **Version bump** job fails any PR that touches `src/`
without moving the version. If you see it red, you skipped Step 2 — the merge
would have published nothing and the change would never have reached
`npm install hacklab`, with every other check still green.

## Input

- Optional PR title/summary. Otherwise derive from the branch and commits.

## Workflow

### Step 1: Commit the work

Stage the relevant files and commit with a conventional-commit subject. Keep commits **subject-only** to match this repo's history — no body, no trailers:

```bash
git add -A                       # or stage precisely
git commit -m "<type>(<scope>): <short summary>"
```

If everything is already committed, skip this. Read `git diff main...HEAD --stat` so the commit and PR describe what actually changed.

### Step 2: Bump the version — only if `src/` changed

The `"version"` in `package.json` is what publishes to npm. If this branch changed anything under `src/`, bump it so the change can ship:

```bash
git diff main...HEAD --name-only -- src/
```

If that prints nothing (docs / CI / config only), **skip this step** — no publish is needed. If it prints any file(s):

1. Read the current version: `grep '"version"' package.json`
2. Increment the **patch** (third) segment by default: `0.10.0 → 0.10.1`. Use a minor/major bump only if the user asks.
3. Edit the single `"version"` line in `package.json` (don't add a duplicate key).
4. Commit it — fold into the Step 1 commit if you haven't committed yet, or add a `chore: bump to X.Y.Z` commit.

State the chosen version; it's the version that will publish to npm when the PR merges.

### Step 3: Push

```bash
git push -u origin HEAD
```

A re-run on a branch that already has a PR updates that PR — no extra step.

### Step 4: Create the PR — or update the existing one

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
gh pr list --head "$BRANCH" --state open --json number,url,title
```

- **If a PR already exists**, Step 3 already updated its commits. Don't open a duplicate; refresh the title/body only if the scope shifted.
- **If none exists**, create one against `main`:

  ```bash
  gh pr create --base main --head "$BRANCH" \
    --title "vX.Y.Z — <type>(<scope>): <short summary>" \
    --body "$(cat <<'EOF'
## What
<what changed, user-facing>

## Notes
<anything reviewers should know; if the version bumped, note it publishes on merge>
EOF
)"
  ```

**Title convention: lead with the version this PR publishes**, then a plain
conventional-commit subject — `v0.10.5 — feat(sync): upload prompt stats`. The
version is the release this merge puts on npm, so it belongs where reviewers
read it first. Drop the `vX.Y.Z —` prefix only when Step 2 skipped the bump
(docs/CI-only PRs, which publish nothing). Repeat it in the body as
`publishes vX.Y.Z on merge`.

If the user asks for a draft PR, add `--draft`.

### Step 5: Report

Print the changed files, the commit(s), whether the version was bumped (and to what), and the PR URL. Note that tests/review ran only in CI, so let CI pass before merging.

## Reference

- **Base branch is `main`.** PRs merge into `main`; there is no staging branch.
- **The version lives in `package.json` (repo root)** and drives the npm publish via `.github/workflows/publish-cli.yml` on merge to `main`. npm rejects a same-version publish, so bump the version to ship `src/` changes; docs/CI-only PRs need no bump.
- Local dev: `pnpm install`, `pnpm dev <cmd>`, `pnpm build`, `pnpm test`.
