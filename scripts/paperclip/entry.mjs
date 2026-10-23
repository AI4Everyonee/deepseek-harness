/** Managed launcher for the fork's ACP profile. No ambient account discovery. */
import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { createManagedProfile, codexSubscriptionRecord, rotatedCodexSubscription } from './config.mjs'
import { forwardProviderOutput } from './protocol.mjs'

const home = process.env.DSH_HOME
if (!home || !isAbsolute(home) || process.env.DSH_AGENTS_HOME !== home) {
  throw new Error('DeepSeek Harness requires its managed private home')
}
const profile = createManagedProfile({ model: process.env.PAPERCLIP_DEEPSEEK_MODEL,
  instructions: process.env.PAPERCLIP_DEEPSEEK_INSTRUCTIONS })
await mkdir(home, { recursive: true, mode: 0o700 })
const patchPath = join(home, 'paperclip-profile.json')
await writeFile(patchPath, JSON.stringify(profile.patch), { mode: 0o600 })
const authPath = join(home, 'auth.json')
const credentialsPath = join(home, '.credentials.yaml')
let subscription
if (profile.provider === 'openai-codex') {
  subscription = JSON.parse(await readFile(authPath, 'utf8'))
  await writeFile(credentialsPath, JSON.stringify({ version: 1, records: {
    'llm-pi-ai/openai-codex': codexSubscriptionRecord(subscription),
  } }), { mode: 0o600 })
}
const childEnv = { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_MAX_TOKENS_AS_SUCCESS: 'false', PAPERCLIP_DEEPSEEK_MANAGED: '1' }
delete childEnv.PAPERCLIP_DEEPSEEK_INSTRUCTIONS
delete childEnv.PAPERCLIP_DEEPSEEK_MODEL
async function publish(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
async function syncSubscription() {
  if (!subscription) return
  const document = load(await readFile(credentialsPath, 'utf8'))
  const next = rotatedCodexSubscription(subscription, document?.records?.['llm-pi-ai/openai-codex']?.payload)
  if (!next) return
  await publish(join(home, 'auth-refresh.json'), JSON.stringify(next))
  await publish(authPath, JSON.stringify(next))
  subscription = next
}
let refreshTail = Promise.resolve()
let managedFailure = false
const flush = () => {
  const attempt = refreshTail.then(syncSubscription)
  refreshTail = attempt
  return attempt
}
const watcher = subscription ? watch(home, (_event, filename) => {
  if (filename !== '.credentials.yaml') return
  void flush().catch(() => { managedFailure = true; child.kill('SIGTERM') })
}) : null
const child = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)),
  '--profile', 'acp', '--patch', patchPath], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] })
process.stdin.pipe(child.stdin)
const output = forwardProviderOutput(child.stdout, process.stdout, flush).catch(error => {
  managedFailure = true
  child.kill('SIGTERM')
  throw error
})
void output.catch(() => {})
child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.kill('SIGTERM') })
const stop = () => { child.kill('SIGTERM') }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
const status = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})
// Publish native refreshes back to the staged credential; Paperclip owns vault CAS.
watcher?.close()
await output
await flush()
process.exitCode = managedFailure ? 1 : status.code ?? 1
