import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagedProfile, codexSubscriptionRecord } from './config.mjs'

test('uses an explicit provider/model and literal instructions with telemetry disabled', () => {
  const result = createManagedProfile({ model: 'anthropic/claude-example', instructions: 'Keep {{literal}} intact.' })
  assert.equal(result.provider, 'anthropic')
  assert.equal(result.model, 'claude-example')
  assert.equal(result.patch.find(row => row.id === 'acp').config.model, 'claude-example')
  assert.equal(result.patch.find(row => row.id === 'acp').config.paperclipInstructions, 'Keep {{literal}} intact.')
  assert.equal(result.patch.find(row => row.id === 'session-telemetry-otel').disabled, true)
})

test('rejects missing explicit model or instructions rather than selecting a default', () => {
  for (const model of ['', 'auto', 'gpt-example', '/gpt-example', 'openai/']) {
    assert.throws(() => createManagedProfile({ model, instructions: 'Required' }))
  }
  assert.throws(() => createManagedProfile({ model: 'openai/gpt-example', instructions: '' }))
})

test('converts an authorized Codex subscription without accepting an API key', () => {
  const access = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.signature`
  const result = codexSubscriptionRecord({ tokens: { access_token: access, refresh_token: 'test-refresh', account_id: 'test-account' } })
  assert.equal(result.kind, 'grant')
  assert.deepEqual(result.payload, { type: 'oauth', access, refresh: 'test-refresh', expires: 2_000_000_000_000, accountId: 'test-account' })
  assert.throws(() => codexSubscriptionRecord({ OPENAI_API_KEY: 'test-key' }))
  assert.throws(() => codexSubscriptionRecord({ tokens: { access_token: 'malformed', refresh_token: 'test-refresh' } }))
})

test('does not publish unchanged tokens over a concurrent account refresh', async () => {
  const { rotatedCodexSubscription } = await import('./config.mjs')
  const stale = { tokens: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'account' }, last_refresh: '2026-01-01T00:00:00.000Z' }
  const same = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', accountId: 'account' }
  assert.equal(rotatedCodexSubscription(stale, same), undefined)
  const rotated = rotatedCodexSubscription(stale, { ...same, access: 'new-access', refresh: 'new-refresh' }, new Date('2026-01-02T00:00:00Z'))
  assert.equal(rotated.last_refresh, '2026-01-02T00:00:00.000Z')
  assert.equal(rotatedCodexSubscription(rotated, { ...same, access: 'new-access', refresh: 'new-refresh' }), undefined)
  assert.throws(() => rotatedCodexSubscription(stale, { ...same, accountId: 'other' }))
})

test('settles a prompt only after its refreshed subscription is exported', async () => {
  const { PassThrough, Writable } = await import('node:stream')
  const { forwardProviderOutput } = await import('./protocol.mjs')
  const input = new PassThrough()
  let exported = false
  const observed = []
  const output = new Writable({ write(chunk, _encoding, callback) { observed.push({ text: chunk.toString(), exported }); callback() } })
  const forwarding = forwardProviderOutput(input, output, async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    exported = true
  })
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }) + '\n')
  await forwarding
  assert.equal(observed.length, 1)
  assert.equal(observed[0].exported, true)
})
