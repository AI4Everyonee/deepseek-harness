/** Credential-free installed-runtime protocol probe; never submits a prompt. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const runtime = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node scripts/paperclip/probe.mjs <installed-runtime>')
const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-paperclip-probe-')))
const access = `synthetic.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.synthetic`
await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: {
  access_token: access, refresh_token: 'synthetic', account_id: 'synthetic-account',
} }), { mode: 0o600 })
const child = spawn(join(runtime, 'bin/node'), [join(runtime, 'scripts/paperclip/entry.mjs')], {
  cwd: home, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_AGENTS_HOME: home, DSH_PERMISSION_MODE: 'workspace-write',
    PAPERCLIP_DEEPSEEK_MODEL: 'openai-codex/gpt-5.6-luna',
    PAPERCLIP_DEEPSEEK_READ_ROOTS: JSON.stringify([home]),
    PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS: JSON.stringify([join(home, 'auth.json'), join(home, '.credentials.yaml')]),
    PAPERCLIP_DEEPSEEK_INSTRUCTIONS: 'Required literal {{instructions}}. Do not make a model call.',
  }, stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000) })
const pending = new Map()
let nextId = 0
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  const message = JSON.parse(line)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
})
const exited = new Promise(resolve => child.once('exit', (code, signal) => {
  for (const request of pending.values()) request.reject(new Error(`Runtime exited: ${String(code)} ${String(signal)} ${stderr}`))
  resolve({ code, signal })
}))
const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
try {
  const hello = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(hello.agentInfo.name, 'deepseek-harness-acp')
  const session = await request('session/new', { cwd: home, mcpServers: [] })
  assert.equal(session._meta.paperclipDeepseekInstructions.schema, 'paperclip.deepseek.instructions.v1')
  assert.equal(session.configOptions.find(option => option.id === 'model').currentValue, '["openai-codex","gpt-5.6-luna"]')
  await request('session/close', { sessionId: session.sessionId })
  const resumed = await request('session/load', { sessionId: session.sessionId, cwd: home, mcpServers: [] })
  assert.equal(resumed._meta.paperclipDeepseekInstructions.digest, session._meta.paperclipDeepseekInstructions.digest)
  child.stdin.end()
  const result = await exited
  assert.equal(result.code, 0, stderr)
  console.log('PASS: installed fork initialize, exact model/instructions, close/resume, EOF cleanup; no model prompt')
} finally {
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exited
  await rm(home, { recursive: true, force: true })
}
