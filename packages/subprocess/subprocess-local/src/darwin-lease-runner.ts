/** Managed Darwin process-group owner; the private IPC connection is the parent lifetime lease. */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseWindowsStartRequest, serializeRunnerError } from './runner-protocol.ts'

/**
 * Run a command in this runner's detached group until every member has exited.
 * IPC is never inherited by the command; parent disconnect kills this still-owned group.
 * @param argv - validated target argv.
 */
export async function runDarwinLease(argv: readonly string[]): Promise<void> {
  const send = process.send?.bind(process)
  if (process.platform !== 'darwin' || !process.connected || send === undefined) {
    throw new Error('managed Darwin subprocess requires a connected parent lease')
  }
  const killOwnedGroup = (): never => {
    // This live group leader pins its own PGID, so this cannot signal a reused group.
    process.kill(-process.pid, 'SIGKILL')
    throw new Error('managed Darwin process group termination returned')
  }
  process.once('disconnect', killOwnedGroup)
  process.on('message', (value: unknown) => {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'terminate') return
    if (!('signal' in value)) return killOwnedGroup()
    const signal = value.signal
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return killOwnedGroup()
    process.kill(-process.pid, signal)
  })
  // Parent TERM reaches the whole group; keep the lease owner alive for remaining descendants.
  const retainOwner = (): void => {}
  process.on('SIGTERM', retainOwner)
  const request = await new Promise<ReturnType<typeof parseWindowsStartRequest>>((resolve, reject) => {
    process.once('message', (value: unknown) => {
      try { resolve(parseWindowsStartRequest(value)) } catch (error) { reject(error) }
    })
  })
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: request.cwd, env: request.env, detached: false,
    stdio: [4, 5, 6, ...request.control === 'pipe' ? ['ignore', 'ignore', 'ignore', 'ignore', 7] as const : []],
  })
  for (const fd of request.control === 'pipe' ? [4, 5, 6, 7] : [4, 5, 6]) closeSync(fd)
  const result = await new Promise<object>((resolve) => {
    child.once('error', (error) => { resolve({ type: 'error', error: serializeRunnerError(error) }) })
    child.once('exit', (exitCode, signal) => { resolve({ type: 'target-exit', exitCode, signal }) })
  })
  await new Promise<void>((resolve, reject) => {
    send(result, (error) => { if (error === null) resolve(); else reject(error) })
  })
  // The direct command can exit while a background descendant retains the group.
  // Keep the lease live until the group contains only this owner (zombies cannot run).
  for (;;) {
    const observed = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
    if (observed.status !== 0) killOwnedGroup()
    const members = observed.stdout.trim().split('\n').filter((line) => {
      const [pid, pgid, state] = line.trim().split(/\s+/)
      if (pid === undefined || pgid === undefined || state === undefined) return killOwnedGroup()
      return Number(pgid) === process.pid && Number(pid) !== process.pid && Number(pid) !== observed.pid && !state.startsWith('Z')
    })
    if (members.length === 0) break
    await sleep(25)
  }
  process.off('SIGTERM', retainOwner)
  process.off('disconnect', killOwnedGroup)
  process.disconnect()
}
