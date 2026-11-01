/** The `--json` run projection: commit-point emission, ordering, bounding, and disposal. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SpillLocator, type SaveTextSpill, type SpillStore } from '@deepseek-ai/dsh-spill'
import { boundJsonLine, MAX_STRING_BYTES, projectJsonRun, type JsonProjectionOptions } from '../src/json-stream.ts'

interface ProjectionHarness {
  readonly lines: string[]
  readonly spillCalls: SaveTextSpill[]
  readonly projection: ReturnType<typeof projectJsonRun>
  readonly agent: Agent
  readonly session: Session
  readonly parsed: () => Record<string, unknown>[]
  emitSession(event: SessionEvent): void
  emitRawSession(session: unknown, event: SessionEvent): void
}

/** One committed assistant message carrying the given content blocks. */
function assistantMessage(content: unknown[], usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      stream: [],
      turn: 1,
      step: 1,
      ...usage === undefined ? {} : { usage },
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  } as unknown as SessionEvent
}

/** One discarded attempt whose stream reports the given usage sample. */
function attemptWithUsage(usage: unknown): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
  } as unknown as SessionEvent
}

/** One step boundary event closing the accumulated usage window. */
function stepEnd(): SessionEvent {
  return { type: 'step/end', data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

/** One event of the given type carrying `data` as-is, cast once for events the typed builders do not cover. */
function plainEvent(type: string, data: object): SessionEvent {
  return { type, data } as SessionEvent
}

/** One tool call event naming the tool behind a later result. */
function toolCall(callId: string, name: string): SessionEvent {
  return plainEvent('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}

/** One tool result event with the given surface placement. */
function toolResult(
  callId: string,
  content: unknown[],
  surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number } = 'append',
): SessionEvent {
  return {
    type: 'tool/result',
    surfaceOp,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, isError: false, content },
    },
  } as unknown as SessionEvent
}

/** Drive the projector through a minimal Context and Agent double. */
function harness(
  options: JsonProjectionOptions = {},
  agentId = 'session-1',
  cwd: string | null = '/',
  spillStore?: Pick<SpillStore, 'saveText'>,
  /** Replaces the recording sink write, e.g. to make it throw. */
  sinkWrite?: (chunk: string) => void,
): ProjectionHarness {
  const spillCalls: SaveTextSpill[] = []
  const lines: string[] = []
  const sessionListeners = new Set<(session: unknown, event: SessionEvent) => void>()
  const ctx = {
    get: (name: string) => name === 'spillStore' && spillStore !== undefined
      ? { saveText: (input: SaveTextSpill) => { spillCalls.push(input); return spillStore.saveText(input) } }
      : undefined,
    on(name: string, handler: unknown) {
      if (name === 'session/event') sessionListeners.add(handler as never)
      return () => { sessionListeners.delete(handler as never) }
    },
  } as Pick<Context, 'get' | 'on'> as Context
  const session = { header: { id: agentId } } as Pick<Session, 'header'> as Session
  const agent = { id: agentId, session } as unknown as Agent
  const projection = projectJsonRun(ctx, agent, {
    write: (chunk: string) => { (sinkWrite ?? ((line) => { lines.push(line) }))(chunk); return true },
  }, { ...options, ...cwd === null ? {} : { cwd } })
  return {
    lines,
    spillCalls,
    projection,
    agent,
    session,
    parsed: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
    emitSession: (event) => { for (const listener of sessionListeners) listener(session, event) },
    emitRawSession: (rawSession, event) => { for (const listener of sessionListeners) listener(rawSession, event) },
  }
}

describe('--json projection', () => {
  it('opens with the session event before any observed event', () => {
    const test = harness()
    expect(test.parsed()).toEqual([{ type: 'session', sessionId: 'session-1', cwd: '/' }])
  })

  it('defaults the reported cwd and the per-string cap', () => {
    const test = harness({}, 'session-1', null)
    expect(test.parsed()[0]).toEqual({ type: 'session', sessionId: 'session-1', cwd: process.cwd() })
    test.emitSession(assistantMessage([{ type: 'text', text: 'x'.repeat(9000) }]))
    expect(test.parsed()[1]?.truncated).toBe(true)
    expect((test.parsed()[1]?.text as string).length).toBe(8 * 1024)
  })

  it('reports turn and step boundaries with the turn-end reason', () => {
    const test = harness()
    test.emitSession({ type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    test.emitSession({ type: 'step/start', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    test.emitSession({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent)
    expect(test.parsed().slice(1)).toEqual([
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    ])
  })

  it('projects committed reasoning and text in content order', () => {
    const test = harness()
    test.emitSession(assistantMessage([
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'answer' },
    ]))
    expect(test.parsed().slice(1)).toEqual([
      { type: 'thinking', text: 'think' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('ignores a discarded attempt so retried content never reaches the stream', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [] },
    } as unknown as SessionEvent)
    test.emitSession({ type: 'session/title', data: { title: 'ignored' } } as unknown as SessionEvent)
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('attaches step usage to step_end and omits it when absent', () => {
    const test = harness()
    test.emitSession({ type: 'step/end', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    test.emitSession(assistantMessage([{ type: 'text', text: 'x' }], { inputTokens: 3, outputTokens: 4 }))
    test.emitSession({ type: 'step/end', data: { turn: 1, step: 2 } } as unknown as SessionEvent)
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
    expect(events[3]).toEqual({
      type: 'status', phase: 'step_end', turn: 1, step: 2,
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })

  it('reports tool results as completed or errored and keeps the final event last', () => {
    const test = harness()
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'a.txt' }]))
    test.emitSession({
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c2',
          isError: true,
          content: [{ type: 'image' }, { type: 'text' }, { type: 'text', text: 'boom' }],
        },
      },
    } as unknown as SessionEvent)
    void test.projection.finish('done')
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.txt' })
    expect(events[2]).toEqual({ type: 'tool_result', callId: 'c2', status: 'error', result: 'boom' })
    expect(events.at(-1)).toEqual({ type: 'final', sessionId: 'session-1', reason: null, text: 'done' })
  })

  it('skips a compaction replacement of an older tool result', () => {
    const test = harness()
    test.emitSession(toolResult('old', [{ type: 'text', text: 'history' }], { op: 'replace', startSeq: 1, endSeq: 2 }))
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('keeps structured failure identity and bounds reviewer detail', () => {
    const test = harness({ maxStringBytes: 32 })
    const event = toolResult('denied', [{ type: 'text', text: 'body was not executed' }])
    if (event.type !== 'tool/result') throw new Error('expected a tool result')
    event.data.message = { ...event.data.message, isError: true }
    event.data.error = { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: 'x'.repeat(64) }
    test.emitSession(event)
    expect(test.parsed()[1]).toEqual({
      type: 'tool_result', callId: 'denied', status: 'error', result: 'body was not executed',
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: 'x'.repeat(32) },
      truncated: true,
    })
  })

  it('keeps non-JSON tool arguments raw and bounds nested values', () => {
    const test = harness({ maxStringBytes: 11 }, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'raw', name: 'bash', arguments: 'not json' },
    } as unknown as SessionEvent)
    test.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'nested',
        name: 'bash',
        arguments: JSON.stringify({ items: ['éééééé', null, true], n: 1 }),
      },
    } as unknown as SessionEvent)
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'tool_call', callId: 'raw', tool: 'bash', input: 'not json' })
    expect(events[2]).toEqual({
      type: 'tool_call',
      callId: 'nested',
      tool: 'bash',
      input: { items: ['ééééé', null, true], n: 1 },
      truncated: true,
    })
  })

  it('keeps raw arguments that JSON cannot round-trip, such as an overflowing number', () => {
    const test = harness({}, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'inf', name: 'bash', arguments: '{"n":1e400}' },
    } as unknown as SessionEvent)
    expect(test.parsed()[1]).toEqual({ type: 'tool_call', callId: 'inf', tool: 'bash', input: '{"n":1e400}' })
  })

  it('keeps a literal __proto__ key and bounds over-long object keys', () => {
    const proto = harness({ maxStringBytes: 32 }, 's1')
    proto.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'p',
        name: 'bash',
        arguments: '{"__proto__":{"polluted":true},"a":1}',
      },
    } as unknown as SessionEvent)
    const protoInput = proto.parsed()[1]?.input as Record<string, unknown>
    expect(Object.keys(protoInput)).toEqual(['__proto__', 'a'])
    expect(protoInput['__proto__']).toEqual({ polluted: true })

    const longKey = harness({ maxStringBytes: 8 }, 's1')
    longKey.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'k',
        name: 'bash',
        arguments: JSON.stringify({ ['k'.repeat(20)]: 1 }),
      },
    } as unknown as SessionEvent)
    const longEvent = longKey.parsed()[1] as { input: Record<string, unknown>; truncated?: boolean }
    expect(Object.keys(longEvent.input)).toEqual(['kkkkkkkk'])
    expect(longEvent.truncated).toBe(true)
  })

  it('drops a split trailing multibyte character when truncating', () => {
    const test = harness({ maxStringBytes: 5 }, 's1')
    test.emitSession(assistantMessage([{ type: 'text', text: 'ééé' }]))
    expect(test.parsed()[1]).toEqual({ type: 'text', text: 'éé', truncated: true })
  })

  it('normalizes empty tool arguments to an empty object like the executor', () => {
    const test = harness({}, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'empty', name: 'bash', arguments: '' },
    } as unknown as SessionEvent)
    expect(test.parsed()[1]).toEqual({ type: 'tool_call', callId: 'empty', tool: 'bash', input: {} })
  })

  it('bounds one whole event line, dropping structured fields before scalars', () => {
    const input = Array.from({ length: 20_000 }, (_, index) => index)
    const line = boundJsonLine({ type: 'tool_call', callId: 'c', tool: 'bash', input }, MAX_STRING_BYTES, 1024)
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1024)
    expect(JSON.parse(line)).toEqual({ type: 'tool_call', callId: 'c', tool: 'bash', truncated: true })
  })

  it('reduces a payload to its type when even its scalars exceed the line cap', () => {
    const line = boundJsonLine({ type: 'text', text: 'x'.repeat(2000) }, 4096, 64)
    expect(JSON.parse(line)).toEqual({ type: 'text', truncated: true })
    expect(JSON.parse(boundJsonLine({ type: 'text', text: 'ok' }))).toEqual({ type: 'text', text: 'ok' })
  })

  it('caps an error line even when control characters expand under JSON escaping', () => {
    const line = boundJsonLine({ type: 'error', message: '\u0000'.repeat(MAX_STRING_BYTES) })
    expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(32 * 1024)
    expect(JSON.parse(line)).toEqual({ type: 'error', truncated: true })
  })

  it('reserves the trailing newline inside the whole-line cap', () => {
    // A 64-byte line exactly fills a 64-byte cap; the writer's newline must
    // force the scalar fallback rather than write 65 bytes.
    const line = boundJsonLine({ type: 'text', text: 'x'.repeat(39) }, 4096, 64)
    expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(64)
    expect(JSON.parse(line)).toEqual({ type: 'text', truncated: true })
  })

  it('cuts a payload that nests past the depth budget instead of overflowing the stack', () => {
    let deepArray: unknown = 'leaf'
    for (let level = 0; level < 200; level += 1) deepArray = [deepArray]
    expect(JSON.parse(boundJsonLine({ type: 'tool_call', input: deepArray })))
      .toMatchObject({ type: 'tool_call', truncated: true })

    let deepObject: unknown = 'leaf'
    for (let level = 0; level < 200; level += 1) deepObject = { next: deepObject }
    expect(JSON.parse(boundJsonLine({ type: 'tool_call', input: deepObject })))
      .toMatchObject({ type: 'tool_call', truncated: true })
  })

  it('sums retried attempt usage into the step total and drops an unshared bucket', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4 }))
    test.emitSession(assistantMessage(
      [{ type: 'text', text: 'ok' }],
      { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    ))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({
      type: 'status', phase: 'step_end', turn: 1, step: 1,
      usage: { inputTokens: 13, outputTokens: 3, totalTokens: 16 },
    })
  })

  it('sums every optional bucket both attempts report', () => {
    const test = harness()
    const sample = {
      inputTokens: 2, outputTokens: 1, totalTokens: 3,
      cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1,
    }
    test.emitSession(attemptWithUsage(sample))
    test.emitSession(attemptWithUsage(sample))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toMatchObject({
      usage: {
        inputTokens: 4, outputTokens: 2, totalTokens: 6,
        cacheReadTokens: 2, cacheWriteTokens: 2, reasoningTokens: 2,
      },
    })
  })

  it('drops a bucket only the later attempt reports', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 1, outputTokens: 1 }))
    test.emitSession(attemptWithUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 2 }))
    test.emitSession(stepEnd())
    const usage = (test.parsed().at(-1) as { usage: Record<string, unknown> }).usage
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 2 })
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it('reads a message usage sample from its stream when the field is absent', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }],
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent)
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toMatchObject({ usage: { inputTokens: 5, outputTokens: 1 } })
  })

  it('omits the step total when a later attempt reports no usage sample', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 7, outputTokens: 3 }))
    test.emitSession(assistantMessage([{ type: 'text', text: 'ok' }]))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('omits the step total when an earlier attempt reports no usage sample', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [] },
    } as unknown as SessionEvent)
    test.emitSession(assistantMessage([{ type: 'text', text: 'ok' }], { inputTokens: 1, outputTokens: 1 }))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('omits the step total when no attempt reports a usage sample', () => {
    const test = harness()
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('writes the terminal final event without bounding its answer', () => {
    const test = harness({ maxStringBytes: 4 })
    void test.projection.finish('abcdefgh')
    expect(test.parsed().at(-1)).toEqual({ type: 'final', sessionId: 'session-1', reason: null, text: 'abcdefgh' })
  })

  it('retains the durable completion reason and exact identity in the final record', () => {
    const test = harness({ maxStringBytes: 4 }, 'session-exact')
    void test.projection.finish('answer', { kind: 'completed' })
    expect(test.parsed().at(-1)).toEqual({ type: 'final', sessionId: 'session-exact', reason: { kind: 'completed' }, text: 'answer' })
  })

  it('reports an interrupted task separately from its earlier assistant text', () => {
    const test = harness()
    void test.projection.finish('I will start by reading the files.', { kind: 'aborted', reason: { kind: 'user' } })
    expect(test.parsed().at(-1)).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } })
  })

  it('ignores events from another Session and stops writing after dispose', () => {
    const test = harness()
    test.emitRawSession({}, assistantMessage([{ type: 'text', text: 'foreign' }]))
    test.projection.dispose()
    test.emitSession(assistantMessage([{ type: 'text', text: 'late' }]))
    void test.projection.finish('ignored')
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('bounds one projected payload through the line writer', () => {
    expect(JSON.parse(boundJsonLine({ type: 'error', message: 'x'.repeat(20) }, 8, 4096)))
      .toEqual({ type: 'error', message: 'xxxxxxxx', truncated: true })
    expect(JSON.parse(boundJsonLine({ type: 'error', message: 'ok' }))).toEqual({ type: 'error', message: 'ok' })
  })
})

