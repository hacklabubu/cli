import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Stable per-machine identity for token sync.
 *
 * The backend sums token usage across a user's machines and needs each machine
 * to be distinguishable so a re-run from one machine is idempotent (it replaces
 * that machine's contribution) while a second machine adds on top. We identify a
 * machine with a random id generated once and persisted here.
 *
 * The id is deliberately env-independent — a machine is one machine whether you
 * `hacklab sync --env prod` or `--env dev`; each backend tracks that same id in
 * its own database. So this lives next to the session, not per-backend.
 */

const MACHINE_PATH = join(homedir(), '.hacklab', 'machine.json')

export function getMachinePath(): string {
  return process.env.HACKLAB_MACHINE_PATH ?? MACHINE_PATH
}

export type MachineIdentity = {
  machineId: string
  /** Best-effort hostname for a friendlier "synced from N machines" UI later. */
  machineName: string
}

type MachineFile = {
  machineId: string
  createdAt: string
}

function isValid(data: unknown): data is MachineFile {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { machineId?: unknown }).machineId === 'string' &&
    (data as { machineId: string }).machineId.length > 0
  )
}

async function readMachineId(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isValid(parsed) ? parsed.machineId : null
  } catch {
    return null
  }
}

/**
 * Load this machine's id, generating and persisting one on first use. Uses an
 * exclusive create so two concurrent syncs (e.g. the daily daemon racing an
 * interactive run) can't each mint a different id — the loser reads back the
 * winner's file. Falls back to an ephemeral id only if the file can't be
 * written at all, so sync never hard-fails on a read-only home directory.
 */
export async function getMachineIdentity(): Promise<MachineIdentity> {
  const path = getMachinePath()

  const existing = await readMachineId(path)
  if (existing) return { machineId: existing, machineName: hostname() }

  const machineId = randomUUID()
  const body = `${JSON.stringify({ machineId, createdAt: new Date().toISOString() } satisfies MachineFile, null, 2)}\n`
  try {
    await mkdir(dirname(path), { recursive: true })
    // 'wx' fails if another process created it first; re-read to adopt theirs.
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
    return { machineId, machineName: hostname() }
  } catch {
    const raced = await readMachineId(path)
    return {
      machineId: raced ?? machineId,
      machineName: hostname(),
    }
  }
}
