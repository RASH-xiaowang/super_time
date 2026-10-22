/**
 * P1：LLM 意图分类接线与按缺失数据域补查。
 *
 * 这里全部离线：分类器、工具与模型轮次都可注入，重点钉住「规则优先、模型有界、
 * 缺域只补一个专用工具、三个 profile 不越界」。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AskModelTurn, RunChatTurnFn } from '../src/remotes/ask-run-chat.ts'
import {
  ANSWER_PROFILES,
  type RetrievalTool,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from '../src/query/tools/index.ts'
import { runAnswerRuntime } from '../src/query/answer-runtime/runtime.ts'
import type { AnswerRuntimeStage } from '../src/query/answer-runtime/types.ts'
import { askWithRuntime, type AskRuntimeDeps } from '../src/remotes/ask-runtime.ts'

const NOW = new Date('2026-10-22T10:00:00')

function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'answer-runtime-p1-test' },
  })
}

function turn(input: {
  text?: string
  call?: { id: string; name: ToolName; args: unknown }
}): AskModelTurn {
  const blocks: AskModelTurn['blocks'] = []
  if (input.text) blocks.push({ type: 'text', text: input.text })
  if (input.call) {
    blocks.push({
      type: 'tool-call',
      id: ToolCallId(input.call.id),
      name: input.call.name,
      arguments: JSON.stringify(input.call.args),
    })
  }
  return {
    blocks,
    finish: input.call ? { kind: 'tool-calls' } : { kind: 'stop' },
    text: input.text ?? '',
    reasoning: '',
  }
}

function hasToolResult(input: Parameters<RunChatTurnFn>[0]): boolean {
  return input.messages.some(message => message.content.some(block => block.type === 'tool-result'))
}

function fakeTool(
  name: ToolName,
  run: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult = () => ({
    tool: name,
    ok: true,
    hits: [],
  }),
): RetrievalTool {
  return {
    name,
    category: name === 'search_kb' ? 'kb' : name === 'search_files' ? 'content' : 'message',
    description: `${name} P1 测试替身（说明长度足够）`,
    parameters: { type: 'object', properties: {} },
    run,
  }
}

function messageHit(key: string, snippet = '合同原文'): ToolResult {
  return {
    tool: 'search_messages',
    ok: true,
    hits: [{ key, name: '项目群', time: '2026-10-20 10:00', snippet, source: 'msg' }],
  }
}

function resourceHit(name: Exclude<ToolName, 'search_messages'>): ToolResult {
  const kind = name === 'search_files'
    ? 'file'
    : name === 'search_records'
      ? 'record'
      : name === 'search_favorites'
        ? 'favorite'
        : 'moment'
  return {
    tool: name,
    ok: true,
    hits: [{
      key: `${kind}:1`,
      name: kind === 'file' ? '合同.pdf' : `${kind} 资源`,
      time: '2026-10-20 10:00',
      snippet: `${kind} 命中`,
      source: 'resource',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: kind as 'file' | 'favorite' | 'moment' | 'record',
          stableKey: `${kind}:1`,
        },
      },
    }],
  }
}

function baseInput(overrides: Partial<Parameters<typeof runAnswerRuntime>[0]> = {}) {
  return {
    question: '合同尾款什么时候付？',
    system: '系统提示',
    messages: [userMessage('合同尾款什么时候付？')],
    profile: ANSWER_PROFILES['wechat-ask'],
    profileTools: [] as RetrievalTool[],
    toolContext: { decryptedDir: '/fake', now: NOW },
    runTurn: vi.fn(async () => turn({ text: '暂无结果' })) as unknown as RunChatTurnFn,
    now: NOW,
    ...overrides,
  }
}

function deps(overrides: Partial<AskRuntimeDeps> = {}): AskRuntimeDeps {
  return {
    decryptedDir: '/fake',
    provider: 'test',
    model: 'test-model',
    privacyGate: (_feature, _counts, texts) => texts,
    tools: [],
    now: NOW,
    ...overrides,
  }
}

describe('LLM 意图分类接入运行时', () => {
  it('高置信规则不额外调用分类器', async () => {
    const classifier = vi.fn(() => ({ kind: 'open_qa' as const, confidence: 0.99 }))
    const out = await runAnswerRuntime(baseInput({
      question: '我一共转了多少笔？',
      messages: [userMessage('我一共转了多少笔？')],
      intentClassifier: classifier,
    }))

    expect(classifier).not.toHaveBeenCalled()
    expect(out.intent).toMatchObject({ kind: 'aggregate', classifier: 'rules' })
  })

  it('低置信接受合法建议，并发出 done stage', async () => {
    const stages: AnswerRuntimeStage[] = []
    const classifier = vi.fn(() => ({
      kind: 'lookup' as const,
      confidence: 0.88,
      reason: '模型判断为查找',
      toolHints: ['search_messages'],
    }))
    const out = await runAnswerRuntime(baseInput({
      intentClassifier: classifier,
      emitStage: stage => { stages.push(stage) },
    }))

    expect(classifier).toHaveBeenCalledTimes(1)
    expect(out.intent.kind).toBe('lookup')
    expect(out.intent.classifier).toBe('hybrid')
    expect(stages.find(stage => stage.key === 'classifier:llm_done')).toMatchObject({
      status: 'done',
      detail: 'lookup',
    })
  })

  it('分类器超时回退规则，不拖住整轮问答', async () => {
    const stages: AnswerRuntimeStage[] = []
    const out = await runAnswerRuntime(baseInput({
      intentClassifier: () => new Promise(() => {}),
      intentClassifierDeadlineMs: 10,
      emitStage: stage => { stages.push(stage) },
    }))

    expect(out.intent.kind).toBe('open_qa')
    expect(out.intent.signals).toContain('classifier:llm_timeout')
    expect(stages.find(stage => stage.key === 'classifier:llm_timeout')).toMatchObject({
      status: 'failed',
    })
  })

  it('分类器异常与非法返回分别回退并留下 stage', async () => {
    const failedStages: AnswerRuntimeStage[] = []
    const failed = await runAnswerRuntime(baseInput({
      intentClassifier: () => { throw new Error('offline') },
      emitStage: stage => { failedStages.push(stage) },
    }))
    expect(failed.intent.signals).toContain('classifier:llm_failed')
    expect(failedStages.some(stage => stage.key === 'classifier:llm_failed')).toBe(true)

    const invalidStages: AnswerRuntimeStage[] = []
    const invalid = await runAnswerRuntime(baseInput({
      intentClassifier: () => ({ kind: 'not-an-intent' }),
      emitStage: stage => { invalidStages.push(stage) },
    }))
    expect(invalid.intent.signals).toContain('classifier:llm_invalid')
    expect(invalidStages.some(stage => stage.key === 'classifier:llm_invalid')).toBe(true)
  })

  it('生产 ask-runtime 默认复用 runChat 注入分类器', async () => {
    const runChat = vi.fn(async (system: string) => (
      system.includes('意图分类器')
        ? '{"kind":"lookup","confidence":0.9,"reason":"查找问题"}'
        : '兜底回答'
    ))
    const runTurn = vi.fn(async () => turn({ text: '暂无结果' })) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({ runChat, runTurn }), {
      question: '合同尾款什么时候付？',
      source: 'ask',
    })

    expect(runChat).toHaveBeenCalledTimes(1)
    expect(runChat.mock.calls[0]?.[0]).toContain('意图分类器')
    expect(out.plan?.intent).toBe('lookup')
  })
})

describe('按缺失数据域定向补查', () => {
  it('缺少文件域时补一次 search_files', async () => {
    const searchMessages = vi.fn(() => messageHit('wxid_a:1'))
    const searchFiles = vi.fn(() => resourceHit('search_files'))
    const stages: AnswerRuntimeStage[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成' })
      return turn({ call: { id: 'call_msg', name: 'search_messages', args: { keywords: ['合同'] } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      question: '合同文件里写了什么',
      messages: [userMessage('合同文件里写了什么')],
      profileTools: [fakeTool('search_messages', searchMessages), fakeTool('search_files', searchFiles)],
      runTurn,
      emitStage: stage => { stages.push(stage) },
    }))

    expect(searchFiles).toHaveBeenCalledTimes(1)
    expect(out.toolCalls.find(call => call.name === 'search_files')?.callId)
      .toContain('supplement_')
    expect(out.status).toBe('ok')
    expect(out.resources.some(resource => resource.tool === 'search_files')).toBe(true)
    expect(stages.find(stage =>
      stage.toolName === 'search_files' && stage.phase === 'completed',
    )).toMatchObject({
      status: 'done',
      hits: 1,
      callId: expect.stringContaining('supplement_'),
    })
  })

  it('缺少账单域时补一次 search_records', async () => {
    const searchMessages = vi.fn(() => messageHit('wxid_a:2', '最近聊到转账'))
    const searchRecords = vi.fn(() => resourceHit('search_records'))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成' })
      return turn({ call: { id: 'call_msg', name: 'search_messages', args: { keywords: ['转账'] } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      question: '最近转账账单有哪些',
      messages: [userMessage('最近转账账单有哪些')],
      profileTools: [fakeTool('search_messages', searchMessages), fakeTool('search_records', searchRecords)],
      runTurn,
    }))

    expect(searchRecords).toHaveBeenCalledTimes(1)
    expect(out.toolCalls.some(call => call.name === 'search_records')).toBe(true)
    expect(out.status).toBe('ok')
  })

  it('session-ask 不越界补 search_files', async () => {
    const searchMessages = vi.fn(() => messageHit('wxid_locked:1'))
    const searchFiles = vi.fn(() => resourceHit('search_files'))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成' })
      return turn({ call: { id: 'call_msg', name: 'search_messages', args: { keywords: ['合同'] } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      question: '合同文件里写了什么',
      messages: [userMessage('合同文件里写了什么')],
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', searchMessages), fakeTool('search_files', searchFiles)],
      toolContext: { decryptedDir: '/fake', now: NOW, scope: { username: 'wxid_locked' } },
      runTurn,
    }))

    expect(searchMessages).toHaveBeenCalledTimes(1)
    expect(searchFiles).not.toHaveBeenCalled()
    expect(out.toolCalls.some(call => call.name === 'search_files')).toBe(false)
  })

  it('clawbot-auto 保持 kb-only，不补 search_files', async () => {
    const searchKb = vi.fn(() => ({
      tool: 'search_kb' as const,
      ok: true,
      hits: [{
        key: 'kb:7:1',
        name: '合同.pdf',
        time: '',
        snippet: '知识库里的合同内容',
        source: 'kb' as const,
        trace: { kind: 'kb' as const, kbId: 7, fileId: 1, chunkId: 1, ordinal: 0, page: 0, heading: '' },
      }],
    }))
    const searchFiles = vi.fn(() => resourceHit('search_files'))
    const schemas: string[][] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      schemas.push((input.tools ?? []).map(schema => schema.name))
      if (hasToolResult(input)) return turn({ text: '检索完成' })
      return turn({ call: { id: 'call_kb', name: 'search_kb', args: { query: '合同' } } })
    }) as unknown as RunChatTurnFn

    await runAnswerRuntime(baseInput({
      question: '合同文件里写了什么',
      messages: [userMessage('合同文件里写了什么')],
      profile: ANSWER_PROFILES['clawbot-auto'],
      profileTools: [fakeTool('search_kb', searchKb), fakeTool('search_files', searchFiles)],
      toolContext: { decryptedDir: '/fake', kbId: 7, now: NOW },
      runTurn,
    }))

    expect(schemas[0]).toEqual(['search_kb'])
    expect(searchKb).toHaveBeenCalledTimes(1)
    expect(searchFiles).not.toHaveBeenCalled()
  })
})
