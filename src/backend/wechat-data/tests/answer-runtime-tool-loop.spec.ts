/**
 * 工具循环的核心行为（纯内存，不联网、不读库）。
 *
 * 这里钉住最容易「接上了但实际没生效」的接缝：参数修复、范围守卫、
 * 重试边界、缓存去重、reasoning 不回放，以及轮次/调用数上限。
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

function callIds(messages: readonly Message[]): string[] {
  return messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'tool-result')
    .map(block => String(block.toolCallId))
}

describe('runToolLoop：工具调用与结果回放', () => {
  it('一轮 tool-call → tool-result → 二轮文本，callId 对齐且 reasoning 不回放', async () => {
    const run = vi.fn(() => hitResult('search_messages', [
      { key: 'wxid_a:11', name: '项目群', time: '2026-10-20 10:00', snippet: '尾款下周付', source: 'msg' },
    ]))
    const seen: Message[][] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      seen.push([...input.messages])
      if (seen.length === 1) {
        return turn({
          calls: [{ id: 'call_1', name: 'search_messages', args: { keywords: ['尾款'] } }],
          blocks: [{ type: 'reasoning', text: '先查尾款' }],
        })
      }
      return turn({ text: '下周一付。' })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
    }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.rounds).toBe(2)
    expect(out.finalText).toBe('下周一付。')
    expect(out.toolResults).toHaveLength(1)
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]).toMatchObject({
      name: 'search_messages',
      ok: true,
      attempts: 1,
      retries: 0,
      hits: 1,
    })
    // 第二次模型调用看到 assistant 与 tool-result。
    const second = seen[1] ?? []
    const assistant = second.find(message => message.role === 'assistant')
    expect(assistant?.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(callIds(second)).toEqual(['call_1'])
    const toolResult = second
      .flatMap(message => message.content)
      .find(block => block.type === 'tool-result')
    expect(toolResult?.type === 'tool-result' ? toolResult.isError : true).toBe(false)
  })

  it('参数修复后再执行；相同规范化参数只执行一次', async () => {
    const run = vi.fn((args: Record<string, unknown>) => {
      // 修复应把单字符串关键词归一成数组，并把 limit 数字字符串转成数字。
      expect(Array.isArray(args['keywords'])).toBe(true)
      expect(args['limit']).toBe(8)
      return hitResult('search_messages', [
        { key: 'wxid_a:12', name: '项目群', time: '2026-10-20 11:00', snippet: '合同', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '查到了。' })
      }
      const args = { keywords: '合同', limit: '8' }
      return turn({
        calls: [
          { id: 'call_a', name: 'search_messages', args },
          { id: 'call_b', name: 'search_messages', args },
        ],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
    }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls).toHaveLength(2)
    expect(out.toolCalls[0]?.deduplicated).toBe(false)
    expect(out.toolCalls[1]?.deduplicated).toBe(true)
    expect(out.toolResults).toHaveLength(1)
    expect(out.cachedResults).toHaveLength(1)
  })
})

describe('runToolLoop：会话锁定的必填参数注入', () => {
  const sessionLoop = (overrides: Partial<Parameters<typeof runToolLoop>[0]>) => loopInput({
    profile: ANSWER_PROFILES['session-ask'],
    toolContext: { decryptedDir: '/fake', scope: { username: '123@chatroom' } },
    ...overrides,
  })

  it('模型漏填 group 时在 schema 必填校验前注入当前群', async () => {
    const group = vi.fn((_args: Record<string, unknown>) => hitResult('get_group_detail', []))
    let first = true
    const runTurn = vi.fn(async () => {
      if (first) {
        first = false
        return turn({ calls: [{ id: 'call_group', name: 'get_group_detail', args: {} }] })
      }
      return turn({ text: '完成了。' })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(sessionLoop({
      profileTools: [fakeTool('get_group_detail', group)],
      runTurn,
    }))

    expect(group).toHaveBeenCalledTimes(1)
    expect(group.mock.calls[0]?.[0]).toMatchObject({ group: '123@chatroom' })
    expect(out.toolCalls[0]?.ok).toBe(true)
  })

  it('模型显式填了别的群时不被静默改写，交给范围守卫拒绝', async () => {
    const group = vi.fn((_args: Record<string, unknown>) => hitResult('get_group_detail', []))
    let first = true
    const runTurn = vi.fn(async () => {
      if (first) {
        first = false
        return turn({
          calls: [{ id: 'call_group', name: 'get_group_detail', args: { group: 'other@chatroom' } }],
        })
      }
      return turn({ text: '完成了。' })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(sessionLoop({
      profileTools: [fakeTool('get_group_detail', group)],
      runTurn,
    }))

    expect(group).not.toHaveBeenCalled()
    expect(out.toolCalls[0]?.ok).toBe(false)
    // 可能是范围守卫的 scope_violation，也可能是参数归一化先判定群标识不可用；
    // 两种都必须「不执行」，不能被静默改写成当前群。
    expect(out.toolCalls[0]?.errorClass).not.toBeUndefined()
  })

  it('通话工具的 peer 与群资料一样在必填校验前注入当前会话', async () => {
    const calls = vi.fn((_args: Record<string, unknown>) => ({
      tool: 'get_call_history' as const,
      ok: true,
      hits: [],
      facts: [],
    }))
    let first = true
    const runTurn = vi.fn(async () => {
      if (first) {
        first = false
        return turn({ calls: [{ id: 'call_calls', name: 'get_call_history', args: {} }] })
      }
      return turn({ text: '完成了。' })
    }) as unknown as RunChatTurnFn

    await runToolLoop(sessionLoop({
      // 通话只存在于一对一会话；群聊锁定会明确报 unsupported_scope。
      toolContext: { decryptedDir: '/fake', scope: { username: 'wxid_a' } },
      profileTools: [fakeTool('get_call_history', calls)],
      runTurn,
    }))

    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls.mock.calls[0]?.[0]).toMatchObject({ peer: 'wxid_a' })
  })
})

describe('runToolLoop：模型轮次截止与错误回放', () => {
  it('模型轮次超过 deadline 会 abort 请求并抛出稳定 model_timeout', async () => {
    let aborted = false
    let lateDeltaCalls = 0
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      input.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      await new Promise(resolve => setTimeout(resolve, 40))
      // 截止后供应商的晚到增量不能再推给界面。
      input.onDelta?.('晚到内容')
      return turn({ text: '晚到内容' })
    }) as unknown as RunChatTurnFn

    const error = await runToolLoop(loopInput({
      runTurn,
      modelDeadlineMs: 10,
      onDelta: () => { lateDeltaCalls += 1 },
    })).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toMatchObject({ code: 'model_timeout', category: 'timeout' })
    expect(aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(lateDeltaCalls).toBe(0)
    expect(runTurn).toHaveBeenCalledTimes(1)
  })

  it('失败结果只回放白名单内的 errorDetails，不泄漏正文或密钥', async () => {
    const run = vi.fn(() => ({
      tool: 'search_files' as const,
      ok: false,
      error: '参数不完整',
      errorCode: 'invalid_arguments' as const,
      errorDetails: {
        field: 'limit',
        allowed: ['10', '20'],
        query: '这段正文不该回放',
        token: 'secret-token',
      },
      hits: [],
    }))
    let replayed = ''
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      const toolResult = input.messages
        .flatMap(message => message.content)
        .find(block => block.type === 'tool-result')
      if (toolResult?.type === 'tool-result') {
        const nested = toolResult.content.find(block => block.type === 'text')
        replayed = nested?.type === 'text' ? nested.text : ''
        return turn({ text: '参数已纠正。' })
      }
      return turn({ calls: [{ id: 'call_details', name: 'search_files', args: { query: '合同' } }] })
    }) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      profileTools: [fakeTool('search_files', run)],
      runTurn,
    }))

    expect(JSON.parse(replayed)).toMatchObject({
      errorCode: 'invalid_arguments',
      errorDetails: { field: 'limit', allowed: ['10', '20'] },
    })
    expect(replayed).not.toContain('这段正文不该回放')
    expect(replayed).not.toContain('secret-token')
  })

  it('profile 标记为副作用的工具即使瞬时失败也不自动重试', async () => {
    let calls = 0
    const run = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return {
          tool: 'search_files' as const,
          ok: false,
          error: 'database is locked',
          errorCode: 'upstream_failure' as const,
          hits: [],
        }
      }
      return hitResult('search_files', [])
    })
    const profile = {
      ...ANSWER_PROFILES['wechat-ask'],
      sideEffectTools: ['search_files' as ToolName],
    }
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '停止重试。' })
      }
      return turn({ calls: [{ id: 'call_side', name: 'search_files', args: { query: '合同' } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profile,
      profileTools: [fakeTool('search_files', run)],
      runTurn,
      sleep: async () => undefined,
    }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      attempts: 1,
      retries: 0,
    })
  })
})

describe('runToolLoop：失败、重试与边界', () => {
  it('失败结果按 name+args 缓存，后续同参调用不再重试', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages',
      ok: false,
      error: '权限不足',
      errorCode: 'upstream_failure',
      hits: [],
    }) as ToolResult)
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '本轮先不再重查。' })
      }
      const args = { keywords: ['合同'] }
      return turn({
        calls: [
          { id: 'call_fail', name: 'search_messages', args },
          { id: 'call_retry', name: 'search_messages', args },
        ],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
    }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls).toHaveLength(2)
    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      errorMessage: '权限不足',
      deduplicated: false,
    })
    expect(out.toolCalls[1]).toMatchObject({
      ok: false,
      errorCode: 'upstream_failure',
      deduplicated: true,
    })
    // 失败结果也进入本轮缓存，供后续轮次继续复用。
    expect(out.cachedResults).toHaveLength(1)
    expect(out.cachedResults[0]?.result.ok).toBe(false)
  })

  it('超时失败同样缓存：同一轮不会因模型重放而再跑一次大扫描', async () => {
    const run = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return hitResult('search_messages', [])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '超时后停止。' })
      }
      const args = { keywords: ['合同'] }
      return turn({
        calls: [
          { id: 'call_timeout', name: 'search_messages', args },
          { id: 'call_timeout_replay', name: 'search_messages', args },
        ],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      toolDeadlineMs: 10,
    }))

    // 第一次调用的内部重试（2 次尝试）后结果被缓存；第二次同参调用直接复用，
    // 不再发起第三次/第四次执行。
    expect(run).toHaveBeenCalledTimes(2)
    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      errorClass: 'timeout',
      attempts: 2,
      deduplicated: false,
    })
    expect(out.toolCalls[1]).toMatchObject({
      ok: false,
      errorClass: 'timeout',
      deduplicated: true,
    })
    expect(out.cachedResults).toHaveLength(1)
  })

  it('timeout 有界重试一次（总尝试 2 次）', async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      return hitResult('search_messages', [
        { key: 'wxid_a:13', name: '项目群', time: '', snippet: '重试成功', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '完成。' })
      }
      return turn({ calls: [{ id: 'call_t', name: 'search_messages', args: { keywords: ['尾款'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      toolDeadlineMs: 5,
      sleep: async () => undefined,
    }))

    expect(run).toHaveBeenCalledTimes(2)
    expect(out.toolCalls[0]).toMatchObject({ ok: true, attempts: 2, retries: 1 })
    expect(out.toolResults).toHaveLength(1)
  })

  it('单次 deadline 会把取消信号传进工具上下文', async () => {
    const signals: Array<AbortSignal | undefined> = []
    let calls = 0
    const run = vi.fn(async (_args: Record<string, unknown>, ctx: { signal?: AbortSignal }) => {
      calls += 1
      signals.push(ctx.signal)
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
          setTimeout(resolve, 50)
        })
      }
      return hitResult('search_messages', [
        { key: 'wxid_a:signal', name: '项目群', time: '', snippet: '取消后重试成功', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '完成。' })
      }
      return turn({ calls: [{ id: 'call_signal', name: 'search_messages', args: { keywords: ['信号'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      toolDeadlineMs: 5,
      sleep: async () => undefined,
    }))

    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]?.aborted).toBe(true)
    expect(out.toolCalls[0]).toMatchObject({ ok: true, attempts: 2 })
  })

  it('transient 连续失败两次后第三次成功（总尝试 3 次）', async () => {
    let calls = 0
    const run = vi.fn(() => {
      calls += 1
      if (calls < 3) {
        return { tool: 'search_messages', ok: false, error: 'database is locked', hits: [] } as ToolResult
      }
      return hitResult('search_messages', [
        { key: 'wxid_a:transient', name: '项目群', time: '', snippet: '第三次成功', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '完成。' })
      }
      return turn({ calls: [{ id: 'call_transient', name: 'search_messages', args: { keywords: ['尾款'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      sleep: async () => undefined,
    }))

    expect(run).toHaveBeenCalledTimes(3)
    expect(out.toolCalls[0]).toMatchObject({ ok: true, attempts: 3, retries: 2 })
  })

  it('限流时采用 errorDetails 的 retryAfterMs，但有上限', async () => {
    let calls = 0
    const delays: number[] = []
    const run = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return {
          tool: 'search_messages',
          ok: false,
          error: 'too many requests',
          errorCode: 'upstream_failure',
          errorDetails: { retryAfterMs: 1500 },
          hits: [],
        } as ToolResult
      }
      return hitResult('search_messages', [])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '完成。' })
      }
      return turn({ calls: [{ id: 'call_limited', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      sleep: async (ms) => { delays.push(ms) },
    }))

    expect(delays).toEqual([1500])
    expect(out.toolCalls[0]).toMatchObject({ ok: true, attempts: 2 })
  })

  it('取消发生在重试退避期间时立即唤醒，且不再发起下一次工具调用', async () => {
    const controller = new AbortController()
    let calls = 0
    let releaseSleep: (() => void) | undefined
    let signalSleepStarted: (() => void) | undefined
    const sleepStarted = new Promise<void>((resolve) => { signalSleepStarted = resolve })
    const run = vi.fn(async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 25))
      return hitResult('search_messages', [])
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '不会走到这里。' })
      }
      return turn({ calls: [{ id: 'call_cancel', name: 'search_messages', args: { keywords: ['尾款'] } }] })
    }) as unknown as RunChatTurnFn

    const running = runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      toolDeadlineMs: 5,
      cancelSignal: controller.signal,
      throwIfCanceled: () => {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
        }
      },
      // 故意忽略 signal，证明工具循环自身会把等待竞速唤醒。
      sleep: async () => {
        signalSleepStarted?.()
        await new Promise<void>((resolve) => { releaseSleep = resolve })
      },
    }))

    await sleepStarted
    const startedAt = Date.now()
    controller.abort()
    const outcome = await Promise.race([
      running.then(() => 'resolved', (error: unknown) => error),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1000)),
    ])
    releaseSleep?.()

    expect(outcome, '取消必须唤醒退避等待，而不是等 sleep 自然结束').not.toBe('timeout')
    expect(outcome).toMatchObject({ code: 'ASK_CANCELED' })
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
    expect(runTurn).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('会话内自定义工具漏填 username 时自动补当前会话', async () => {
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args['username']).toBe('room_locked')
      return hitResult('get_session_messages' as ToolName, [])
    })
    const custom = {
      ...fakeTool('get_session_messages' as ToolName, run),
      name: 'custom_session_tool' as ToolName,
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['username'],
      },
    }
    const profile = {
      ...ANSWER_PROFILES['session-ask'],
      allowedTools: ['custom_session_tool' as ToolName],
    }
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '查到了。' })
      }
      return turn({ calls: [{ id: 'call_custom', name: 'custom_session_tool', args: { limit: 10 } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profile,
      profileTools: [custom],
      toolContext: { decryptedDir: '/fake', now: NOW, scope: { username: 'room_locked' } },
      runTurn,
    }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls[0]).toMatchObject({ ok: true, attempts: 1 })
  })

  it('首轮无工具调用时执行问题对应的资源专用工具', async () => {
    const files = vi.fn(() => hitResult('search_files', [
      { key: 'file:1', name: '合同.pdf', time: '', snippet: '验收款', source: 'msg' },
    ]))
    const hybrid = vi.fn(() => hitResult('search_hybrid', []))
    const runTurn = vi.fn(async () => turn({ text: '我看看。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '帮我找一下合同文件',
      profileTools: [
        fakeTool('search_files', files),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['search_files'],
      runTurn,
    }))

    expect(files).toHaveBeenCalledTimes(1)
    expect(hybrid).not.toHaveBeenCalled()
    expect(out.fallbackUsed).toBe(true)
    expect(out.toolCalls[0]?.name).toBe('search_files')
  })

  it('聚合兜底排在检索之后，避免 0 条统计抢占可引用原文', async () => {
    const calls: string[] = []
    const aggregate = vi.fn(() => {
      calls.push('aggregate')
      return {
        tool: 'aggregate_messages' as ToolName,
        ok: true,
        hits: [],
        facts: [{ title: '按关键词统计消息条数', body: '含「转账」：0 条' }],
      }
    })
    const hybrid = vi.fn(() => {
      calls.push('hybrid')
      return hitResult('search_hybrid', [])
    })
    const runTurn = vi.fn(async () => turn({ text: '我看看。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '最近一次转账是多少',
      profileTools: [
        fakeTool('aggregate_messages', aggregate),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['aggregate_messages'],
      runTurn,
    }))

    expect(calls).toEqual(['hybrid', 'aggregate'])
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['search_hybrid', 'aggregate_messages'])
  })

  it('兜底跳过缺必填参数的工具，且不占用调用预算', async () => {
    const group = vi.fn(() => hitResult('get_group_detail', []))
    const message = vi.fn(() => hitResult('search_messages', [
      { key: 'wxid_a:skip-budget', name: '项目群', time: '', snippet: '合同已确认', source: 'msg' },
    ]))
    const runTurn = vi.fn(async () => turn({ text: '我看看。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '合同',
      profileTools: [
        fakeTool('get_group_detail', group),
        fakeTool('search_messages', message),
      ],
      // get_group_detail 没有 group 参数时不能猜；它不该吃掉后面 search_messages 的名额。
      fallbackTools: ['get_group_detail', 'search_messages'],
      runTurn,
    }))

    expect(group).not.toHaveBeenCalled()
    expect(message).toHaveBeenCalledTimes(1)
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['search_messages'])
  })

  it('专用工具占满预算时仍给泛化检索留一个位置', async () => {
    const funds = vi.fn((): ToolResult => ({
      tool: 'get_funds_summary',
      ok: false,
      errorCode: 'not_configured',
      hits: [],
    }))
    const records = vi.fn(() => hitResult('search_records', []))
    const hybrid = vi.fn(() => hitResult('search_hybrid', [
      { key: 'wxid_a:reserve-hybrid', name: '项目群', time: '', snippet: '收到转账 13.00 元', source: 'msg' },
    ]))
    const runTurn = vi.fn(async () => turn({ text: '我看看。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '最近一次转账是多少',
      profileTools: [
        fakeTool('get_funds_summary', funds),
        fakeTool('search_records', records),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['get_funds_summary', 'search_records', 'search_hybrid'],
      maxFallbackCalls: 2,
      runTurn,
    }))

    // 专用工具失败后必须轮到 hybrid，而不是把两个名额都花在专用工具上。
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['get_funds_summary', 'search_hybrid'])
    expect(hybrid).toHaveBeenCalledTimes(1)
  })

  it('fallback 使用 extractAskTerms 提词，不把整句问题当查询词', async () => {
    const question = '蓝鲸合同验收款文件 帮我看下'
    const message = vi.fn((args: Record<string, unknown>) => {
      const keywords = args['keywords']
      expect(Array.isArray(keywords)).toBe(true)
      const terms = keywords as string[]
      expect(terms.length).toBeGreaterThan(0)
      expect(terms.length).toBeLessThanOrEqual(4)
      expect(terms).not.toContain(question)
      expect(terms.every(term => term.length >= 2)).toBe(true)
      return hitResult('search_messages', [])
    })
    const files = vi.fn((args: Record<string, unknown>) => {
      const query = String(args['query'] ?? '')
      expect(query).not.toBe(question)
      expect(query).not.toContain('帮我看下')
      expect(query.split(/\s+/).length).toBeLessThanOrEqual(4)
      return hitResult('search_files', [])
    })
    const runTurn = vi.fn(async () => turn({ text: '我先看看。' })) as unknown as RunChatTurnFn

    await runToolLoop(loopInput({
      question,
      profileTools: [
        fakeTool('search_messages', message),
        fakeTool('search_files', files),
      ],
      fallbackTools: ['search_messages', 'search_files'],
      runTurn,
    }))

    expect(message).toHaveBeenCalledTimes(1)
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('fallback 剥离「最近一次」这类排序词，不为它挤掉真正的内容词', async () => {
    const message = vi.fn((args: Record<string, unknown>) => {
      const keywords = args['keywords'] as string[]
      expect(keywords).toContain('转账')
      expect(keywords).not.toContain('最近')
      expect(keywords).not.toContain('一次')
      return hitResult('search_messages', [
        { key: 'wxid_a:recency-term', name: '王五', time: '', snippet: '收到转账 13.00 元', source: 'msg' },
      ])
    })
    const runTurn = vi.fn(async () => turn({ text: '我看看。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '最近一次转账是多少',
      profileTools: [fakeTool('search_messages', message)],
      fallbackTools: ['search_messages'],
      runTurn,
    }))

    expect(message).toHaveBeenCalledTimes(1)
    expect(out.toolResults[0]?.hits).toHaveLength(1)
  })

  it('锁定会话时兜底不发起 search_files；只有日期锁定时仍可兜底', async () => {
    const files = vi.fn((_args: Record<string, unknown>) => hitResult('search_files', []))
    const textTurn = vi.fn(async () => turn({ text: '没有可用的文件检索。' })) as unknown as RunChatTurnFn

    const locked = await runToolLoop(loopInput({
      question: '合同文件里写了什么',
      profileTools: [fakeTool('search_files', files)],
      fallbackTools: ['search_files'],
      toolContext: { decryptedDir: '/fake', scope: { username: 'wxid_locked' } },
      runTurn: textTurn,
    }))
    expect(files).not.toHaveBeenCalled()
    expect(locked.fallbackUsed).toBe(false)
    expect(locked.toolCalls).toEqual([])

    const dateOnly = await runToolLoop(loopInput({
      question: '合同文件里写了什么',
      profileTools: [fakeTool('search_files', files)],
      fallbackTools: ['search_files'],
      toolContext: { decryptedDir: '/fake', scope: { from: '2026-10-01', to: '2026-10-07' } },
      runTurn: textTurn,
    }))
    expect(files).toHaveBeenCalledTimes(1)
    expect(files.mock.calls[0]?.[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-07' })
    expect(dateOnly.fallbackUsed).toBe(true)
  })

  it('首轮失败后模型停止时只补查一次，跳过同一失败调用', async () => {
    const message = vi.fn(() => ({
      tool: 'search_messages',
      ok: false,
      error: '权限不足',
      errorCode: 'upstream_failure',
      hits: [],
    }) as ToolResult)
    const hybrid = vi.fn(() => hitResult('search_hybrid', [
      { key: 'wxid_a:supplement', name: '项目群', time: '', snippet: '补查拿到原文', source: 'msg' },
    ]))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '我查到了。' })
      }
      return turn({ calls: [{ id: 'call_miss', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '合同',
      profileTools: [
        fakeTool('search_messages', message),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['search_messages'],
      runTurn,
    }))

    expect(message).toHaveBeenCalledTimes(1)
    expect(hybrid).toHaveBeenCalledTimes(1)
    expect(out.fallbackUsed).toBe(true)
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['search_messages', 'search_hybrid'])
    expect(out.toolResults).toHaveLength(2)
    expect(out.stopReason).toBe('no-tool-call')
  })

  it('首轮零命中后模型停止时触发一次补查', async () => {
    const message = vi.fn(() => hitResult('search_messages', []))
    const hybrid = vi.fn(() => hitResult('search_hybrid', [
      { key: 'wxid_a:zero-supplement', name: '项目群', time: '', snippet: '补查命中', source: 'msg' },
    ]))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '找到了。' })
      }
      return turn({ calls: [{ id: 'call_zero', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '合同',
      profileTools: [
        fakeTool('search_messages', message),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['search_messages'],
      runTurn,
    }))

    expect(message).toHaveBeenCalledTimes(1)
    expect(hybrid).toHaveBeenCalledTimes(1)
    expect(out.fallbackUsed).toBe(true)
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['search_messages', 'search_hybrid'])
  })

  it('已有可引用命中时尊重模型停止，不额外补查', async () => {
    const message = vi.fn(() => hitResult('search_messages', [
      { key: 'wxid_a:has-evidence', name: '项目群', time: '', snippet: '合同已经确认', source: 'msg' },
    ]))
    const hybrid = vi.fn(() => hitResult('search_hybrid', []))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '合同已经确认。' })
      }
      return turn({ calls: [{ id: 'call_hit', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '合同',
      profileTools: [
        fakeTool('search_messages', message),
        fakeTool('search_hybrid', hybrid),
      ],
      fallbackTools: ['search_messages'],
      runTurn,
    }))

    expect(hybrid).not.toHaveBeenCalled()
    expect(out.fallbackUsed).toBe(false)
  })

  it('invalid_arguments 不重试，结构化结果回给模型', async () => {
    const run = vi.fn(() => hitResult('search_messages', []))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '参数不对，请补关键词。' })
      }
      return turn({ calls: [{ id: 'call_bad', name: 'search_messages', args: {} }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
    }))

    expect(run).not.toHaveBeenCalled()
    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      errorClass: 'invalid_arguments',
      attempts: 0,
    })
    expect(out.toolResults[0]?.errorCode).toBe('invalid_arguments')
    expect(out.rounds).toBe(2)
  })

  it('未知工具返回结构化 unknown_tool，不抛错', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '没有这个工具。' })
      }
      return turn({ calls: [{ id: 'call_unknown', name: 'not_a_tool', args: {} }] })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({ runTurn }))

    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      errorCode: 'unknown_tool',
      attempts: 0,
    })
    expect(out.toolResults[0]?.errorCode).toBe('unknown_tool')
    expect(out.rounds).toBe(2)
  })

  it('session profile 拒绝跨会话 username', async () => {
    const run = vi.fn(() => hitResult('search_messages', []))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '不能查别的会话。' })
      }
      return turn({
        calls: [{
          id: 'call_scope',
          name: 'search_messages',
          args: { keywords: ['合同'], username: 'wxid_other' },
        }],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', run)],
      toolContext: { decryptedDir: '/fake', now: NOW, scope: { username: 'wxid_locked' } },
      runTurn,
      fallbackTools: ['search_messages'],
    }))

    expect(run).not.toHaveBeenCalled()
    expect(out.fallbackUsed).toBe(false)
    expect(out.toolCalls[0]).toMatchObject({
      ok: false,
      errorClass: 'scope_blocked',
      errorCode: 'scope_violation',
    })
  })

  it('第二轮全部命中缓存时确定性停止，不再多问一次模型', async () => {
    let round = 0
    const runTurn = vi.fn(async () => {
      round += 1
      const calls = Array.from({ length: 8 }, (_, i) => ({
        id: `call_${String(round)}_${String(i)}`,
        name: 'search_messages',
        args: { keywords: [`词${String(i)}`] },
      }))
      return turn({ calls })
    }) as unknown as RunChatTurnFn
    const run = vi.fn(() => hitResult('search_messages', []))

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      maxRounds: 2,
      maxCallsPerRound: 2,
    }))

    expect(runTurn).toHaveBeenCalledTimes(2)
    // 第二轮的前两个调用与第一轮参数相同 ⇒ 命中缓存，不再执行。
    expect(run).toHaveBeenCalledTimes(2)
    expect(out.toolCalls.filter(trace => trace.deduplicated)).toHaveLength(2)
    expect(out.toolCalls.filter(trace => trace.skipped)).toHaveLength(12)
    expect(out.toolCalls.filter(trace => !trace.skipped)).toHaveLength(4)
    expect(out.exhausted).toBe(false)
    expect(out.stopReason).toBe('deduplicated')
  })

  it('每轮都有新参数时仍受 maxRounds 硬上限', async () => {
    let round = 0
    const runTurn = vi.fn(async () => {
      round += 1
      return turn({
        calls: [{
          id: `call_round_${String(round)}`,
          name: 'search_messages',
          args: { keywords: [`第${String(round)}轮`] },
        }],
      })
    }) as unknown as RunChatTurnFn
    const run = vi.fn(() => hitResult('search_messages', []))

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      maxRounds: 2,
    }))

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(out.exhausted).toBe(true)
    expect(out.stopReason).toBe('max-rounds')
  })

  it('首轮既无文本也无工具调用时回退 search_hybrid 一次', async () => {
    const hybrid = vi.fn(() => hitResult('search_hybrid', [
      { key: 'wxid_a:14', name: '项目群', time: '', snippet: '兜底命中', source: 'msg' },
    ]))
    const runTurn = vi.fn(async () => turn({})) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_hybrid', hybrid)],
      runTurn,
    }))

    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(hybrid).toHaveBeenCalledTimes(1)
    expect(out.fallbackUsed).toBe(true)
    expect(out.toolResults).toHaveLength(1)
    expect(out.stopReason).toBe('no-output')
  })

  it('首轮只说了话、没调工具时仍然回退检索，并标记 no-tool-call', async () => {
    const hybrid = vi.fn(() => hitResult('search_hybrid', [
      { key: 'wxid_a:15', name: '项目群', time: '', snippet: '兜底命中', source: 'msg' },
    ]))
    const runTurn = vi.fn(async () => turn({ text: '我先直接回答。' })) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      profileTools: [fakeTool('search_hybrid', hybrid)],
      runTurn,
    }))

    expect(hybrid).toHaveBeenCalledTimes(1)
    expect(out.fallbackUsed).toBe(true)
    expect(out.toolResults).toHaveLength(1)
    expect(out.stopReason).toBe('no-tool-call')
  })

  it('有知识库时 hybrid 只召回消息也会继续补搜 search_kb', async () => {
    const calls: string[] = []
    const hybrid = vi.fn(() => {
      calls.push('hybrid')
      return hitResult('search_hybrid', [
        { key: 'wxid_a:1', name: '李四', time: '2026-10-20 10:00', snippet: '合同附件发你了', source: 'msg' },
      ])
    })
    const kb = vi.fn(() => {
      calls.push('kb')
      return hitResult('search_kb', [
        {
          key: 'kb:7:99',
          name: '合同.pdf',
          time: '',
          snippet: '验收款 30%',
          source: 'kb',
          trace: { kind: 'kb', kbId: 7, fileId: 3, chunkId: 99 },
        },
      ])
    })
    const runTurn = vi.fn(async () => turn({})) as unknown as RunChatTurnFn

    const out = await runToolLoop(loopInput({
      question: '蓝鲸合同第七附则里的验收款是多少',
      profileTools: [fakeTool('search_hybrid', hybrid), fakeTool('search_kb', kb)],
      toolContext: { decryptedDir: '/fake', kbId: 7, now: NOW },
      runTurn,
    }))

    expect(calls).toEqual(['hybrid', 'kb'])
    // 知识库兜底使用短词而不是整句：FTS 把整句当连续短语时通常 0 命中。
    expect(kb).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.not.stringContaining('是多少') }),
      expect.anything(),
    )
    expect(out.toolCalls.map(trace => trace.name)).toEqual(['search_hybrid', 'search_kb'])
  })
})
