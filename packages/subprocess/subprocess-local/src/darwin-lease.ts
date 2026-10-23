/** Parent-side launch for a Paperclip-managed Darwin command with a non-inheritable lifetime lease. */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { constants, devNull } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ManagedProcessLaunch } from './managed-owner.ts'
import { controlPipe } from './control-spawn.ts'
import { deserializeRunnerError, parseWindowsRunnerResult } from './runner-protocol.ts'
import { runnerEnvironment, runnerStdio, spawnRunnerInvocation } from './runner-launch.ts'

type LeaseProcess = Omit<ChildProcess, 'stdio'> & { stdio: Array<Readable | Writable | null> }

/** Private runner selector; never forwarded to the target environment. */
export const DARWIN_LEASE_SELECTION = 'paperclip-darwin-lease'

/**
 * Launch a private group leader whose IPC channel closes if this harness dies.
 * @param spec - exact command and stream dispositions.
 * @param env - scrubbed complete target environment.
 * @returns streams, direct target result and group owner retained through descendant exit.
 */
export function launchDarwinLease(spec: SubprocessSpawnSpec, env: Record<string, string>): ManagedProcessLaunch {
  const invocation = spawnRunnerInvocation()
  const ignored = spec.stdio.stdin === 'ignore' ? openSync(devNull, 'r') : undefined
  let runner: LeaseProcess
  try {
    runner = spawn(invocation[0], [...invocation.slice(1), '--', ...spec.argv], {
      env: runnerEnvironment(DARWIN_LEASE_SELECTION, invocation),
      stdio: runnerStdio(spec, true, ignored ?? 'pipe'), detached: true,
    }) as LeaseProcess
  } finally {
    if (ignored !== undefined) closeSync(ignored)
  }
  if (runner.send === undefined) {
    if (runner.connected) runner.disconnect()
    throw new Error('managed Darwin runner has no IPC lease')
  }
  const send = runner.send.bind(runner)
  const direct = Promise.withResolvers<SubprocessOutcome>()
  const exited = Promise.withResolvers<void>()
  let resultSeen = false
  let alive = true
  let expectedKill = false
  const disconnect = (): void => {
    expectedKill = true
    if (runner.connected) runner.disconnect()
  }
  const signal = (value: 'SIGTERM' | 'SIGKILL'): void => {
    // The private channel addresses this exact owner; no parent-side PID/PGID signalling is needed.
    if (!alive || !runner.connected) return
    if (value === 'SIGKILL') expectedKill = true
    send({ type: 'terminate', signal: value }, (error) => { if (error !== null) disconnect() })
  }
  const fail = (error: unknown): void => {
    direct.reject(error)
    disconnect()
  }
  runner.on('message', (value: unknown) => {
    try {
      if (resultSeen) throw new Error('managed Darwin runner sent duplicate target result')
      resultSeen = true
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'target-exit') {
        if (!('exitCode' in value) || !('signal' in value)
          || !(value.exitCode === null || Number.isInteger(value.exitCode))
          || !(value.signal === null || typeof value.signal === 'string' && Object.hasOwn(constants.signals, value.signal))) {
          throw new Error('managed Darwin runner sent invalid target result')
        }
        direct.resolve({ exitCode: value.exitCode as number | null, signal: value.signal as NodeJS.Signals | null })
      } else {
        const result = parseWindowsRunnerResult(value)
        if (result.type !== 'error') throw new Error('managed Darwin runner sent invalid target error')
        direct.reject(deserializeRunnerError(result.error))
      }
    } catch (error) { fail(error) }
  })
  runner.once('spawn', () => {
    send({ type: 'start', cwd: spec.cwd, env, ...spec.stdio.control === undefined ? {} : { control: spec.stdio.control } }, (error) => {
      if (error !== null) fail(error)
    })
  })
  runner.once('error', (error) => {
    if (runner.pid === undefined) { alive = false; exited.resolve() }
    fail(error)
  })
  runner.once('exit', (code, signal) => {
    alive = false
    if (!resultSeen) direct.reject(new Error(`managed Darwin runner exited before target result (${String(code)}, ${String(signal)})`))
    if (code === 0 || signal === 'SIGKILL' && expectedKill) exited.resolve()
    else exited.reject(new Error('managed Darwin lease owner exited without proving group termination'))
  })
  return {
    stdin: spec.stdio.stdin === 'ignore' ? null : runner.stdio[4] as Writable | null,
    stdout: runner.stdio[5] as Readable | null,
    stderr: runner.stdio[6] as Readable | null,
    control: controlPipe(runner, spec.stdio.control),
    direct: direct.promise,
    owner: { signal, waitForExit: () => exited.promise, terminateForHostExit: disconnect },
  }
}
