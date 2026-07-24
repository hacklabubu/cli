#!/usr/bin/env bash
# SessionStart hook: make a fresh worktree ready to build without manual steps.
#
# `claude --worktree <name>` (and `git worktree add`) give you a working copy
# with no node_modules, so an agent stumbles through a few commands before
# realizing it must install deps. This installs them once, idempotently. It is a
# fast no-op when node_modules is already present, so it costs nothing on the
# main checkout or on resume.
#
# Frozen install only: we never fall back to a non-frozen install (that would
# silently rewrite pnpm-lock.yaml and leave the worktree dirty). On failure we
# report and let the agent decide. Never blocks the session — always exit 0.

set -u

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$ROOT" 2>/dev/null || exit 0

# Only act at the root of this pnpm package (single-package CLI repo — no
# pnpm-workspace.yaml, unlike the monorepo).
[ -f "$ROOT/package.json" ] || exit 0
[ -f "$ROOT/pnpm-lock.yaml" ] || exit 0

# pnpm writes node_modules/.modules.yaml after a successful install — use it as
# the "already installed" marker (more reliable than a bare directory check).
[ -f "$ROOT/node_modules/.modules.yaml" ] && exit 0

emit() {
  # $1 = additionalContext string. Static, JSON-safe messages (no double-quotes /
  # backslashes / control chars), inlined so the hook needs no JSON encoder.
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$1"
}

# Make pnpm reachable even in a minimal hook environment (fnm-managed installs).
if ! command -v pnpm >/dev/null 2>&1; then
  for d in "/usr/local/fnm/aliases/default/bin" "$HOME/.local/state/fnm_multishells"/*/bin; do
    if [ -x "$d/pnpm" ]; then
      PATH="$d:$PATH"
      break
    fi
  done
fi

if ! command -v pnpm >/dev/null 2>&1; then
  emit "This worktree has no node_modules and pnpm was not found on PATH. Run 'pnpm install' before building or testing."
  exit 0
fi

LOG="$ROOT/.claude/worktree-setup.log"
echo "[$(date -u +%FT%TZ)] node_modules missing — pnpm install --frozen-lockfile in $ROOT" >>"$LOG" 2>&1

if pnpm install --frozen-lockfile >>"$LOG" 2>&1; then
  emit "Fresh worktree detected — ran 'pnpm install --frozen-lockfile'. Dependencies are installed; you can build and test immediately."
else
  emit "Fresh worktree: 'pnpm install --frozen-lockfile' FAILED (see .claude/worktree-setup.log). The lockfile may be out of sync with package.json — investigate before building."
fi
exit 0
