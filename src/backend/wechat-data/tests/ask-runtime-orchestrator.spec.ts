/**
 * 生产编排层：profile 选择、边界、澄清、重试、引用映射与兜底。
 *
 * 全部离线：runTurn / runChat / privacyGate / 工具都可注入，不读数据库。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AskModelTurn, RunChatTurnFn } from '../src/remotes/ask-run-chat.ts'
import type { RetrievalTool, ToolContext, ToolName, ToolResult } from '../src/query/tools/index.ts'
import { askWithRuntime, type AskRuntimeDeps } from '../src/remotes/ask-runtime.ts'

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
  it('三个入口选择正确 profile，且只把白名单工具交给模型', async () => {
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
    await askWithRuntime(deps({ tools, runTurn }), {
      question: '合同尾款',
      source: 'auto',
      dataScope: 'kb-only',
      kbId: 7,
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
    expect(schemas[2]).toEqual(['search_kb'])
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

  it('kb-only 无证据时走聊天兜底，状态仍为 insufficient 且不保留角标', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '知识库没有命中。' })
      return turn({ calls: [{ id: 'call_kb', name: 'search_kb', args: { query: '在吗' } }] })
    }) as unknown as RunChatTurnFn
    const out = await askWithRuntime(deps({
      tools: [fakeTool('search_kb', () => ({ tool: 'search_kb', ok: true, hits: [] }))],
      runTurn,
      runChat: async () => '在的 [1]',
    }), {
      question: '在吗？',
      source: 'auto',
      dataScope: 'kb-only',
      kbId: 7,
    })

    expect(out.status).toBe('insufficient')
    expect(out.insufficient).toBe(true)
    expect(out.citations).toEqual([])
    expect(out.answer).toContain('在的')
    expect(out.answer).not.toContain('[1]')
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
