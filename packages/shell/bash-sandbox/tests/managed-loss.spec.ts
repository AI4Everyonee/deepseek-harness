/** Abrupt native harness death closes the lease without leaving its Bash group alive. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createProcessInspector } from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import type { ProcessIdentity } from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/managed-loss-host.ts', import.meta.url))

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('managed Darwin parent loss', () => {
  it.each(['foreground', 'background', 'stop', 'normal'])('reaps the owned %s command group after native SIGKILL', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'managed-loss-'))
    const host = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fixture, root, mode], {
      cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.base.json'),
        PAPERCLIP_DEEPSEEK_MANAGED: '1', DSH_PERMISSION_MODE: 'workspace-write',
        PAPERCLIP_DEEPSEEK_READ_ROOTS: JSON.stringify([root]),
        PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS: JSON.stringify([join(root, 'private-state')]) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exit = new Promise((resolve) => { host.once('exit', (code, signal) => { resolve({ code, signal }) }) })
    let diagnostic = ''
    host.stderr?.on('data', (chunk) => { diagnostic += String(chunk) })
    const inspector = createProcessInspector()
    let owned: ProcessIdentity[] = []
    try {
      if (mode === 'normal') {
        await expect(exit).resolves.toMatchObject({ code: 0, signal: null })
        const result = JSON.parse(await readFile(join(root, 'settled.json'), 'utf8'))
        expect(result).toMatchObject({ exitCode: 7, signal: null, stdout: { text: 'lease-stdin' } })
        expect(JSON.parse(await readFile(join(root, 'ipc.json'), 'utf8')))
          .toEqual({ connected: false, send: 'undefined', channelEnv: null })
        return
      }
      const pids = await vi.waitFor(async () => {
        const text = await readFile(join(root, 'started.txt'), 'utf8')
        const pids = text.split(' ').map(Number)
        expect(pids).toHaveLength(2)
        expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0), diagnostic).toBe(true)
        return pids
      }, { timeout: 15000, interval: 20 })
      const group = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pids[1])], { encoding: 'utf8' }).stdout.trim())
      expect(group).toBeGreaterThan(0)
      const snapshot = inspector.snapshot()
      owned = [...new Set([host.pid!, group, ...pids])].flatMap(pid => snapshot.tree(pid).filter(identity => identity.pid === pid))
      // An exited background shell may already be gone, but its group owner and sleeper must remain owned.
      expect(owned.some(identity => identity.pid === group)).toBe(true)
      expect(owned.some(identity => identity.pid === pids[1])).toBe(true)
      if (mode === 'background') await vi.waitFor(() => access(join(root, 'settled.json')), { timeout: 15000, interval: 20 })
      if (mode === 'stop') {
        host.send!({ type: 'stop' })
        await expect(exit).resolves.toMatchObject({ code: 0, signal: null })
      } else {
        host.kill('SIGKILL')
        await expect(exit).resolves.toMatchObject({ signal: 'SIGKILL' })
      }
      await vi.waitFor(() => {
        const live = owned.filter(identity => inspector.isAlive(identity))
        expect(live, `owned survivors: ${JSON.stringify(live)}; ${diagnostic}`).toEqual([])
      }, { timeout: 5000, interval: 25 })
      await expect(access(join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const identity of owned) inspector.signalProcess(identity, 'SIGKILL')
      host.kill('SIGKILL')
      await exit
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
