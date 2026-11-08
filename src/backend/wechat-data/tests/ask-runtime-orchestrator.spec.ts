/**
 * 生产编排层：profile 选择、边界、澄清、重试、引用映射与兜底。
 *
 * 全部离线：runTurn / runChat / privacyGate / 工具都可注入，不读数据库。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { AskModelTurn, RunChatFn, RunChatTurnFn } from '../src/remotes/ask-run-chat.ts'
import type { RetrievalTool, ToolContext, ToolName, ToolResult } from '../src/query/tools/index.ts'
import type { AnswerRuntimeStage } from '../src/query/answer-runtime/types.ts'
import { askWithRuntime, type AskRuntimeDeps } from '../src/remotes/ask-runtime.ts'
import { createAskReasoningCollector } from '../src/remotes/ask-runtime-reasoning.ts'

const NOW = new Date('2026-10-22T10:00:00')

function fakeTool(
  name: ToolName,
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult = () => ({
    tool: name,
    ok: true,
    hits: [],
  }),
): RetrievalTool {
  return {
    name,
    category: name === 'search_kb' ? 'kb' : 'message',
    description: `${name} 测试替身（说明长度足够）`,
    parameters: { type: 'object', properties: {} },
    run,
  }
}

function turn(input: {
  text?: string
  calls?: Array<{ id: string; name: string; args: unknown }>
}): AskModelTurn {
  const blocks: ContentBlock[] = []
  if (input.text) blocks.push({ type: 'text', text: input.text })
  for (const call of input.calls ?? []) {
    blocks.push({
      type: 'tool-call',
      id: ToolCallId(call.id),
      name: call.name,
      arguments: JSON.stringify(call.args),
    })
  }
  return {
    blocks,
    finish: (input.calls?.length ?? 0) > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    text: input.text ?? '',
    reasoning: '',
  }
}

function hasToolResult(input: Parameters<RunChatTurnFn>[0]): boolean {
  return input.messages.some(message => message.content.some(block => block.type === 'tool-result'))
}

function deps(overrides: Partial<AskRuntimeDeps> = {}): AskRuntimeDeps {
  return {
    decryptedDir: '/fake',
    provider: 'test',
    model: 'test-model',
    privacyGate: (_feature, _counts, texts) => texts,
    tools: [],
    runChat: async () => '查到了。',
    now: NOW,
    ...overrides,
  }
}

describe('askWithRuntime：profile 与工具边界', () => {
  it('两个入口选择正确 profile，且只把白名单工具交给模型', async () => {
    const toolNames: ToolName[] = [
      'search_messages',
      'search_semantic',
      'search_hybrid',
      'aggregate_messages',
      'get_session_messages',
      'get_message_context',
      'search_kb',
      'search_files',
      'list_sessions',
    ]
    const tools = toolNames.map(name => fakeTool(name))
    const schemas: string[][] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      schemas.push((input.tools ?? []).map(schema => schema.name))
      return turn({ text: '没有检索到。' })
    }) as unknown as RunChatTurnFn

    await askWithRuntime(deps({ tools, runTurn }), { question: '合同尾款', source: 'ask' })
    await askWithRuntime(deps({ tools, runTurn }), {
      question: '合同尾款',
      source: 'session',
      username: 'wxid_locked',
    })
    expect(schemas[0]).toEqual(expect.arrayContaining(['search_messages', 'search_files', 'search_kb']))
    expect(schemas[1]?.sort()).toEqual([
      'aggregate_messages',
      'get_message_context',
      'get_session_messages',
      'search_hybrid',
      'search_messages',
      'search_semantic',
    ].sort())
    expect(schemas[1]).not.toContain('search_kb')
    expect(schemas[1]).not.toContain('search_files')
  })

  it('会话内问答的工具预算由 profile 硬性收紧', async () => {
    let round = 0
    let executed = 0
    const run = vi.fn(() => {
      executed += 1
      return {
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: `wxid_locked:${String(executed)}`,
          name: '当前会话',
          time: '2026-10-20 10:00',
          snippet: '合同信息',
          source: 'msg' as const,
        }],
      }
    })
    const runTurn = vi.fn(async () => {
      round += 1
      return turn({
        calls: Array.from({ length: 5 }, (_, i) => ({
          id: `call_budget_${String(round)}_${String(i)}`,
          name: 'search_messages',
          args: { keywords: [`合同-${String(round)}-${String(i)}`] },
        })),
      })
    }) as unknown as RunChatTurnFn

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', run)],
      runTurn,
      maxRounds: 99,
      maxCallsPerRound: 99,
      synthesize: async () => '合同信息 [1]',
      intentClassifier: async () => null,
    }), {
      question: '当前会话里有哪些合同信息？',
      source: 'session',
      username: 'wxid_locked',
    })

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(6)
    expect(out.toolCalls?.filter(trace => !trace.skipped)).toHaveLength(6)
    expect(out.toolCalls?.filter(trace => trace.skipped)).toHaveLength(4)
    expect(out.toolCalls?.every(trace => trace.round <= 2)).toBe(true)
  })

  it('会话内问答缺少 username 时直接 blocked，不调用模型', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages')],
      runTurn,
    }), { question: '合同尾款', source: 'session' })

    expect(out.status).toBe('blocked')
    expect(out.answer).toContain('没法开始检索')
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('会话内问答拒绝模型改写 username', async () => {
    const run = vi.fn(() => ({ tool: 'search_messages' as const, ok: true, hits: [] }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '无法越界。' })
      return turn({ calls: [{ id: 'call_scope', name: 'search_messages', args: { keywords: ['合同'], username: 'wxid_other' } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', run)],
      runTurn,
    }), { question: '合同尾款什么时候付？', source: 'session', username: 'wxid_locked' })

    expect(run).not.toHaveBeenCalled()
    expect(out.toolCalls?.[0]).toMatchObject({
      errorClass: 'scope_blocked',
      errorCode: 'scope_violation',
    })
    expect(out.status).toBe('blocked')
  })

  it('问题里引号点名已知会话时直接锁定 username，并默认取最新消息', async () => {
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        username: '123@chatroom',
        order: 'desc',
      })
      return {
        tool: 'get_session_messages' as const,
        ok: true,
        hits: [{
          key: '123@chatroom:8',
          name: '项目群',
          time: '2026-10-21 18:00',
          snippet: '最新一条是接口已经恢复。',
          source: 'msg' as const,
        }],
      }
    })
    const sessionTool: RetrievalTool = {
      name: 'get_session_messages',
      category: 'message',
      description: 'get_session_messages 测试替身（说明长度足够）',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          limit: { type: 'number' },
          order: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['username'],
      },
      run,
    }
    let firstSchema: Record<string, unknown> | undefined
    let firstToolNames: string[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (!hasToolResult(input)) {
        firstToolNames = (input.tools ?? []).map(tool => tool.name)
        firstSchema = input.tools?.find(tool => tool.name === 'get_session_messages')?.parameters
        expect(input.system).toContain('会话范围已锁定')
        return turn({
          calls: [{ id: 'call_latest', name: 'get_session_messages', args: {} }],
        })
      }
      return turn({ text: '已拿到最新消息。' })
    }) as unknown as RunChatTurnFn

    const out = await askWithRuntime(deps({
      tools: [sessionTool, fakeTool('aggregate_messages')],
      runTurn,
      knownSessionCatalog: [{ username: '123@chatroom', name: '项目群' }],
      synthesize: async () => '接口已经恢复 [1]。',
    }), {
      question: '最近「项目群」里聊了些什么？',
      source: 'ask',
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(firstSchema?.['required']).toEqual([])
    expect(firstToolNames).not.toContain('aggregate_messages')
    expect(out.status).not.toBe('failed')
  })
})

describe('askWithRuntime：过程快照与真实耗时', () => {
  it('保留完整阶段事件快照，同时继续通知原 emitStage 监听器', async () => {
    const emitted: AnswerRuntimeStage[] = []
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{
          id: 'call_snapshot',
          name: 'search_messages',
          args: { keywords: ['尾款'] },
        }],
      })
    }) as unknown as RunChatTurnFn
    try {
      const out = await askWithRuntime(deps({
        tools: [fakeTool('search_messages', () => ({
          tool: 'search_messages' as const,
          ok: true,
          hits: [{
            key: 'wxid_a:31',
            name: '项目群',
            time: '2026-10-20 10:00',
            snippet: '尾款下周一付',
            source: 'msg' as const,
          }],
        }))],
        runTurn,
        runChat: undefined,
        synthesize: async () => {
          clock.mockReturnValue(1_123)
          return '尾款下周一付 [1]'
        },
        emitStage: stage => { emitted.push(stage) },
      }), { question: '尾款什么时候付？', source: 'ask' })

      expect(out.stages).toBeDefined()
      expect(out.stages).toEqual(emitted)
      expect(out.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'answer:tools', status: 'running' }),
        expect.objectContaining({
          callId: 'call_snapshot',
          toolName: 'search_messages',
          phase: 'completed',
          status: 'done',
          hits: 1,
        }),
        expect.objectContaining({ key: 'answer:synthesize', status: 'done' }),
      ]))
      expect(out.durationMs).toBe(123)
      expect(out.toolCalls?.[0]).toMatchObject({
        resultSummary: '1 条命中',
      })
      expect(out.toolCalls?.[0]?.resultDetail).toContain('尾款下周一付')
    } finally {
      clock.mockRestore()
    }
  })

  it('没有外部监听器时也返回阶段快照与耗时', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages')],
      runTurn,
    }), { question: '当前会话聊了什么？', source: 'session' })

    expect(out.status).toBe('blocked')
    expect(runTurn).not.toHaveBeenCalled()
    expect(out.stages).toEqual([
      expect.objectContaining({
        key: 'answer:blocked',
        status: 'skipped',
      }),
    ])
    expect(out.durationMs).toBeTypeOf('number')
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('按工具轮次保留思考分段，并给实时事件带上同一轮次', async () => {
    const emittedReasoning: Array<{ text: string; round?: number; version?: number; seq?: number }> = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) {
        input.onReasoning?.('第二轮：先核对检索结果。')
        return turn({ text: '尾款下周一付。' })
      }
      input.onReasoning?.('第一轮：先确定时间范围。')
      return turn({
        calls: [{ id: 'call_reasoning', name: 'search_messages', args: { keywords: ['尾款'] } }],
      })
    }) as unknown as RunChatTurnFn

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages',
        ok: true,
        hits: [{
          key: 'wxid_a:32',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '尾款下周一付',
          source: 'msg',
        }],
      }))],
      runTurn,
      runChat: undefined,
      synthesize: async () => '尾款下周一付 [1]',
      emitReasoning: (text, meta) => {
        emittedReasoning.push({
          text,
          ...(meta?.round === undefined ? {} : { round: meta.round }),
          ...(meta?.version === undefined ? {} : { version: meta.version }),
          ...(meta?.seq === undefined ? {} : { seq: meta.seq }),
        })
      },
    }), { question: '尾款什么时候付？', source: 'ask' })

    expect(out.reasoningSegments).toEqual([
      expect.objectContaining({
        key: 'reasoning:tool:1',
        round: 1,
        phase: 'tool_selection',
        text: '第一轮：先确定时间范围。',
        version: 1,
        seq: 1,
      }),
      expect.objectContaining({
        key: 'reasoning:tool:2',
        round: 2,
        phase: 'tool_selection',
        text: '第二轮：先核对检索结果。',
        version: 1,
        seq: 2,
      }),
    ])
    expect(emittedReasoning).toEqual(expect.arrayContaining([
      expect.objectContaining({
        round: 1,
        text: '第一轮：先确定时间范围。',
        version: 1,
        seq: 1,
      }),
      expect.objectContaining({
        round: 2,
        text: '第二轮：先核对检索结果。',
        version: 1,
        seq: 2,
      }),
    ]))
    expect(out.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        callId: 'call_reasoning',
        round: 1,
        toolName: 'search_messages',
      }),
    ]))
  })

  it('空白思考只忽略，不创建空分段', () => {
    const collector = createAskReasoningCollector()
    collector.onReasoning('   ', {
      phase: 'tool_selection',
      mode: 'delta',
      round: 1,
    })
    expect(collector.snapshot()).toEqual([])

    collector.onReasoning('有效思考', {
      phase: 'tool_selection',
      mode: 'delta',
      round: 1,
    })
    expect(collector.snapshot()).toEqual([
      expect.objectContaining({
        key: 'reasoning:tool:1',
        round: 1,
        text: '有效思考',
        seq: 1,
      }),
    ])
  })

  it('带图综合生成被用户停止时不重试纯文本，并把取消信号传到底层', async () => {
    const controller = new AbortController()
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{ id: 'call_cancel_image', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as unknown as RunChatTurnFn
    const runChat = vi.fn(async (
      _system: string,
      _text: string,
      _maxTokens: number,
      _onDelta?: (text: string) => void,
      _onReasoning?: (text: string) => void,
      _images?: readonly unknown[],
      signal?: AbortSignal,
    ) => {
      expect(signal).toBe(controller.signal)
      throw Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
    }) as unknown as RunChatFn
    const op = vi.fn()

    await expect(askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:33',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '合同原文已确认。',
          source: 'msg' as const,
        }],
      }))],
      runTurn,
      runChat,
      prepareImages: () => ({
        blocks: [{
          type: 'image',
          data: 'aGVsbG8=',
          mediaType: 'image/png',
        } as unknown as ImageBlock],
        note: '',
        audit: '',
      }),
      cancelSignal: controller.signal,
      op,
    }), {
      question: '合同图片里写了什么？',
      source: 'ask',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
    })).rejects.toMatchObject({ code: 'ASK_CANCELED' })

    expect(runChat).toHaveBeenCalledTimes(1)
    expect(op).not.toHaveBeenCalledWith(
      'task',
      'ask_wechat',
      'fail',
      'image_send',
      expect.any(String),
    )
  })

  it('失败工具阶段只记录稳定分类，不把脱敏错误正文写进可落库轨迹', async () => {
    const stages: AnswerRuntimeStage[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索失败。' })
      return turn({
        calls: [{ id: 'call_error_detail', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as unknown as RunChatTurnFn
    const sensitiveError = '上游返回：token=secret-token，查询正文=合同全文'

    await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: false,
        error: sensitiveError,
        errorCode: 'upstream_failure' as const,
        hits: [],
      }))],
      runTurn,
      runChat: async () => '这次没有查到。',
      emitStage: stage => { stages.push(stage) },
      op: () => undefined,
    }), { question: '合同在哪里？', source: 'ask' })

    const failed = stages.find(stage => stage.callId === 'call_error_detail' && stage.status === 'failed')
    expect(failed).toMatchObject({
      errorClass: 'internal',
      detail: '工具调用失败（internal）',
    })
    expect(failed?.detail).not.toContain('secret-token')
    expect(failed?.detail).not.toContain('合同全文')
  })

  it('真实综合链路把核对结果的 running/done 同时写入快照与外部事件', async () => {
    const emitted: AnswerRuntimeStage[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{ id: 'call_verify_ok', name: 'search_messages', args: { keywords: ['尾款'] } }],
      })
    }) as unknown as RunChatTurnFn

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:41',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '尾款下周一付',
          source: 'msg' as const,
        }],
      }))],
      runTurn,
      runChat: async () => '尾款下周一付 [1]',
      intentClassifier: async () => null,
      emitStage: stage => { emitted.push(stage) },
    }), { question: '尾款什么时候付？', source: 'ask' })

    const verifyStages = out.stages?.filter(stage => stage.key === 'answer:verify')
    expect(verifyStages).toEqual([
      { key: 'answer:verify', label: '核对结果', status: 'running' },
      { key: 'answer:verify', label: '核对结果', status: 'done' },
    ])
    expect(emitted.filter(stage => stage.key === 'answer:verify')).toEqual(verifyStages)
    expect(out.stages).toEqual(emitted)
  })

  it('核对修复超时时立即结束，并保留已流出的首版回答', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{ id: 'call_verify_timeout', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as unknown as RunChatTurnFn
    let calls = 0
    let repairSignal: AbortSignal | undefined
    const runChat: RunChatFn = async (...args) => {
      calls += 1
      if (calls === 1) return '合同金额是 5000.00 元 [1]'
      repairSignal = args[6]
      if (repairSignal === undefined) throw new Error('核对调用缺少取消信号')
      return new Promise<string>((_resolve, reject) => {
        if (repairSignal?.aborted === true) {
          reject(repairSignal.reason)
          return
        }
        repairSignal?.addEventListener('abort', () => reject(repairSignal?.reason), { once: true })
      })
    }

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:43',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '合同金额是 3000 元',
          source: 'msg' as const,
        }],
      }))],
      runTurn,
      runChat,
      answerVerifyDeadlineMs: 50,
      intentClassifier: async () => null,
    }), { question: '合同金额是多少？', source: 'ask' })

    expect(calls).toBe(2)
    expect(out.answer).toBe('合同金额是 5000.00 元 [1]')
    expect(out.status).toBe('ok')
    expect(repairSignal?.aborted).toBe(true)
    expect(out.stages?.filter(stage => stage.key === 'answer:verify')).toEqual([
      { key: 'answer:verify', label: '核对结果', status: 'running' },
      {
        key: 'answer:verify',
        label: '核对结果',
        status: 'done',
        detail: '核对超时，已保留首版回答',
      },
    ])
  })

  it('核对期间用户主动停止时立即传播取消，而不是等待核对 deadline', async () => {
    const cancel = new AbortController()
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{ id: 'call_verify_cancel', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as unknown as RunChatTurnFn
    let calls = 0
    let repairStarted!: () => void
    const repairReady = new Promise<void>((resolve) => { repairStarted = resolve })
    const runChat: RunChatFn = async (...args) => {
      calls += 1
      if (calls === 1) return '合同金额是 5000.00 元 [1]'
      const signal = args[6]
      repairStarted()
      return new Promise<string>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('核对调用缺少取消信号'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' }))
        }, { once: true })
      })
    }
    const asking = askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:44',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '合同金额是 3000 元',
          source: 'msg' as const,
        }],
      }))],
      runTurn,
      runChat,
      answerVerifyDeadlineMs: 5_000,
      cancelSignal: cancel.signal,
      throwIfCanceled: () => {
        if (cancel.signal.aborted) {
          throw Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
        }
      },
      intentClassifier: async () => null,
    }), { question: '合同金额是多少？', source: 'ask' })

    await repairReady
    cancel.abort()
    await expect(asking).rejects.toMatchObject({ code: 'ASK_CANCELED' })
    expect(calls).toBe(2)
  })

  it('核对阶段异常时写入 failed，并继续保留在快照与外部事件中', async () => {
    const emitted: AnswerRuntimeStage[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{ id: 'call_verify_failed', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as unknown as RunChatTurnFn
    const runChat: RunChatFn = vi.fn()
      .mockResolvedValueOnce('合同金额是 5000.00 元 [1]')
      .mockRejectedValueOnce(new Error('核对调用失败'))

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:42',
          name: '项目群',
          time: '2026-10-20 10:00',
          snippet: '合同金额是 3000 元',
          source: 'msg' as const,
        }],
      }))],
      runTurn,
      runChat,
      intentClassifier: async () => null,
      emitStage: stage => { emitted.push(stage) },
    }), { question: '合同金额是多少？', source: 'ask' })

    const verifyStages = out.stages?.filter(stage => stage.key === 'answer:verify')
    expect(verifyStages).toHaveLength(2)
    expect(verifyStages?.[0]).toMatchObject({
      key: 'answer:verify',
      label: '核对结果',
      status: 'running',
    })
    expect(verifyStages?.[1]).toMatchObject({
      key: 'answer:verify',
      label: '核对结果',
      status: 'failed',
      detail: '核对调用失败',
    })
    expect(runChat).toHaveBeenCalledTimes(2)
    expect(emitted.filter(stage => stage.key === 'answer:verify')).toEqual(verifyStages)
    expect(out.stages).toEqual(emitted)
  })
})

describe('askWithRuntime：多轮线程状态进入检索范围', () => {
  it('「那上周呢」把上一轮时间窗递进后注入工具上下文，并推进本轮状态', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({ calls: [{ id: 'call_t', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', (args, ctx) => {
        seen.push(args)
        expect(ctx.scope).toMatchObject({ username: 'team@chatroom', from: '2026-10-07', to: '2026-10-07' })
        return {
          tool: 'search_messages',
          ok: true,
          hits: [{
            key: 'team@chatroom:8',
            name: '项目群',
            time: '2026-10-07 10:00',
            snippet: '上周交付已经完成',
            source: 'msg',
          }],
        }
      })],
      runTurn,
      runChat: async () => '上周交付完成了。 [1]',
    }), {
      question: '那上周呢？',
      source: 'ask',
      threadState: {
        activeSession: 'team@chatroom',
        lastTimeRange: { from: '2026-10-14', to: '2026-10-14' },
        lastTimeGranularity: 'week',
        lastTimeHard: false,
        turns: 1,
      },
    })

    expect(seen[0]?.['from']).toBe('2026-10-07')
    expect(seen[0]?.['to']).toBe('2026-10-07')
    expect(out.appliedThreadState?.from).toBe('2026-10-07')
    expect(out.appliedThreadState?.reason.join('\n')).toContain('时间递进')
    expect(out.threadState?.lastTimeRange).toEqual({ from: '2026-10-07', to: '2026-10-07' })
  })

  it('UI 显式时间范围优先于线程状态继承', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({ calls: [{ id: 'call_t', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn
    await askWithRuntime(deps({
      tools: [fakeTool('search_messages', (args) => {
        seen.push(args)
        return { tool: 'search_messages', ok: true, hits: [] }
      })],
      runTurn,
    }), {
      question: '那上周呢？',
      source: 'ask',
      from: '2026-09-01',
      to: '2026-09-07',
      threadState: {
        lastTimeRange: { from: '2026-10-14', to: '2026-10-14' },
        lastTimeHard: false,
        turns: 1,
      },
    })

    expect(seen[0]?.['from']).toBe('2026-09-01')
    expect(seen[0]?.['to']).toBe('2026-09-07')
  })

  it('界面仍停在单日时，问题中的完整区间同时覆盖工具范围和下一轮线程状态', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({
        calls: [{
          id: 'call_month',
          name: 'search_messages',
          args: { keywords: ['王国路'], from: '2026-09-16', to: '2026-10-16' },
        }],
      })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', (args) => {
        seen.push(args)
        return {
          tool: 'search_messages',
          ok: true,
          hits: [{
            key: 'wxid_wangguolu:88',
            name: '王国路',
            time: '2026-10-12 09:30',
            snippet: '项目验收时间调整到下周三。',
            source: 'msg',
          }],
        }
      })],
      runTurn,
      runChat: async () => '这段时间主要聊了项目验收调整。 [1]',
    }), {
      question: '请检索并总结最近一个月（截至2026-10-16，即2026-09-16至2026-10-16）我与王国路的聊天内容。',
      source: 'session',
      username: 'wxid_wangguolu',
      // 模拟界面筛选仍停留在上次选中的单日。
      from: '2026-10-16',
      to: '2026-10-16',
      threadState: {
        activeSession: 'wxid_wangguolu',
        lastTimeRange: { from: '2026-10-16', to: '2026-10-16' },
        lastTimeHard: true,
        turns: 1,
      },
    })

    expect(seen[0]?.['from']).toBe('2026-09-16')
    expect(seen[0]?.['to']).toBe('2026-10-16')
    expect(out.appliedThreadState).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
    })
    expect(out.appliedThreadState?.reason.join('\n')).toContain('覆盖遗留硬筛选')
    expect(out.threadState?.lastTimeRange).toEqual({
      from: '2026-09-16',
      to: '2026-10-16',
    })
    expect(out.status).not.toBe('blocked')
  })
})

describe('askWithRuntime：澄清与失败', () => {
  it('单聊代词在意图分类器失败时仍解析为当前联系人并继续检索', async () => {
    const systems: string[] = []
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_emin:1',
        name: 'e敏',
        time: '2026-10-20 10:00',
        snippet: '已向 e敏 转账 520.00 元',
        source: 'msg' as const,
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      systems.push(input.system)
      if (hasToolResult(input)) return turn({ text: '检索完成。' })
      return turn({
        calls: [{
          id: 'call_private_pronoun',
          name: 'search_messages',
          args: { keywords: ['转账'] },
        }],
      })
    }) as unknown as RunChatTurnFn

    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', run)],
      runTurn,
      runChat: undefined,
      synthesize: async () => '已向 e敏 转账 520.00 元 [1]',
      intentClassifier: async () => {
        throw new Error('LLM 超时')
      },
      intentClassifierDeadlineMs: 1,
    }), {
      question: '我给她转了多少钱？',
      source: 'session',
      username: 'wxid_emin',
      usernameName: 'e敏',
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.status).not.toBe('needs_clarification')
    expect(out.plan?.person).toBe('e敏')
    expect(out.appliedThreadState?.contact).toBe('e敏')
    expect(out.threadState?.activeContact).toBe('e敏')
    expect(out.toolCalls?.length).toBeGreaterThan(0)
    expect(out.answer).toContain('520')
    expect(systems[0]).toContain('e敏')
  })

  it('需要澄清时不执行工具，回答是一句人话追问', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages')],
      runTurn,
    }), { question: '他上周说了什么？', source: 'ask' })

    expect(out.status).toBe('needs_clarification')
    expect(out.answer).toContain('请问')
    expect(out.answer.trim()).not.toBe('')
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('工具参数无法修复且没有证据时，回答提示补充检索条件', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '参数不完整，本轮停止。' })
      return turn({ calls: [{ id: 'call_bad', name: 'search_messages', args: {} }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages')],
      runTurn,
    }), { question: '合同尾款什么时候付？', source: 'ask' })

    expect(out.status).toBe('needs_clarification')
    expect(out.answer).toContain('检索条件')
    expect(out.toolCalls?.[0]).toMatchObject({ errorClass: 'invalid_arguments' })
  })

  it('工具 timeout 有界重试，trace 保留尝试次数并最终降级/失败', async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls += 1
      // 必须明显长于 deadline：5ms/15ms 在 Windows 上会撞上定时器粒度，测试偶发变绿。
      await new Promise(resolve => setTimeout(resolve, 80))
      return {
        tool: 'search_messages' as const,
        ok: true,
        hits: [{ key: 'wxid_a:1', name: '项目群', time: '', snippet: '永远超时', source: 'msg' as const }],
      }
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({ calls: [{ id: 'call_t', name: 'search_messages', args: { keywords: ['尾款'] } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', run)],
      runTurn,
      toolDeadlineMs: 5,
      sleep: async () => undefined,
    }), { question: '合同尾款什么时候付？', source: 'ask' })

    expect(calls).toBe(2)
    expect(out.toolCalls?.[0]).toMatchObject({ attempts: 2, retries: 1, ok: false, errorClass: 'timeout' })
    expect(['degraded', 'failed']).toContain(out.status)
  })
})

describe('askWithRuntime：引用、兜底与证据保留', () => {
  it('纯资源证据也会生成依据行，且不把资源算成消息会话', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '找到文件。' })
      return turn({ calls: [{ id: 'call_file', name: 'search_files', args: { query: '合同' } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_files', () => ({
        tool: 'search_files' as const,
        ok: true,
        hits: [{
          key: 'file:contract',
          name: '合同.pdf',
          time: '2026-10-20 09:00',
          snippet: '合同附件',
          source: 'resource' as const,
        }],
      }))],
      runTurn,
      runChat: async () => '找到《合同.pdf》。',
    }), { question: '帮我找合同文件', source: 'ask' })

    expect(out.status).toBe('ok')
    expect(out.citations).toEqual([])
    expect(out.resources).toHaveLength(1)
    expect(out.basis).toContain('依据本机记录')
    expect(out.basis).toContain('1 个相关资源')
    expect(out.basis).not.toContain('条原文')
    expect(out.basis).not.toContain('个会话')
    expect(out.basis).not.toContain('个知识库文件')
  })

  it('纯聚合事实按统计事实计数，不冒充聊天原文', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '统计完成。' })
      return turn({
        calls: [{
          id: 'call_agg',
          name: 'aggregate_messages',
          args: { question: '最近7天哪个群消息最多' },
        }],
      })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('aggregate_messages', () => ({
        tool: 'aggregate_messages' as const,
        ok: true,
        hits: [],
        facts: [{ title: '按会话统计', body: '项目群：12 条' }],
      }))],
      runTurn,
    }), { question: '最近7天哪个群消息最多？', source: 'ask' })

    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]?.source).toBe('agg')
    expect(out.basis).toContain('依据本机记录')
    expect(out.basis).toContain('1 条统计事实')
    expect(out.basis).not.toContain('条原文')
    expect(out.basis).not.toContain('个会话')
    expect(out.basis).not.toContain('个知识库文件')
  })

  it('聊天与聚合事实混合时分别计数，时间跨度只取聊天消息', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '统计完成。' })
      return turn({
        calls: [
          { id: 'call_msg', name: 'search_messages', args: { keywords: ['合同'] } },
          {
            id: 'call_agg',
            name: 'aggregate_messages',
            args: { question: '最近7天哪个群消息最多' },
          },
        ],
      })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [
        fakeTool('search_messages', () => ({
          tool: 'search_messages' as const,
          ok: true,
          hits: [{
            key: 'wxid_a:21',
            name: '项目群',
            time: '2026-10-20 10:00',
            snippet: '合同已经签了',
            source: 'msg' as const,
          }],
        })),
        fakeTool('aggregate_messages', () => ({
          tool: 'aggregate_messages' as const,
          ok: true,
          hits: [],
          facts: [{ title: '按会话统计', body: '项目群：12 条' }],
        })),
      ],
      runTurn,
      runChat: async () => '项目群最活跃 [1][2]。',
    }), { question: '最近7天哪个群消息最多？', source: 'ask' })

    expect(out.citations).toHaveLength(2)
    expect(out.basis).toContain('1 条聊天原文')
    expect(out.basis).toContain('1 个会话')
    expect(out.basis).toContain('1 条统计事实')
    expect(out.basis).toContain('2026-10-20 ~ 2026-10-20')
    expect(out.basis).not.toContain('2 条聊天原文')
  })

  it('引用映射连续编号，并保留 evidenceId 与 locator', async () => {
    const searchMessages = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_a:11',
        name: '项目群',
        time: '2026-10-20 10:00',
        snippet: '尾款下周一付',
        sender: '李四',
        source: 'msg' as const,
      }],
    }))
    const searchFiles = vi.fn(() => ({
      tool: 'search_files' as const,
      ok: true,
      hits: [{
        key: 'file:contract',
        name: '合同.pdf',
        time: '',
        snippet: '合同附件',
        source: 'resource' as const,
        trace: {
          kind: 'resource' as const,
          resource: {
            resourceKind: 'file' as const,
            stableKey: 'file:contract',
            fileName: '合同.pdf',
            size: 1536,
            category: 'file',
            md5: 'contract',
          },
        },
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '完成检索。' })
      return turn({
        calls: [
          { id: 'call_msg', name: 'search_messages', args: { keywords: ['尾款'] } },
          { id: 'call_file', name: 'search_files', args: { query: '合同' } },
        ],
      })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', searchMessages), fakeTool('search_files', searchFiles)],
      runTurn,
      runChat: async () => '尾款下周一付 [1]',
    }), { question: '尾款什么时候付？', source: 'ask' })

    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]).toMatchObject({
      index: 1,
      evidenceId: 'msg:wxid_a:11',
      username: 'wxid_a',
      local_id: 11,
      locator: { type: 'message', username: 'wxid_a', localId: 11 },
    })
    expect(out.resources?.[0]).toMatchObject({
      evidenceId: 'res:search_files:file:contract',
      locator: {
        type: 'resource',
        tool: 'search_files',
        key: 'file:contract',
        stableKey: 'file:contract',
        resourceKind: 'file',
        fileName: '合同.pdf',
        size: 1536,
        category: 'file',
        md5: 'contract',
      },
    })
    expect(out.citedIndexes).toEqual([1])
  })

  it('综合生成抛错时降级，但保留引用与证据', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具完成。' })
      return turn({ calls: [{ id: 'call_1', name: 'search_messages', args: { keywords: ['合同'] } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{ key: 'wxid_a:15', name: '项目群', time: '', snippet: '合同原文已确认。', source: 'msg' as const }],
      }))],
      runTurn,
      runChat: async () => { throw new Error('模型不可用') },
    }), { question: '合同尾款什么时候付？', source: 'ask' })

    expect(out.status).toBe('degraded')
    expect(out.citations).toHaveLength(1)
    expect(out.evidence?.items).toHaveLength(1)
    expect(out.answer).toContain('合同原文已确认')
    expect(out.statusReason).toContain('模型不可用')
  })
})
