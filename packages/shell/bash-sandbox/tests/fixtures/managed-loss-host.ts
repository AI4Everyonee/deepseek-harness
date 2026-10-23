/** Credential-free native harness fixture that owns a real managed Darwin Bash group. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const [root, mode] = process.argv.slice(2)
if (root === undefined || (mode !== 'foreground' && mode !== 'background' && mode !== 'normal' && mode !== 'stop')) throw new Error('expected root and foreground/background')
const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
await ctx.plugin(LocalSandboxProvider, {})
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(SandboxBashExecutor, { cwd: root, timeoutMs: 15000, graceMs: 100 })
const tail = mode === 'background' ? 'exit 0' : 'wait "$sleeper"; printf late > late.txt'
const sleeping = `sleep 8 & sleeper=$!; printf '%s %s' "$$" "$sleeper" > started.txt; ${tail}`
const command = mode === 'normal' ? '/bin/cat; exit 7' : sleeping
const execution = await ctx.shell.execute(ctx.shell.resolve({ command, stdin: mode === 'normal' ? 'lease-stdin' : undefined }))
if (mode === 'stop') process.once('message', () => { void ctx.fiber.dispose() })
const outcome = await execution.result()
await writeFile(join(root, 'settled.json'), JSON.stringify(outcome))
if (mode === 'normal') {
  const probe = ctx.subprocess.spawn({
    argv: [process.execPath, '-e', 'console.log(JSON.stringify({connected:process.connected===true,send:typeof process.send,channelEnv:process.env.NODE_CHANNEL_FD??null}))'],
    cwd: root, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 100,
  })
  await probe.done
  await probe.waitForExit()
  await writeFile(join(root, 'ipc.json'), probe.collected.stdout!.readFrom(0).text)
}
if (mode === 'normal' || mode === 'stop') await ctx.fiber.dispose()
else setInterval(() => {}, 1000)
