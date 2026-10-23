/** Build a self-contained Paperclip ACP runtime from this fork's checked-out source. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, glob, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { restoreLegacyHoists } from '../executable-packaging.ts'
import { parseArgs } from 'node:util'
import { materializeStagedLinks, deduplicateStagedWorkspacePackages } from '../build-exe-for-python-sdk-staging.ts'

const root = process.cwd()
const { values } = parseArgs({ options: { output: { type: 'string' }, 'skip-build': { type: 'boolean' } } })
if (!values.output) throw new Error('Usage: tsx scripts/paperclip/build.ts --output <new-directory> [--skip-build]')
const output = resolve(values.output)
if (output === root || root.startsWith(`${output}/`)) throw new Error('Output cannot contain the source checkout')
const run = (args: string[]) => {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} failed (${String(result.status)})`)
}
if (!values['skip-build']) run(['run', 'build:lib:host'])
try {
  run(['--filter', 'dsh-python-runtime-closure', 'deploy', '--legacy', '--prod',
    '--config.allow-unused-patches=true', '--config.node-linker=hoisted',
    '--config.auto-install-peers=false', '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false', output])
} finally {
  run(['install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts'])
}
await restoreLegacyHoists(output, join(root, 'python/sdk-runtime/node_modules'))
await materializeStagedLinks(output)
await deduplicateStagedWorkspacePackages(output, root)
for await (const file of glob('node_modules/**/{README*.md,CHANGELOG*.md,HISTORY*.md,*.map,*.d.ts,*.d.mts,*.d.cts}', {
  cwd: output, exclude: ['node_modules/**/assets/**'],
})) await rm(join(output, file), { force: true })
await mkdir(join(output, 'bin'), { recursive: true })
await cp(process.execPath, join(output, 'bin/node'))
await mkdir(join(output, 'scripts/paperclip'), { recursive: true })
for (const file of ['entry.mjs', 'config.mjs', 'protocol.mjs']) await cp(join(root, 'scripts/paperclip', file), join(output, 'scripts/paperclip', file))
const entries: { path: string; sha256: string; size: number; executable: boolean }[] = []
const walk = async (directory: string, prefix = ''): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) { await walk(absolute, path); continue }
    if (!entry.isFile()) throw new Error(`Runtime closure contains a non-regular entry: ${path}`)
    const metadata = await stat(absolute)
    entries.push({ path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex'),
      size: metadata.size, executable: (metadata.mode & 0o111) !== 0 })
  }
}
await walk(output)
entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const closureSha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
if (source.status !== 0) throw new Error('Cannot determine fork source revision')
await writeFile(join(output, '.paperclip-deepseek-closure.json'), JSON.stringify({ entries }))
await writeFile(join(output, '.paperclip-deepseek-source.json'), JSON.stringify({
  repository: 'https://github.com/AI4Everyonee/deepseek-harness', revision: source.stdout.trim(),
  target: `${process.platform}-${process.arch}`, nodeVersion: process.version, closureSha256,
}, null, 2))
console.log(JSON.stringify({ output, closureSha256, files: entries.length }))
