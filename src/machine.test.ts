import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMachineIdentity, getMachinePath } from './machine.js'

let dir: string
const prevEnv = process.env.HACKLAB_MACHINE_PATH

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hacklab-machine-'))
  process.env.HACKLAB_MACHINE_PATH = join(dir, 'machine.json')
})

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.HACKLAB_MACHINE_PATH
  else process.env.HACKLAB_MACHINE_PATH = prevEnv
  await rm(dir, { recursive: true, force: true })
})

describe('getMachineIdentity', () => {
  it('honors the HACKLAB_MACHINE_PATH override', () => {
    expect(getMachinePath()).toBe(join(dir, 'machine.json'))
  })

  it('generates a UUID and persists it on first use', async () => {
    const { machineId } = await getMachineIdentity()
    expect(machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    const onDisk = JSON.parse(await readFile(getMachinePath(), 'utf8'))
    expect(onDisk.machineId).toBe(machineId)
  })

  it('is stable across calls — a machine keeps one id', async () => {
    const first = await getMachineIdentity()
    const second = await getMachineIdentity()
    expect(second.machineId).toBe(first.machineId)
  })

  it('reads an existing id rather than regenerating', async () => {
    await writeFile(
      getMachinePath(),
      JSON.stringify({ machineId: 'fixed-id', createdAt: 'x' })
    )
    const { machineId } = await getMachineIdentity()
    expect(machineId).toBe('fixed-id')
  })

  it('regenerates when the stored file is corrupt', async () => {
    await writeFile(getMachinePath(), 'not json')
    const { machineId } = await getMachineIdentity()
    expect(machineId.length).toBeGreaterThan(0)
    expect(machineId).not.toBe('not json')
  })

  it('reports a non-empty machineName', async () => {
    const { machineName } = await getMachineIdentity()
    expect(typeof machineName).toBe('string')
    expect(machineName.length).toBeGreaterThan(0)
  })

  it('concurrent first-use calls converge on a single id', async () => {
    const results = await Promise.all([
      getMachineIdentity(),
      getMachineIdentity(),
      getMachineIdentity(),
    ])
    const ids = new Set(results.map((r) => r.machineId))
    expect(ids.size).toBe(1)
  })
})
