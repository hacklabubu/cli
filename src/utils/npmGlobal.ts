import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Shared plumbing for the two places that shell out to `npm i -g hacklab`: the
// `hacklab update` command and (conceptually) the curl|sh installer. The point
// of the H1 approach is to never let npm's raw EACCES stack trace reach the
// user: probe whether npm's global folder is writable up front, and if it isn't,
// reconfigure npm to a user-owned prefix (npm's own documented remedy) instead
// of escalating to sudo. That fix is persistent, so every future `npm i -g`
// works too — which is the whole reason the update nag can safely point here.

/**
 * npm's executable name. On Windows npm is a `.cmd` shim, and recent Node
 * refuses to spawn `.cmd`/`.bat` without a shell, so callers pass `shell: true`
 * on win32 (see {@link runNpm}).
 */
export const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Run npm with fixed (never user-supplied) args. `capture` pipes stdout/stderr
 * back as strings; otherwise the child inherits the terminal so npm's own
 * progress shows through. `shell: true` on Windows is required to launch the
 * `.cmd` shim; the args here are all literals, so there's nothing to escape.
 */
export function runNpm(
  args: string[],
  opts: { capture?: boolean } = {}
): SpawnSyncReturns<string> {
  return spawnSync(NPM_BIN, args, {
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

/** The directory npm would drop a global package into (`npm root -g`), or ''. */
export function npmGlobalRoot(): string {
  const res = runNpm(['root', '-g'], { capture: true })
  return res.status === 0 && res.stdout ? res.stdout.trim() : ''
}

/**
 * Walk up from `p` to the nearest ancestor that exists on disk. We can't test
 * writability of a directory npm hasn't created yet (`…/lib/node_modules`
 * frequently doesn't exist), so we check the closest thing that does — mkdir
 * succeeds iff that ancestor is writable.
 */
export function firstExistingAncestor(p: string): string {
  let d = p
  while (d && !existsSync(d)) {
    const parent = dirname(d)
    if (parent === d) break // hit the filesystem root
    d = parent
  }
  return d
}

/** Can the current user create/write inside `dir` (probing its nearest existing ancestor)? */
export function isWritable(dir: string): boolean {
  const target = firstExistingAncestor(dir)
  if (!target) return false
  try {
    accessSync(target, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The user-owned prefix we reconfigure npm to when the system one is read-only. */
export function userNpmPrefix(): string {
  return join(homedir(), '.npm-global')
}
