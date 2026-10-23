/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { dirname } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { managedPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  if (policy.readRoots !== undefined) {
    const runtimeRoots = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/System/Library']
    const readRoots = [...new Set([...policy.readRoots, ...runtimeRoots].map(managedPath))]
    forms.push('(deny process-info* (target others))', '(deny mach-priv-task-port)')
    forms.push('(deny signal)', '(allow signal (target self) (target same-sandbox))')
    forms.push('(deny file-read*)')
    const ancestors = new Set<string>()
    for (const root of readRoots) {
      let parent = dirname(root)
      while (parent !== dirname(parent)) {
        ancestors.add(parent)
        parent = dirname(parent)
      }
    }
    forms.push(`(allow file-read-metadata ${[...ancestors].map(path => `(literal ${sbplString(path)})`).join(' ')})`)
    forms.push(`(allow file-read* ${readRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
    forms.push('(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))')
  }
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  // Explicit denials must follow every grant: an allowed workspace can contain runtime credentials.
  for (const root of policy.protectedPaths ?? []) {
    for (const spelling of new Set([root, managedPath(root)])) {
      forms.push(`(deny file-read* file-write* (subpath ${sbplString(spelling)}))`)
    }
  }
  return ['-p', forms.join(' ')]
}
