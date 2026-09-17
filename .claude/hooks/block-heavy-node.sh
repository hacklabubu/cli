#!/usr/bin/env bash
# PreToolUse(Bash) hook: opt-in build/test offloading to GitHub Actions.
# See docs/offload.md. Running the CLI (`pnpm dev`) and `pnpm install` stay allowed.
#
# OPT-IN per machine, defaults to ALLOW: enforces only when HACKLAB_SANDBOX=1 is
# set or ~/.hacklab-sandbox exists. Every unmarked machine passes commands through.
#
# Escape hatch (on a marked machine): prefix the command with HACKLAB_ALLOW_HEAVY=1.
# Fail-open: if we can't parse the tool input, we allow the command.

set -u

# Machine gate: unmarked machines build/test freely.
if [ -z "${HACKLAB_SANDBOX:-}" ] && [ ! -f "${HOME:-}/.hacklab-sandbox" ]; then
  echo '{}'
  exit 0
fi

INPUT=$(cat)

# Extract the command string. Prefer python3; fall back to a permissive grep.
CMD=$(
  printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")' 2>/dev/null
)
if [ -z "$CMD" ]; then
  CMD=$(printf '%s' "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1)
fi
[ -z "$CMD" ] && { echo '{}'; exit 0; }

# Escape hatch: an explicit opt-in anywhere in the command runs it as-is.
case "$CMD" in
  *HACKLAB_ALLOW_HEAVY=1*) echo '{}'; exit 0 ;;
esac

# Heavy set for this CLI. `pnpm <script>` matches only when the script name comes
# directly after pnpm (optionally `pnpm run`). `pnpm dev` (runs the CLI) and
# `pnpm install` are deliberately NOT here. Bare `tsc` / `vitest` are the build /
# test runners under any wrapper.
HEAVY='(^|[[:space:];&|(])(pnpm([[:space:]]+run)?[[:space:]]+(build|check|test|prepack)|tsc|vitest)([[:space:]]|;|&|\||$)'

if printf '%s' "$CMD" | grep -Eq "$HEAVY"; then
  MSG='BLOCKED — build/test offloading is enabled on this machine. Verify remotely instead: run ./scripts/verify-remote.sh (push branch → CI builds + tests it). Running the CLI itself (pnpm dev) is fine. If you truly must build/test locally, prefix with HACKLAB_ALLOW_HEAVY=1 . Details: docs/offload.md'
  printf '{"permissionDecision":"deny","message":"%s"}\n' "$MSG"
  exit 0
fi

echo '{}'
exit 0
