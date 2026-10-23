/** Turn preparation stays inside a nested task workspace when parent discovery is denied. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
}

describe('managed turn preparation', () => {
  it('reaches the model with task instructions while parent git, instructions and credentials remain unreadable', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'dsh-managed-prep-'))
    const workspace = join(runtime, 'workspace')
    const home = join(runtime, '.dsh')
    const ctx = new Context()
    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
      await mkdir(workspace)
      await mkdir(home)
      await mkdir(join(runtime, '.git'))
      await writeFile(join(runtime, 'AGENTS.md'), 'synthetic-parent-instruction-must-stay-private')
      await writeFile(join(runtime, '.credentials.yaml'), 'synthetic-provider-secret')
      await writeFile(join(home, 'auth.json'), 'synthetic-auth-secret')
      await writeFile(join(workspace, 'AGENTS.md'), 'synthetic-task-instructions-are-readable')
      vi.stubEnv('DSH_PERMISSION_MODE', 'read-only')
      vi.stubEnv('DSH_HOME', home)
      vi.stubEnv('DSH_AGENTS_HOME', join(runtime, '.agents'))
      vi.stubEnv('PAPERCLIP_DEEPSEEK_READ_ROOTS', JSON.stringify([workspace]))
      vi.stubEnv('PAPERCLIP_DEEPSEEK_PROTECTED_ROOTS', JSON.stringify([home, join(runtime, '.credentials.yaml')]))
      provideWorkingDirectoryFixture(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: workspace })
      await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
      await ctx.plugin(AgentInstructions, { maxBytes: 65536 })
      const loop = await mountAgentLoopTestHarness(ctx)
      const adapter = new MockAdapter([textResponse('synthetic-model-response')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await loop.create(SessionId('managed-parent-preparation'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      const request = adapter.requests[0]!.messages.map(message => textOf(message.content)).join('\n')
      expect(request).toContain('synthetic-task-instructions-are-readable')
      expect(request).not.toMatch(/synthetic-parent-instruction|synthetic-provider-secret|synthetic-auth-secret/)
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
      for (const path of [join(runtime, '.git'), join(runtime, 'AGENTS.md'), join(runtime, '.credentials.yaml'), join(home, 'auth.json')]) {
        const target = await ctx.fs.resolve(path)
        await expect(ctx.fs.stat(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      }
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      await rm(runtime, { recursive: true, force: true })
    }
  })
})
