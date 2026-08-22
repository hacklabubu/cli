import { createInterface } from 'node:readline'

/**
 * Print `prompt` and block until Enter. Resolves true if we waited, false if
 * stdin is not a TTY (CI, piped input) so the caller should continue anyway.
 */
export async function waitForEnter(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false

  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => {
      rl.close()
      resolve(true)
    })
    rl.once('close', () => resolve(false))
  })
}
