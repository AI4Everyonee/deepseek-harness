/** Model requests carry the loop's session, turn and step so adapters can send them as request headers. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('request identity', () => {
  it('stamps each request with the session, turn and per-turn step reported in step events', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const handle = await ctx.agents.create({
      sessionId: SessionId('identity-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    for (const text of ['first', 'second']) {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    }

    const steps = handle.agent.session.snapshotEvents()
      .flatMap(event => event.type === 'step/start' ? [{ turn: event.data.turn, step: event.data.step }] : [])
    expect(steps).toEqual([{ turn: 1, step: 1 }, { turn: 2, step: 1 }])
    expect(adapter.requests.map(({ sessionId, turn, step }) => ({ sessionId, turn, step })))
      .toEqual(steps.map(position => ({ sessionId: 'identity-session', ...position })))
    await handle.dispose()
  })
})
