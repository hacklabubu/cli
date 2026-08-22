import { createInterface } from 'node:readline'

/**
 * Print `prompt` and block until Enter. Resolves true if we waited, false if
 * stdin is not a TTY, the wait was aborted, or the stream closed.
 */
export async function waitForEnter(
  prompt: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  if (signal?.aborted) return false

  return await new Promise<boolean>((resolve) => {
    let settled = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rl.close()
      resolve(value)
    }
    const onAbort = () => finish(false)
    rl.question(prompt, () => finish(true))
    rl.once('close', () => finish(false))
    signal?.addEventListener('abort', onAbort)
  })
}