describe('truncated tool_result fullOutput', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** A spill store writing each text to a fresh file in a temp directory. */
  async function fileStore(): Promise<{ store: Pick<SpillStore, 'saveText'>; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'json-stream-spill-'))
    dirs.push(dir)
    let n = 0
    return {
      dir,
      store: {
        saveText: async (input) => {
          const path = join(dir, `${n++}-${input.suggestedName}`)
          await writeFile(path, input.content, { mode: 0o600 })
          return { locator: SpillLocator(path), bytes: Buffer.byteLength(input.content), retrievalHint: 'Use read.' }
        },
      },
    }
  }

  it('points a 40 KB result at a file holding the exact text', async () => {
    const { store } = await fileStore()
    const test = harness({}, 'session-1', '/', store)
    const full = 'é'.repeat(20_000)
    test.emitSession(toolCall('c1', 'bash'))
    test.emitSession(toolResult('c1', [{ type: 'text', text: full }]))
    await test.projection.finish('done')
    const results = test.parsed().filter(event => event.type === 'tool_result')
    expect(results).toHaveLength(1)
    const event = results[0]!
    expect(event.truncated).toBe(true)
    const output = event.fullOutput as { path: string; bytes: number; sha256: string }
    expect(Object.keys(output).sort()).toEqual(['bytes', 'path', 'sha256'])
    const bytes = await readFile(output.path)
    expect(bytes.toString('utf8')).toBe(full)
    expect(output.bytes).toBe(bytes.length)
    expect(output.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(test.spillCalls[0]).toMatchObject({ owner: { sessionId: 'session-1' }, source: { kind: 'tool', toolName: 'bash', callId: 'c1' } })
    expect(Buffer.byteLength(test.lines.find(line => line.includes('tool_result'))!)).toBeLessThanOrEqual(32 * 1024)
    expect(test.parsed().at(-1)?.type).toBe('final')
  })

  it('keeps stream order while the file is written', async () => {
    const { store } = await fileStore()
    const test = harness({}, 'session-1', '/', store)
    test.emitSession(toolResult('big', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    test.emitSession(toolResult('small', [{ type: 'text', text: 'ok' }]))
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
    await test.projection.finish('done')
    expect(test.parsed().map(event => event.callId ?? event.type)).toEqual(['session', 'big', 'small', 'final'])
  })

  it('gives a short result no fullOutput', async () => {
    const { store } = await fileStore()
    const test = harness({}, 'session-1', '/', store)
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'short' }]))
    expect(test.parsed()[1]).toEqual({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'short' })
    expect(test.spillCalls).toHaveLength(0)
  })

  it('omits fullOutput without throwing when the write fails', async () => {
    const test = harness({}, 'session-1', '/', { saveText: () => Promise.reject(new Error('ENOSPC')) })
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    await test.projection.finish('done')
    const event = test.parsed()[1]!
    expect(event.truncated).toBe(true)
    expect(event).not.toHaveProperty('fullOutput')
  })

  it('omits fullOutput when no spill store is composed', async () => {
    const test = harness()
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    await test.projection.finish('done')
    expect(test.parsed()[1]).toMatchObject({ truncated: true })
    expect(test.parsed()[1]).not.toHaveProperty('fullOutput')
  })

  it('never points fullOutput at a path named inside the result text', async () => {
    const { store, dir } = await fileStore()
    const secret = join(dir, 'credentials.txt')
    await writeFile(secret, 'secret')
    const text = `${'preview '.repeat(2000)}\n\n(Omitted 1 bytes. Full formatted result stored at: ${secret}. Use read.)`
    const test = harness({}, 'session-1', '/', store)
    test.emitSession(toolResult('c1', [{ type: 'text', text }]))
    await test.projection.finish('done')
    expect(test.spillCalls).toHaveLength(1)
    const output = test.parsed()[1]!.fullOutput as { path: string; bytes: number; sha256: string }
    expect(output.path).not.toBe(secret)
    expect(await readFile(output.path, 'utf8')).toBe(text)
    expect(output.bytes).toBe(Buffer.byteLength(text))
  })

  it('omits fullOutput when the store returns a non-absolute locator', async () => {
    const test = harness({}, 'session-1', '/', {
      saveText: () => Promise.resolve({ locator: SpillLocator('relative/file.txt'), bytes: 1, retrievalHint: 'Use read.' }),
    })
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    await test.projection.finish('done')
    expect(test.parsed()[1]).toMatchObject({ truncated: true })
    expect(test.parsed()[1]).not.toHaveProperty('fullOutput')
  })

  it('settles a pending tool_result before a later error line', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = harness({}, 'session-1', '/', {
      saveText: async (input) => {
        await gate
        return { locator: SpillLocator('/spill/out.txt'), bytes: Buffer.byteLength(input.content), retrievalHint: 'Use read.' }
      },
    })
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
    const settled = test.projection.settled().then(() => { test.lines.push(`${JSON.stringify({ type: 'error', message: 'boom' })}\n`) })
    release()
    await settled
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'tool_result', 'error'])
  })

  it('keeps writing later lines after a sink write throws and reports it', async () => {
    const errors: unknown[] = []
    const written: string[] = []
    let writes = 0
    const test = harness({ onWriteError: error => errors.push(error) }, 'session-1', '/', undefined, (chunk) => {
      if (++writes === 2) throw new Error('EPIPE')
      written.push(chunk)
    })
    test.emitSession(toolResult('lost', [{ type: 'text', text: 'a' }]))
    test.emitSession(toolResult('kept', [{ type: 'text', text: 'b' }]))
    await test.projection.finish('done')
    expect(errors).toHaveLength(1)
    expect(written.map(line => (JSON.parse(line) as { callId?: string; type: string }).callId ?? 'x'))
      .toEqual(['x', 'kept', 'x'])
  })

  it('keeps writing later lines after a queued line fails to write and reports it', async () => {
    const errors: unknown[] = []
    const written: string[] = []
    let writes = 0
    const { store } = await fileStore()
    const test = harness({ onWriteError: error => errors.push(error) }, 'session-1', '/', store, (chunk) => {
      if (++writes === 2) throw new Error('EPIPE')
      written.push(chunk)
    })
    test.emitSession(toolResult('big', [{ type: 'text', text: 'x'.repeat(40_000) }]))
    test.emitSession(toolResult('small', [{ type: 'text', text: 'ok' }]))
    await test.projection.finish('done')
    expect(errors).toHaveLength(1)
    expect(written.map(line => (JSON.parse(line) as { callId?: string }).callId ?? 'x')).toEqual(['x', 'small', 'x'])
  })

  it('keeps fullOutput unbounded and inside the line cap', async () => {
    const { store } = await fileStore()
    const test = harness({ maxStringBytes: 16 }, 'session-1', '/', store)
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'x'.repeat(100) }]))
    await test.projection.finish('done')
    const line = test.lines[1]!
    const output = (JSON.parse(line) as { fullOutput: { path: string } }).fullOutput
    expect(output.path.length).toBeGreaterThan(16)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32 * 1024)
  })

  it('keeps callId, status and fullOutput when escapes push the scalars past the line cap', async () => {
    const { store } = await fileStore()
    const test = harness({}, 'session-1', '/', store)
    const text = '\u0001'.repeat(20_000)
    test.emitSession(toolCall('c1', 'bash'))
    test.emitSession(toolResult('c1', [{ type: 'text', text }]))
    await test.projection.finish('done')
    const line = test.lines.find(l => l.includes('tool_result'))!
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32 * 1024)
    const parsed = JSON.parse(line) as { callId: string; status: string; fullOutput: { path: string } }
    expect(parsed).toMatchObject({ type: 'tool_result', callId: 'c1', status: 'completed', truncated: true })
    expect(await readFile(parsed.fullOutput.path, 'utf8')).toBe(text)
  })

  it('keeps fullOutput when structured fields overflow the line cap', () => {
    const line = boundJsonLine({
      type: 'tool_result', result: 'r', error: { a: 'x'.repeat(8000), b: 'x'.repeat(8000), c: 'x'.repeat(8000), d: 'x'.repeat(8000), e: 'x'.repeat(8000) },
      fullOutput: { path: '/p', bytes: 1, sha256: 'ab' },
    })
    expect(JSON.parse(line)).toEqual({
      type: 'tool_result', result: 'r', fullOutput: { path: '/p', bytes: 1, sha256: 'ab' }, truncated: true,
    })
  })
})
