import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { makeBridgeHarness, textResponse } from './harness.ts'

it('admits and acknowledges exact literal Paperclip instructions before a model request', async () => {
  const content = 'Follow Paperclip governance. Preserve {{literal}} text.'
  const harness = await makeBridgeHarness({
    config: { paperclipInstructions: content },
    script: [textResponse('finished')],
  })
  try {
    await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(session._meta?.paperclipDeepseekInstructions).toEqual({
      schema: 'paperclip.deepseek.instructions.v1',
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      byteLength: Buffer.byteLength(content),
    })
    await harness.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Work' }] })
    expect(JSON.stringify(harness.adapter.requests[0])).toContain(content)
  } finally {
    await harness.dispose()
  }
})
