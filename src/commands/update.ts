import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { captureEvent } from '../posthog.js'
import { loadSession } from '../session.js'
import { dim, error, info, success } from '../ui.js'
import {
  isWritable,
  npmGlobalRoot,
  runNpm,
  userNpmPrefix,
} from '../utils/npmGlobal.js'
import { fetchLatest, isNewerVersion } from '../utils/updateCheck.js'

// The version we're running now — read from package.json (two levels up from
// this module, in both `dist/` and `src/`) the same way index.ts does, so it
// can't drift from a hardcoded string.
const require = createRequire(import.meta.url)
const { version: CURRENT } = require('../../package.json') as {
  version: string
}

// `hacklab update` — a permission-safe wrapper around `npm i -g hacklab@latest`.
// A plain `npm i -g` is enough on most machines, but on systems where npm's
// global folder is root-owned (a stock /usr/local) it dies with EACCES. Rather
// than surface that stack trace or reach for sudo, we probe writability first
// and, if needed, reconfigure npm to a user-owned prefix (option H1) before
// installing. Works on Linux, macOS, and Windows; the prefix reconfigure is a
// POSIX concern only (Windows installs globals into a user-writable %APPDATA%).

export async function update(): Promise<void> {
  // For analytics only — never block the update on a session read.
  const session = await loadSession().catch(() => null)

  // Short-circuit when there's nothing to do: if the registry says we're already
  // on the latest, skip the install entirely. Crucially this runs BEFORE any
  // writability probe / prefix reconfigure — we never want to touch ~/.npmrc when
  // there's nothing to install. A failed/timed-out lookup returns undefined and
  // falls through to the install (the safe default: attempt it rather than
  // wrongly claim we're current).
  const latest = await fetchLatest()
  if (latest && !isNewerVersion(latest, CURRENT)) {
    success(`already on the latest hacklab (${CURRENT}).`)
    return
  }

  const reconfiguredPrefix = ensureWritableGlobalPrefix()

  info('updating hacklab (npm i -g hacklab@latest)…')
  const res = runNpm(['install', '-g', 'hacklab@latest'])
  if (res.status !== 0) {
    error('update failed.')
    if (res.error?.message.includes('ENOENT')) {
      info('npm not found — it ships with Node. Install Node 20+ and retry.')
    } else {
      info('Try again, or install manually: npm install -g hacklab@latest')
    }
    await captureEvent(session?.handle, 'cli_update_failed')
    process.exit(1)
  }

  success('hacklab is up to date.')
  if (reconfiguredPrefix) {
    const binDir = join(reconfiguredPrefix, 'bin')
    info(`npm now installs global packages under ${reconfiguredPrefix}.`)
    info('Add its bin dir to your PATH — put this in your shell profile:')
    console.log(dim(`      export PATH="${binDir}:$PATH"`))
    info(
      dim(
        'Prefer the system location? Undo with `npm config delete prefix`, then reinstall with sudo.'
      )
    )
  }
  await captureEvent(session?.handle, 'cli_update', {
    from: CURRENT,
    to: latest ?? null,
  })
}

/**
 * If npm's global folder isn't writable by this user, reconfigure npm to a
 * user-owned prefix and return that prefix; otherwise return null (nothing to
 * do). The reconfigure is skipped on Windows, where global installs already land
 * in a user-writable location. Exits the process with a clear, actionable
 * message if the reconfigure itself fails.
 */
function ensureWritableGlobalPrefix(): string | null {
  if (process.platform === 'win32') return null

  const root = npmGlobalRoot()
  if (!root || isWritable(root)) return null

  const prefix = userNpmPrefix()
  info(`npm's global folder isn't writable (${root}).`)
  info(`Reconfiguring npm to install under ${prefix} — no sudo needed…`)

  const cfg = runNpm(['config', 'set', 'prefix', prefix], { capture: true })
  if (cfg.status !== 0) {
    error("couldn't reconfigure npm automatically.")
    info('Install into the system location with sudo instead:')
    console.log(dim('      sudo npm install -g hacklab@latest'))
    info('or set a user prefix yourself:')
    console.log(
      dim(
        `      npm config set prefix "${prefix}" && npm install -g hacklab@latest`
      )
    )
    process.exit(1)
  }

  // Make the new bin dir usable by anything this process spawns for the rest of
  // the run. The persistent profile edit (printed after install) is only needed
  // for future shells.
  process.env.PATH = `${join(prefix, 'bin')}${delimiter}${process.env.PATH ?? ''}`
  return prefix
}
