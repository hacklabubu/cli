import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The handoff: at the end of `hacklab setup` we look for a coding-agent CLI on
 * the machine and, with one keypress of consent, hand it the profile-setup
 * prompt. The agent runs interactively in the same terminal — the user watches
 * it, answers its permission prompts, and (if the agent CLI is installed but
 * logged out) walks its own login flow. Nothing here is silent or headless.
 *
 * When no agent can be used we tell the backend, so the web onboarding can fall
 * back to showing the manual paste-the-prompt step instead of waiting for a
 * ping that is never coming.
 */

export type AgentCli = {
  /** Executable name, as it appears on PATH. */
  bin: string
  /** What we call it in the terminal. */
  name: string
  /** argv for "open interactively, seeded with this prompt". */
  args: (prompt: string) => string[]
}

/**
 * Probed in order — first one on PATH wins. All three take the prompt as a
 * single positional argument today; the shape stays per-entry so one of them
 * can diverge without touching the others.
 */
export const AGENT_CLIS: AgentCli[] = [
  { bin: 'claude', name: 'Claude Code', args: (prompt) => [prompt] },
  { bin: 'codex', name: 'Codex', args: (prompt) => [prompt] },
  { bin: 'grok', name: 'Grok', args: (prompt) => [prompt] },
]

/** Is `bin` an executable file in one of the PATH directories? */
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  // On Windows the thing on PATH is `claude.cmd` / `claude.exe`, never a
  // bare-named file, so every candidate needs the PATHEXT suffixes tried.
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, bin + ext), constants.X_OK)
        return true
      } catch {
        // Not here (missing, or not executable) — keep looking.
      }
    }
  }
  return false
}

/** The first agent CLI installed on this machine, or null if there is none. */
export function findAgentCli(): AgentCli | null {
  return AGENT_CLIS.find((agent) => onPath(agent.bin)) ?? null
}

/**
 * Hand the terminal to `agent`, seeded with `prompt`, and block until its
 * session exits. Returns false when the process never started (ENOENT, a broken
 * shim) — the caller then treats the agent as unavailable. A non-zero exit is
 * still a launch: the user was there and saw whatever happened.
 */
export function launchAgentCli(agent: AgentCli, prompt: string): boolean {
  // Windows agent CLIs are `.cmd` shims, which Node refuses to spawn without a
  // shell; cmd.exe joins argv verbatim, so the prompt needs its own quotes.
  const win = process.platform === 'win32'
  const args = agent.args(prompt).map((arg) => (win ? `"${arg}"` : arg))
  try {
    const res = spawnSync(agent.bin, args, { stdio: 'inherit', shell: win })
    return !res.error
  } catch {
    return false
  }
}

const HANDOFF_TIMEOUT_MS = 8000

/**
 * Tell the backend that no agent took the profile work, so the web onboarding
 * shows the manual prompt instead of waiting. Best effort by design: a failure
 * (offline, or a backend that doesn't have the route yet) must never break the
 * end of setup. There is deliberately no 'launched' outcome — the agent's own
 * `hacklab ping` is that signal.
 *
 * Server contract (POST /api/cli/agent-handoff):
 *   `Authorization: Bearer <session token>`, body `{ outcome }`.
 */
export async function notifyAgentHandoff(
  appUrl: string,
  token: string,
  outcome: 'unavailable' | 'declined'
): Promise<void> {
  try {
    await fetch(`${appUrl}/api/cli/agent-handoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome }),
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    })
  } catch {
    // Best effort — setup is already done, and this only steers the web page.
  }
}
