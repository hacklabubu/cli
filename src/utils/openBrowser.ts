import { spawn } from 'node:child_process'

/**
 * Best-effort: open `url` in the user's default browser. Resolves true if the
 * opener launched, false otherwise (e.g. a headless host with no `xdg-open`).
 *
 * Critically, this must never crash the process. A missing opener binary is
 * reported by `spawn` as an asynchronous `'error'` event — NOT a thrown
 * exception — so a try/catch alone doesn't catch it, and with no listener Node
 * escalates it to a fatal unhandled error. On a headless box that would kill the
 * whole login flow right after we've printed the URL to visit manually.
 * We listen for `'error'` (failure) and `'spawn'` (success) so exactly one
 * settles the promise and the ENOENT is swallowed.
 */
export async function openBrowser(url: string): Promise<boolean> {
  let command: string
  let args: string[]

  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  return await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch {
      // Synchronous failure (bad arguments) — also non-fatal.
      resolve(false)
      return
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      // Let the opener outlive this process instead of pinning the event loop.
      child.unref()
      resolve(true)
    })
  })
}
