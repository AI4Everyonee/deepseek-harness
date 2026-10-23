/** Launcher permission parsing fails closed and does not retain process environment snapshots. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { managedExecutionPolicy } from '../src/managed.ts'
const policy = { mode: 'danger-full-access' as const, workspaceRoot: '/workspace' }
beforeEach(() => { vi.stubEnv('DSH_PERMISSION_MODE', 'workspace-write') })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('Paperclip managed policy', () => {
  it('preserves upstream behavior without managed fields or environment', () => {
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', undefined)
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', undefined)
    expect(managedExecutionPolicy(policy)).toBe(policy)
  })
  it.each([
    [undefined, '["/secret"]'], ['["/workspace"]', undefined], ['', '["/secret"]'],
    ['{}', '["/secret"]'], ['[]', '["/secret"]'], ['["relative"]', '["/secret"]'],
    ['["/workspace"]', '[null]'], ['["/workspace"]', '["/secret\\u0000"]'],
  ])('rejects absent or invalid permission halves (%s, %s)', (reads, protectedPaths) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', reads)
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', protectedPaths)
    expect(() => managedExecutionPolicy(policy)).toThrow()
  })
  it.each(['linux', 'win32'] as const)('rejects unimplemented managed %s hosts', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', '["/workspace"]')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', '["/secret"]')
    expect(() => managedExecutionPolicy(policy)).toThrow('requires Darwin ARM64')
  })
  it.each([undefined, '', 'approve-all', 'Read-Only'])('rejects invalid managed permission mode %s', (mode) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', '["/workspace"]')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', '["/secret"]')
    vi.stubEnv('DSH_PERMISSION_MODE', mode)
    expect(() => managedExecutionPolicy(policy)).toThrow('DSH_PERMISSION_MODE')
  })
  it('reads current environment per execution and clamps full access', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', '["/workspace"]')
    vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', '["/secret"]')
    expect(managedExecutionPolicy(policy)).toMatchObject({ mode: 'workspace-write', readRoots: ['/workspace'], protectedPaths: ['/secret'] })
    vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', '["/other"]')
    expect(managedExecutionPolicy(policy).readRoots).toEqual(['/other'])
  })
})
