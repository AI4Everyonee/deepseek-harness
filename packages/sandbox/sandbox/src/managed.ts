/** Paperclip's immutable tool permissions, read at each execution rather than cached globally. */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve symlinks in the deepest existing ancestor, including paths not created yet.
 * @param path - absolute configured or tool path.
 * @returns canonical path with its missing suffix retained.
 */
export function managedPath(path: string): string {
  let ancestor = path
  const suffix: string[] = []
  while (true) {
    try {
      return join(realpathSync.native(ancestor), ...suffix)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.unshift(ancestor.slice(parent.length).replace(/^\//, ''))
      ancestor = parent
    }
  }
}

function parseRoots(raw: string | undefined, name: string): string[] {
  if (raw === undefined) throw new Error(`Paperclip managed execution requires ${name}`)
  const paths: unknown = JSON.parse(raw)
  if (!Array.isArray(paths) || paths.length === 0
    || !paths.every((path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f]/.test(path))) {
    throw new Error(`${name} must contain a non-empty JSON array of absolute paths`)
  }
  return [...new Set(paths.flatMap(path => [path, managedPath(path)]))]
}

/**
 * Apply launcher grants, capped by DSH_PERMISSION_MODE even after approval.
 * Both path lists and the permission mode must be valid. Managed hosts require Darwin ARM64.
 * @param policy - resolved ordinary policy, which cannot override launcher grants.
 * @returns policy with launch permissions applied, or the unchanged upstream policy when unmanaged.
 */
export function managedExecutionPolicy(policy: SandboxExecutionPolicy): SandboxExecutionPolicy {
  const reads = process.env.PAPERCLIP_DEEPSEEK_READ_ROOTS
  const protectedRoots = process.env.PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS
  if (reads === undefined && protectedRoots === undefined
    && policy.readRoots === undefined && policy.protectedPaths === undefined) return policy
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Paperclip managed tool isolation requires Darwin ARM64')
  }
  const launchMode = process.env.DSH_PERMISSION_MODE
  if (launchMode !== 'read-only' && launchMode !== 'workspace-write' && launchMode !== 'danger-full-access') {
    throw new Error('Paperclip managed execution requires a valid DSH_PERMISSION_MODE')
  }
  const readRoots = reads === undefined && protectedRoots === undefined
    ? policy.readRoots
    : parseRoots(reads, 'PAPERCLIP_DEEPSEEK_READ_ROOTS')
  const protectedPaths = reads === undefined && protectedRoots === undefined
    ? policy.protectedPaths
    : parseRoots(protectedRoots, 'PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS')
  if (readRoots === undefined || protectedPaths === undefined) throw new Error('Paperclip managed execution requires both readRoots and protectedPaths')
  return {
    ...policy,
    mode: launchMode === 'read-only' || policy.mode === 'read-only' ? 'read-only' : 'workspace-write',
    readRoots,
    protectedPaths,
  }
}
