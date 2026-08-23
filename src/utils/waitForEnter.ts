import { createInterface } from 'node:readline'

/**
 * Print `prompt` and block for one line. Resolves the line as typed, or null if
 * stdin is not a TTY, the wait was aborted, or the stream closed.
 *
 * Exported for callers that redraw over the prompt afterwards: what the user
 * typed was echoed onto that row, so its width is part of how much of the
 * terminal the prompt actually took.
 */
export async function readEnterLine(
  prompt: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  if (signal?.aborted) return null

  return await new Promise<string | null>((resolve) => {
    let settled = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rl.close()
      resolve(value)
    }
    const onAbort = () => finish(null)
    rl.question(prompt, (answer) => finish(answer))
    rl.once('close', () => finish(null))
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Print `prompt` and block until Enter. Resolves true if we waited, false if
 * stdin is not a TTY, the wait was aborted, or the stream closed.
 */
export async function waitForEnter(
  prompt: string,
  signal?: AbortSignal
): Promise<boolean> {
  return (await readEnterLine(prompt, signal)) !== null
}

/**
 * Like `waitForEnter`, but only a bare Enter counts as yes — anything typed
 * before it is a no. For prompts where Enter opts *in* to something with side
 * effects, so "n" + Enter can't confirm it.
 */
export async function waitForBareEnter(
  prompt: string,
  signal?: AbortSignal
): Promise<boolean> {
  return (await readEnterLine(prompt, signal)) === ''
}
