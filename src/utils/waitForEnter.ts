import { createInterface } from 'node:readline'

/**
 * Print `prompt` and block until the user presses Enter. Resolves true if we
 * actually waited for the keypress, false if we didn't (and the caller should
 * just carry on).
 *
 * Never hangs an unattended run: a non-TTY stdin (CI, piped input, a `< /dev/null`
 * invocation) returns immediately, as does an EOF/close on the stream. Callers
 * treat this as a courtesy pause, not a gate — whatever comes next must still
 * happen when the answer is false.
 */
export async function waitForEnter(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false

  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => {
      rl.close()
      resolve(true)
    })
    // EOF (or the stream closing under us) fires 'close' without ever answering
    // the question. The first resolve wins, so the normal path above is
    // unaffected — this only rescues the flow from waiting forever.
    rl.once('close', () => resolve(false))
  })
}
