#!/usr/bin/env bash
# Verify a change WITHOUT building or testing locally: push the branch and let
# GitHub Actions build + test it. See docs/offload.md.
#
# The CLI isn't deployed to a preview environment, so CI *is* the verification —
# ci.yml runs biome, the tsc build (typecheck), and the vitest suite (incl. the
# Windows runner). Green means it's good.
#
# Usage: ./scripts/verify-remote.sh
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD)
case "$BRANCH" in
  main | HEAD)
    echo "refusing to verify-remote on '$BRANCH' — switch to a feature branch first." >&2
    exit 1
    ;;
esac

echo "→ pushing $BRANCH …"
git push -u origin "$BRANCH"

if ! gh pr view "$BRANCH" >/dev/null 2>&1; then
  echo "→ creating draft PR to main …"
  gh pr create --draft --base main --head "$BRANCH" --fill
fi

PR_URL=$(gh pr view "$BRANCH" --json url --jq .url)
echo "→ PR: $PR_URL"

echo "→ watching CI (network-only, cheap on this box; Ctrl-C stops watching — CI keeps running) …"
gh pr checks "$BRANCH" --watch --interval 15 || true

echo "→ done. Green = biome + build (typecheck) + tests passed in CI."
