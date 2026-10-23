/** Managed filesystem operations retain the launcher's read/write exclusions across escalation. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'

let base: string
let workspace: string
let protectedRoot: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem

beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
  base = await mkdtemp(join(tmpdir(), 'managed-fs-'))
  workspace = join(base, 'workspace')
  protectedRoot = join(workspace, 'runtime')
  outside = join(base, 'outside')
  await mkdir(protectedRoot, { recursive: true })
  await mkdir(outside)
  await writeFile(join(protectedRoot, '.credentials.yaml'), 'synthetic-provider-secret')
  await writeFile(join(outside, 'auth.json'), 'synthetic-auth-secret')
  await symlink(outside, join(workspace, 'escape'))
  await symlink(protectedRoot, join(workspace, 'alias'))
  vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', JSON.stringify([workspace]))
  vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', JSON.stringify([protectedRoot, join(outside, 'auth.json')]))
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  fs = ctx.fs as SandboxedFileSystem
})
afterEach(async () => {
  await ctx?.fiber.dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(base, { recursive: true, force: true })
})

describe('managed filesystem grants', () => {
  it.each(['runtime/.credentials.yaml', 'alias/.credentials.yaml', 'escape/auth.json'])('blocks every read path for %s', async (path) => {
    const target = await fs.resolve(path)
    const operations = [
      () => fs.readText(target),
      () => fs.streamText(target),
      () => fs.readBytes(target, undefined, 1000),
      () => fs.readByteRange(target, { offset: 0, length: 10 }),
      () => fs.stat(target),
      () => fs.lstat(path),
      () => fs.watch(target, () => {}, new AbortController().signal),
    ]
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('rejects protected directory listings and omits protected children and escapes', async () => {
    await expect(fs.listDir(await fs.resolve(protectedRoot))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await fs.listDir(await fs.resolve(workspace))).toEqual([])
  })

  it('allows workspace reads, streams, lists, metadata, watches, writes and edits', async () => {
    const target = await fs.resolve('allowed.txt')
    await fs.writeText(target, 'before')
    expect(await fs.readText(target)).toBe('before')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('before')
    expect(await fs.stat(target)).toMatchObject({ type: 'file' })
    expect((await fs.listDir(await fs.resolve(workspace))).map(entry => entry.name)).toEqual(['allowed.txt'])
    const stop = await fs.watch(target, () => {}, new AbortController().signal)
    await stop()
    await fs.editText(target, { oldString: 'before', newString: 'after', replaceAll: false })
    expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('after')
  })

  it('does not let a full-access escalation read or modify protected and outside paths', async () => {
    const full = { mode: 'danger-full-access' as const, workspaceRoot: workspace }
    for (const path of ['runtime/.credentials.yaml', 'alias/.credentials.yaml', 'escape/new.txt', join(outside, 'new.txt')]) {
      await expect(fs.writeText(await fs.resolve(path), 'leak', undefined, undefined, full)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    await expect(fs.editText(await fs.resolve('runtime/.credentials.yaml'), { oldString: 'synthetic', newString: 'changed', replaceAll: false }, undefined, undefined, full))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await fs.writeText(await fs.resolve('allowed.txt'), 'allowed', undefined, undefined, full)
    expect(await fs.readText(await fs.resolve('allowed.txt'))).toBe('allowed')
  })

  it('preserves read-only mode and excludes the implicit platform temp grant', async () => {
    await expect(fs.writeText(await fs.resolve('readonly.txt'), 'no', undefined, undefined, { mode: 'read-only', workspaceRoot: workspace }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.writeText(await fs.resolve(join(base, 'temp-escape.txt')), 'no')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
