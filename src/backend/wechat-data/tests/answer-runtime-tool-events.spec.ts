/**
 * 工具阶段结构化事件的回归判据。
 *
 * 这里只钉住「前端能收到什么」：同一 callId 的阶段顺序、终态状态、错误分类、
 * 预检失败兜底和 deadline 标记。工具循环的其余行为仍在 tool-loop.spec.ts。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { AskModelTurn, RunChatTurnFn } from '../src/remotes/ask-run-chat.ts'
import {
  ANSWER_PROFILES,
  type RetrievalTool,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from '../src/query/tools/index.ts'
import { runToolLoop } from '../src/query/answer-runtime/tool-loop.ts'
import type { AnswerRuntimeStage } from '../src/query/answer-runtime/types.ts'

const NOW = new Date('2026-10-22T10:00:00')

function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'answer-runtime-test' },
  })
}

function fakeTool(
  name: ToolName,
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult,
): RetrievalTool {
  return {
    name,
    category: name === 'search_kb' ? 'kb' : 'message',
    description: `${name} 测试替身（说明长度足够）`,
    parameters: { type: 'object', properties: {} },
    run,
  }
}

function hitResult(name: ToolName, hits: ToolResult['hits']): ToolResult {
  return { tool: name, ok: true, hits }
}

function turn(input: {
  text?: string
  calls?: Array<{ id: string; name: string; args: unknown }>
  blocks?: ContentBlock[]
}): AskModelTurn {
  const blocks: ContentBlock[] = input.blocks ?? []
  if (input.text) blocks.push({ type: 'text', text: input.text })
  for (const call of input.calls ?? []) {
    blocks.push({
      type: 'tool-call',
      id: ToolCallId(call.id),
      name: call.name,
      arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
    })
  }
  return {
    blocks,
    finish: (input.calls?.length ?? 0) > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    text: input.text ?? '',
    reasoning: '',
  }
}

function loopInput(overrides: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
  return {
    system: '系统提示',
    messages: [userMessage('合同尾款什么时候付？')],
    question: '合同尾款什么时候付？',
    profile: ANSWER_PROFILES['wechat-ask'],
    profileTools: [] as RetrievalTool[],
    toolContext: { decryptedDir: '/fake', now: NOW },
    runTurn: vi.fn() as unknown as RunChatTurnFn,
    now: NOW,
    ...overrides,
  }
}

describe('runToolLoop：结构化工具事件', () => {
  it('工具开始、重试与成功都发结构化事件，同一 callId 先 called 再 retry 再 completed', async () => {
    const stages: AnswerRuntimeStage[] = []
    let calls = 0
    const run = vi.fn(async () => {
      calls += 1
      if (calls === 1) await new Promise(resolve => setTimeout(resolve, 15))
      return hitResult('search_messages', [
        { key: 'wxid_a:structured', name: '项目群', time: '', snippet: '结构化成功', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '完成。' })
      }
      return turn({ calls: [{ id: 'call_stage', name: 'search_messages', args: { keywords: ['尾款'] } }] })
    }) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      emitStage: stage => { stages.push(stage) },
      toolDeadlineMs: 5,
      sleep: async () => undefined,
    }))

    const tool = stages.filter(stage => stage.callId === 'call_stage')
    expect(tool.map(stage => stage.phase)).toEqual(['called', 'retry', 'retry', 'completed'])
    expect(tool[0]).toMatchObject({
      toolName: 'search_messages',
      status: 'running',
      attempt: 1,
      maxAttempts: 1,
      callId: 'call_stage',
      argumentsSummary: expect.stringContaining('keywords'),
    })
    expect(tool[1]).toMatchObject({
      phase: 'retry',
      status: 'running',
      attempt: 1,
      maxAttempts: 2,
      errorClass: 'timeout',
    })
    expect(tool[tool.length - 1]).toMatchObject({
      phase: 'completed',
      status: 'done',
      attempt: 2,
      hits: 1,
      facts: 0,
    })
  })

  it('失败终态使用 failed 而不是 done，并携带错误分类与耗时', async () => {
    const stages: AnswerRuntimeStage[] = []
    const run = vi.fn(() => ({
      tool: 'search_messages',
      ok: false,
      error: '权限不足',
      errorCode: 'upstream_failure',
      hits: [],
    }) as ToolResult)
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '失败后如实说明。' })
      }
      return turn({ calls: [{ id: 'call_failed', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      emitStage: stage => { stages.push(stage) },
    }))

    const terminal = stages.filter(stage => stage.callId === 'call_failed').at(-1)
    expect(terminal).toMatchObject({
      phase: 'failed',
      status: 'failed',
      errorClass: 'unauthorized',
      attempt: 1,
      hits: 0,
    })
    expect(terminal?.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('参数预检失败也发一条 failed 终态，避免前端一直停在调用中', async () => {
    const stages: AnswerRuntimeStage[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '参数不对。' })
      }
      return turn({ calls: [{ id: 'call_bad_stage', name: 'search_messages', args: {} }] })
    }) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', vi.fn())],
      runTurn,
      emitStage: stage => { stages.push(stage) },
    }))

    expect(stages.find(stage => stage.callId === 'call_bad_stage')).toMatchObject({
      phase: 'failed',
      status: 'failed',
      attempt: 0,
      errorClass: 'invalid_arguments',
    })
  })

  it('deadline 超时终态标记 deadlineExceeded，且不能被标成 done', async () => {
    const stages: AnswerRuntimeStage[] = []
    const run = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return hitResult('search_messages', [])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '超时了。' })
      }
      return turn({ calls: [{ id: 'call_timeout_stage', name: 'search_messages', args: { keywords: ['超时'] } }] })
    }) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      emitStage: stage => { stages.push(stage) },
      toolDeadlineMs: 5,
      sleep: async () => undefined,
    }))

    const terminal = stages.filter(stage => stage.callId === 'call_timeout_stage').at(-1)
    expect(terminal).toMatchObject({
      phase: 'failed',
      status: 'failed',
      errorClass: 'timeout',
      deadlineExceeded: true,
    })
  })
})
