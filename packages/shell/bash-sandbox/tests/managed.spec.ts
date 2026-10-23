/** Synthetic-secret proof through the real Darwin sandbox, executor and subprocess provider. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

let base: string
let workspace: string
let outside: string
let protectedRoot: string
let ctx: Context
let bash: SandboxBashExecutor
const hostSupported = process.platform === 'darwin' && process.arch === 'arm64'

describe.skipIf(!hostSupported)('managed Darwin tool processes', () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'managed-bash-'))
    workspace = join(base, 'workspace')
    protectedRoot = join(workspace, 'runtime')
    outside = join(base, 'outside')
    await mkdir(protectedRoot, { recursive: true })
    await mkdir(outside)
    await writeFile(join(protectedRoot, '.credentials.yaml'), 'synthetic-secret')
    await writeFile(join(workspace, 'auth.json'), 'synthetic-auth-secret')
    await writeFile(join(outside, 'outside.txt'), 'outside-secret')
    await symlink(outside, join(workspace, 'escape'))
    await symlink(protectedRoot, join(workspace, 'alias'))
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', JSON.stringify([workspace]))
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', JSON.stringify([protectedRoot, join(workspace, 'auth.json')]))
    ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 5000 })
    bash = ctx.shell as SandboxBashExecutor
  })
  afterEach(async () => {
    await ctx?.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(base, { recursive: true, force: true })
  })

  async function run(command: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write', env?: Record<string, string>) {
    return (await bash.execute(bash.resolve({ command, env, sandboxPolicy: { mode, workspaceRoot: workspace } }))).result()
  }

  it('permits workspace reads and writes while system binaries remain usable', async () => {
    const result = await run('pwd > /dev/null && printf allowed > allowed.txt && /bin/cat allowed.txt && /usr/bin/stat -f %z allowed.txt')
    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stdout.text).toBe('allowed7\n')
    expect(result.stderr.text).toBe('')
    expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('allowed')
  })

  it.each(['runtime/.credentials.yaml', 'alias/.credentials.yaml', 'auth.json', 'escape/outside.txt'])('denies shell cat and writes for %s even after full-access escalation', async (path) => {
    for (const mode of ['workspace-write', 'danger-full-access'] as const) {
      const read = await run(`/bin/cat ${path}`, mode)
      expect(read.exitCode).not.toBe(0)
      expect(read.stdout.text).toBe('')
      expect(read.sandbox).toMatchObject({ denied: true, enforcement: 'full' })
      const write = await run(`printf changed > ${path}`, mode)
      expect(write.exitCode).not.toBe(0)
    }
    expect(await readFile(join(protectedRoot, '.credentials.yaml'), 'utf8')).toBe('synthetic-secret')
    expect(await readFile(join(workspace, 'auth.json'), 'utf8')).toBe('synthetic-auth-secret')
  })

  it('preserves read-only and denies reads and writes outside explicit grants, including platform temp', async () => {
    const readonly = await run('printf denied > readonly.txt', 'read-only')
    expect(readonly.exitCode).not.toBe(0)
    const read = await run(`/bin/cat ${outside}/outside.txt`)
    expect(read.exitCode).not.toBe(0)
    expect(read.stdout.text).toBe('')
    const write = await run(`printf denied > ${base}/temp-escape.txt`, 'danger-full-access')
    expect(write.exitCode).not.toBe(0)
    const allowed = await run('printf allowed > allowed.txt', 'danger-full-access')
    expect(allowed.exitCode, allowed.stderr.text).toBe(0)
  })

  it('removes ambient and explicit provider keys/instructions but retains the scoped API token', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-provider-key')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_INSTRUCTIONS', 'synthetic-instructions')
    vi.stubEnv('PAPERCLIP_API_KEY', 'synthetic-scoped-token')
    const result = await run('/usr/bin/env', 'danger-full-access', {
      OPENAI_API_KEY: 'explicit-provider-key', CUSTOM_INSTRUCTIONS: 'explicit-instructions',
    })
    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stdout.text).not.toMatch(
      /synthetic-provider-key|synthetic-instructions|explicit-provider-key|explicit-instructions|PAPERCLIP_DEEPSEEK_/,
    )
    expect(result.stdout.text).toContain('PAPERCLIP_API_KEY=synthetic-scoped-token')
    const inspected = await run('/bin/ps eww -p "$PPID"')
    expect(inspected.exitCode).not.toBe(0)
    expect(inspected.stdout.text).not.toContain('synthetic-provider-key')
  })
})
