/**
 * 高层编排：边界归一、证据引用与综合生成降级。
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
  type ToolName,
  type ToolResult,
} from '../src/query/tools/index.ts'
import {
  citationsFromEvidence,
  resourcesFromEvidence,
  runAnswerRuntime,
} from '../src/query/answer-runtime/runtime.ts'

const NOW = new Date('2026-10-22T10:00:00')

function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'answer-runtime-test' },
  })
}

function fakeTool(
  name: ToolName,
  run: (args: Record<string, unknown>) => ToolResult,
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
  call?: { id: string; name: string; args: unknown }
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

function baseInput(overrides: Partial<Parameters<typeof runAnswerRuntime>[0]> = {}) {
  return {
    question: '合同尾款什么时候付？',
    system: '系统提示',
    messages: [userMessage('合同尾款什么时候付？')],
    profile: ANSWER_PROFILES['wechat-ask'],
    profileTools: [] as RetrievalTool[],
    toolContext: { decryptedDir: '/fake', now: NOW },
    runTurn: vi.fn() as unknown as RunChatTurnFn,
    now: NOW,
    ...overrides,
  }
}

describe('runAnswerRuntime', () => {
  it('用户写完整区间时不会被单日范围误判越界，并保留可用证据', async () => {
    const question = '请检索并总结最近一个月（截至2026-10-16，即2026-09-16至2026-10-16）我与王国路的聊天内容。'
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        from: '2026-09-16',
        to: '2026-10-16',
      })
      return {
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_wangguolu:88',
          name: '王国路',
          time: '2026-10-12 09:30',
          snippet: '项目验收时间调整到下周三。',
          sender: '王国路',
          source: 'msg' as const,
          trace: {
            kind: 'msg' as const,
            username: 'wxid_wangguolu',
            localId: 88,
          },
        }],
      }
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '已按完整区间检索。' })
      }
      return turn({
        call: {
          id: 'call_range',
          name: 'search_messages',
          args: {
            keywords: ['王国路'],
            from: '2026-09-16',
            to: '2026-10-16',
          },
        },
      })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      question,
      messages: [userMessage(question)],
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      synthesize: () => '这段时间主要聊了项目验收调整。 [1]',
    }))

    expect(out.status).not.toBe('blocked')
    expect(out.answer).not.toContain('越过当前数据边界')
    expect(out.context.scope).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(out.citations).toHaveLength(1)
  })

  it('界面遗留单日筛选时，问题中的完整区间仍覆盖日期并使用该区间检索', async () => {
    const question = '请检索并总结最近一个月（截至2026-10-16，即2026-09-16至2026-10-16）我与王国路的聊天内容。'
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        from: '2026-09-16',
        to: '2026-10-16',
      })
      return {
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_wangguolu:88',
          name: '王国路',
          time: '2026-10-12 09:30',
          snippet: '项目验收时间调整到下周三。',
          source: 'msg' as const,
          trace: { kind: 'msg' as const, username: 'wxid_wangguolu', localId: 88 },
        }],
      }
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '已按问题中的完整区间检索。' })
      }
      return turn({
        call: {
          id: 'call_ui_scope',
          name: 'search_messages',
          args: { keywords: ['王国路'], from: '2026-09-16', to: '2026-10-16' },
        },
      })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      question,
      messages: [userMessage(question)],
      profileTools: [fakeTool('search_messages', run)],
      toolContext: {
        decryptedDir: '/fake',
        now: NOW,
        // 模拟界面时间筛选还停在单日：问题原文的完整区间应覆盖它。
        scope: { from: '2026-10-16', to: '2026-10-16' },
      },
      runTurn,
      synthesize: () => '这段时间主要聊了项目验收调整。 [1]',
    }))

    expect(out.status).not.toBe('blocked')
    expect(out.context.scope).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
    })
    expect(out.toolCalls[0]?.ok).toBe(true)
    expect(out.citations).toHaveLength(1)
  })

  it('工具 → 证据 → 综合生成，引用保持可点击字段', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_a:11',
        name: '项目群',
        time: '2026-10-20 10:00',
        snippet: '合同尾款下周一付',
        sender: '李四',
        source: 'msg' as const,
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '工具阶段完成。' })
      }
      return turn({ call: { id: 'call_1', name: 'search_messages', args: { keywords: ['尾款'] } } })
    }) as unknown as RunChatTurnFn
    const synthesize = vi.fn(() => '下周一付。 [1]')

    const out = await runAnswerRuntime(baseInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
      synthesize,
    }))

    expect(out.status).toBe('ok')
    expect(out.answer).toBe('下周一付。 [1]')
    expect(out.synthesized).toBe(true)
    expect(out.rounds).toBe(2)
    expect(out.evidence.items).toHaveLength(1)
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(out.citations[0]).toMatchObject({
      index: 1,
      source: 'msg',
      username: 'wxid_a',
      local_id: 11,
      sender: '李四',
    })
  })

  it('固定范围下 list_sessions 不暴露，残留调用只降级且保留目标会话 8 条消息', async () => {
    const listSessionsRun = vi.fn(() => ({
      tool: 'list_sessions' as const,
      ok: true,
      hits: [],
    }))
    const sessionMessagesRun = vi.fn((args: Record<string, unknown>) => {
      expect(args['username']).toBe('wxid_sellwine')
      expect(args['from']).toBe('2026-10-16')
      expect(args['to']).toBe('2026-10-22')
      return {
        tool: 'get_session_messages' as const,
        ok: true,
        hits: Array.from({ length: 8 }, (_, index) => ({
          key: `wxid_sellwine:${String(index + 1)}`,
          name: 'z_卖酒',
          time: `2026-10-${String(15 + index).padStart(2, '0')} 10:00`,
          snippet: `目标会话的第 ${String(index + 1)} 条消息`,
          source: 'msg' as const,
          trace: {
            kind: 'msg' as const,
            username: 'wxid_sellwine',
            localId: index + 1,
          },
        })),
      }
    })
    const profileTools: RetrievalTool[] = [
      {
        name: 'list_sessions',
        category: 'message',
        description: 'list_sessions 测试替身（说明长度足够）',
        parameters: { type: 'object', properties: {} },
        run: listSessionsRun,
      },
      {
        name: 'get_session_messages',
        category: 'message',
        description: 'get_session_messages 测试替身（说明长度足够）',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['username'],
        },
        run: sessionMessagesRun,
      },
    ]
    const schemas: string[][] = []
    const systems: string[] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      systems.push(input.system)
      schemas.push((input.tools ?? []).map(schema => schema.name))
      const toolResults = input.messages
        .flatMap(message => message.content)
        .filter(block => block.type === 'tool-result')
      if (toolResults.length === 0) {
        return turn({
          call: { id: 'call_list', name: 'list_sessions', args: { orderBy: 'recent' } },
        })
      }
      if (toolResults.length === 1) {
        return turn({
          call: {
            id: 'call_session',
            name: 'get_session_messages',
            args: { username: '「z_卖酒」' },
          },
        })
      }
      return turn({ text: '最近和 z_卖酒 聊了 8 条消息。' })
    }) as unknown as RunChatTurnFn
    const synthesize = vi.fn(() => '最近主要聊了供货和结款。 [1][2][3][4][5][6][7][8]')

    const out = await runAnswerRuntime(baseInput({
      question: '最近和「z_卖酒」聊了什么？',
      messages: [userMessage('最近和「z_卖酒」聊了什么？')],
      profileTools,
      knownSessionCatalog: [
        { username: 'wxid_sellwine', name: 'z_卖酒' },
      ],
      runTurn,
      synthesize,
    }))

    expect(schemas[0]).toContain('get_session_messages')
    expect(schemas[0]).not.toContain('list_sessions')
    expect(systems[0]).toContain('get_session_messages')
    expect(systems[0]).not.toContain('list_sessions')
    expect(out.status).not.toBe('blocked')
    expect(out.status).toBe('degraded')
    expect(out.evidence.items).toHaveLength(8)
    expect(out.citations).toHaveLength(8)
    expect(out.citations.map(citation => citation.username)).toEqual(
      Array.from({ length: 8 }, () => 'wxid_sellwine'),
    )
    expect(out.evidence.stats).toMatchObject({
      messages: 8,
      unsupportedScopeResults: 1,
      scopeBlockedResults: 0,
    })
    expect(out.toolCalls.map(trace => trace.name)).toEqual([
      'list_sessions',
      'get_session_messages',
    ])
    expect(out.toolCalls[0]).toMatchObject({
      name: 'list_sessions',
      ok: false,
      errorCode: 'unsupported_scope',
      attempts: 1,
      retries: 0,
    })
    expect(listSessionsRun).not.toHaveBeenCalled()
    expect(sessionMessagesRun).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('未注入 synthesize 时返回证据格式化文本并标记未综合', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_a:12',
        name: '项目群',
        time: '',
        snippet: '这是一段原文片段',
        source: 'msg' as const,
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '工具完成。' })
      }
      return turn({ call: { id: 'call_1', name: 'search_messages', args: { keywords: ['原文'] } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      profileTools: [fakeTool('search_messages', run)],
      runTurn,
    }))

    expect(out.synthesized).toBe(false)
    expect(out.answer).toContain('这是一段原文片段')
    expect(out.reason).toContain('未注入 synthesize')
    expect(out.citations).toHaveLength(1)
    expect(out.resources).toEqual([])
  })

  it('资源类证据保留 locator，不伪装成消息引用', () => {
    const resources = resourcesFromEvidence({
      items: [{
        evidenceId: 'res:search_files:x',
        kind: 'hit',
        tool: 'search_files',
        tools: ['search_files'],
        source: 'resource',
        name: 'x.pdf',
        time: '',
        snippet: '资源',
        key: 'x',
        locator: { type: 'resource', tool: 'search_files', key: 'x' },
      }],
      facts: [],
      status: 'ok',
      missing: [],
      stats: {
        count: 1,
        messages: 0,
        kb: 0,
        sessions: 0,
        candidateCount: 1,
        total: 1,
        hitCount: 1,
        factCount: 0,
        duplicateCount: 0,
        droppedByBudget: 0,
        truncated: false,
        snippetChars: 2,
        sourceCounts: { msg: 0, kb: 0, agg: 0, resource: 1 },
        toolCounts: { search_files: 1 },
        failedTools: [],
        attemptedTools: 1,
        successfulTools: 1,
      },
      assessment: { status: 'sufficient', sufficient: true, usableItems: 1, reason: '' },
    })

    expect(resources).toHaveLength(1)
    expect(resources[0]).toMatchObject({
      tool: 'search_files',
      key: 'x',
      locator: { type: 'resource', tool: 'search_files', key: 'x' },
    })
  })

  it('session-ask 缺当前会话直接 blocked，不执行工具', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', () => ({ tool: 'search_messages', ok: true, hits: [] }))],
      toolContext: { decryptedDir: '/fake', now: NOW },
      runTurn,
    }))

    expect(out.status).toBe('blocked')
    expect(out.reason).toContain('当前会话')
    expect(runTurn).not.toHaveBeenCalled()
    expect(out.toolCalls).toEqual([])
  })

  it('session-ask 不能靠问题文本里的 currentSession 解锁服务端范围', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', () => ({ tool: 'search_messages', ok: true, hits: [] }))],
      toolContext: { decryptedDir: '/fake', now: NOW },
      intentOptions: { currentSession: 'wxid_injected' },
      runTurn,
    }))

    expect(out.status).toBe('blocked')
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('session-ask 锁定当前会话并拒绝跨会话调用', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '无法越界。' })
      }
      return turn({
        call: {
          id: 'call_scope',
          name: 'search_messages',
          args: { keywords: ['合同'], username: 'wxid_other' },
        },
      })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', run)],
      toolContext: { decryptedDir: '/fake', now: NOW, scope: { username: 'wxid_locked' } },
      intentOptions: { currentSession: 'wxid_locked' },
      runTurn,
    }))

    expect(run).not.toHaveBeenCalled()
    expect(out.context.scope?.username).toBe('wxid_locked')
    expect(out.toolCalls[0]).toMatchObject({ errorClass: 'scope_blocked', errorCode: 'scope_violation' })
    expect(out.status).toBe('blocked')
  })

  it('ClawBot 无 kb 返回 blocked 且不调用模型/工具', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['clawbot-auto'],
      profileTools: [fakeTool('search_kb', () => ({ tool: 'search_kb', ok: true, hits: [] }))],
      toolContext: { decryptedDir: '/fake', now: NOW },
      runTurn,
    }))

    expect(out.status).toBe('blocked')
    expect(out.reason).toContain('未选择知识库')
    expect(out.context.wechatDataEnabled).toBe(false)
    expect(runTurn).not.toHaveBeenCalled()
    expect(out.toolCalls).toEqual([])
  })

  it('ClawBot 有 kb 时只暴露 search_kb 并生成可引用证据', async () => {
    const kb = vi.fn(() => ({
      tool: 'search_kb' as const,
      ok: true,
      hits: [{
        key: 'kb:7:88',
        name: '合同.pdf',
        time: '',
        snippet: '验收款应支付 30%',
        source: 'kb' as const,
        trace: { kind: 'kb' as const, kbId: 7, fileId: 3, chunkId: 88, ordinal: 2, page: 5, heading: '付款' },
      }],
    }))
    const schemas: string[][] = []
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      schemas.push((input.tools ?? []).map(schema => schema.name))
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '知识库找到验收款 30%。' })
      }
      return turn({ call: { id: 'call_kb', name: 'search_kb', args: { query: '验收款' } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['clawbot-auto'],
      profileTools: [
        fakeTool('search_kb', kb),
        fakeTool('search_messages', () => ({ tool: 'search_messages', ok: true, hits: [] })),
      ],
      toolContext: { decryptedDir: '/fake', kbId: 7, now: NOW, wechatDataEnabled: true },
      runTurn,
      synthesize: () => '验收款是 30%。',
    }))

    expect(schemas[0]).toEqual(['search_kb'])
    expect(out.context.wechatDataEnabled).toBe(false)
    expect(out.status).toBe('ok')
    expect(out.answer).toBe('验收款是 30%。')
    expect(out.citations[0]).toMatchObject({
      source: 'kb',
      kb: {
        kbId: 7,
        fileId: 3,
        chunkId: 88,
        fileName: '合同.pdf',
        fileExt: 'pdf',
        ordinal: 2,
        page: 5,
        heading: '付款',
      },
    })
  })

  it('session-ask 工具输出越界：其他会话的消息不得进入证据或引用', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_other:99',
        name: '别的会话',
        time: '2026-10-20 10:00',
        snippet: '这条消息不属于当前会话',
        source: 'msg' as const,
        trace: { kind: 'msg' as const, username: 'wxid_other', localId: 99 },
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '不应综合生成。' })
      }
      return turn({ call: { id: 'call_leak', name: 'search_messages', args: { keywords: ['合同'] } } })
    }) as unknown as RunChatTurnFn
    const synthesize = vi.fn(() => '不应调用。')

    const out = await runAnswerRuntime(baseInput({
      question: '合同什么时候确认的？',
      messages: [userMessage('合同什么时候确认的？')],
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [fakeTool('search_messages', run)],
      toolContext: { decryptedDir: '/fake', now: NOW, scope: { username: 'wxid_locked' } },
      intentOptions: { currentSession: 'wxid_locked' },
      runTurn,
      synthesize,
    }))

    expect(out.status).toBe('blocked')
    expect(out.evidence.items).toEqual([])
    expect(out.citations).toEqual([])
    expect(out.evidence.stats.rejectedCount).toBe(1)
    expect(out.reason).toContain('其他会话')
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('ClawBot 工具输出越界：消息/其他 kbId 均拒绝，状态 blocked', async () => {
    const run = vi.fn(() => ({
      tool: 'search_kb' as const,
      ok: true,
      hits: [
        {
          key: 'kb:8:11',
          name: '别的库.md',
          time: '',
          snippet: '来自另一个知识库的内容',
          source: 'kb' as const,
          trace: { kind: 'kb' as const, kbId: 8, fileId: 1, chunkId: 11, ordinal: 0, page: 0, heading: '' },
        },
        {
          key: 'wxid_a:1',
          name: '项目群',
          time: '',
          snippet: '不该出现在自动回复里的消息',
          source: 'msg' as const,
          trace: { kind: 'msg' as const, username: 'wxid_a', localId: 1 },
        },
      ],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '不应综合生成。' })
      }
      return turn({ call: { id: 'call_kb_leak', name: 'search_kb', args: { query: '验收款' } } })
    }) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['clawbot-auto'],
      profileTools: [fakeTool('search_kb', run)],
      toolContext: { decryptedDir: '/fake', kbId: 7, now: NOW },
      runTurn,
      synthesize: () => '不应调用。',
    }))

    expect(out.status).toBe('blocked')
    expect(out.evidence.items).toEqual([])
    expect(out.citations).toEqual([])
    // 非知识库来源在归一阶段就按畸形命中拒绝；kbId 不匹配计入边界拒绝。
    expect(out.evidence.stats.rejectedCount).toBe(1)
    expect(out.evidence.stats.malformedHits).toBe(1)
    expect(out.reason).toContain('知识库')
  })

  it('证据不足时可显式允许综合生成（ClawBot 聊天兜底）', async () => {
    const runTurn = vi.fn(async () => turn({ text: '我先按对话内容回答。' })) as unknown as RunChatTurnFn
    const synthesize = vi.fn(() => '聊天兜底回答。')

    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['clawbot-auto'],
      profileTools: [fakeTool('search_kb', () => ({
        tool: 'search_kb' as const,
        ok: true,
        hits: [],
        note: '没有命中',
      }))],
      toolContext: { decryptedDir: '/fake', kbId: 7, now: NOW },
      runTurn,
      synthesize,
      synthesizeOnInsufficient: true,
    }))

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(out.status).toBe('insufficient')
    expect(out.answer).toBe('聊天兜底回答。')
    expect(out.synthesized).toBe(true)
  })

  it('没有工具时保留模型直接回答，但状态仍如实为 insufficient', async () => {
    const runTurn = vi.fn(async () => turn({ text: '你好，我可以帮你查聊天记录。' })) as unknown as RunChatTurnFn

    const out = await runAnswerRuntime(baseInput({
      profile: ANSWER_PROFILES['wechat-ask'],
      profileTools: [],
      runTurn,
    }))

    expect(out.status).toBe('insufficient')
    expect(out.answer).toContain('你好')
    expect(out.toolCalls).toEqual([])
  })

  it('需要澄清的指代不执行工具', async () => {
    const runTurn = vi.fn() as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      question: '他上周说了什么？',
      messages: [userMessage('他上周说了什么？')],
      profileTools: [fakeTool('search_messages', () => ({ tool: 'search_messages', ok: true, hits: [] }))],
      runTurn,
    }))

    expect(out.status).toBe('needs_clarification')
    expect(out.answer.trim()).not.toBe('')
    expect(out.answer).toContain('请问')
    expect(out.reason).toContain('代词')
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('工具参数无法修复且没有证据时收敛为 needs_clarification', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '参数不完整，本轮停止。' })
      }
      return turn({ call: { id: 'call_bad', name: 'search_messages', args: {} } })
    }) as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      profileTools: [fakeTool('search_messages', () => ({
        tool: 'search_messages',
        ok: true,
        hits: [],
      }))],
      runTurn,
    }))

    expect(out.status).toBe('needs_clarification')
    expect(out.toolCalls[0]).toMatchObject({ errorClass: 'invalid_arguments' })
    expect(out.evidence.items).toEqual([])
    expect(out.reason).toContain('参数')
  })

  it('综合生成抛错时降级为证据文本，不丢证据', async () => {
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '工具完成。' })
      }
      return turn({ call: { id: 'call_1', name: 'search_messages', args: { keywords: ['合同'] } } })
    }) as unknown as RunChatTurnFn
    const out = await runAnswerRuntime(baseInput({
      profileTools: [fakeTool('search_messages', () => ({
        tool: 'search_messages' as const,
        ok: true,
        hits: [{ key: 'wxid_a:15', name: '项目群', time: '', snippet: '合同原文已确认。', source: 'msg' as const }],
      }))],
      runTurn,
      synthesize: () => { throw new Error('模型不可用') },
    }))

    expect(out.status).toBe('degraded')
    expect(out.synthesized).toBe(false)
    expect(out.synthesisError).toContain('模型不可用')
    expect(out.answer).toContain('合同原文已确认')
  })

  it('citationsFromEvidence 只给消息/知识库/事实生成引用', () => {
    const citations = citationsFromEvidence({
      items: [
        {
          evidenceId: 'msg:wxid_a:1',
          kind: 'hit',
          tool: 'search_messages',
          tools: ['search_messages'],
          source: 'msg',
          name: '项目群',
          time: '',
          snippet: '一条消息',
          key: 'wxid_a:1',
          locator: { type: 'message', username: 'wxid_a', localId: 1, key: 'wxid_a:1' },
        },
        {
          evidenceId: 'res:search_files:x',
          kind: 'hit',
          tool: 'search_files',
          tools: ['search_files'],
          source: 'resource',
          name: 'x.pdf',
          time: '',
          snippet: '资源',
          key: 'x',
          locator: { type: 'resource', tool: 'search_files', key: 'x' },
        },
      ],
      facts: [],
      status: 'ok',
      missing: [],
      stats: {
        count: 2,
        messages: 1,
        kb: 0,
        sessions: 1,
        candidateCount: 2,
        total: 2,
        hitCount: 2,
        factCount: 0,
        duplicateCount: 0,
        droppedByBudget: 0,
        truncated: false,
        snippetChars: 10,
        sourceCounts: { msg: 1, kb: 0, agg: 0, resource: 1 },
        toolCounts: { search_messages: 1, search_files: 1 },
        failedTools: [],
        attemptedTools: 2,
        successfulTools: 2,
      },
      assessment: { status: 'sufficient', sufficient: true, usableItems: 2, reason: '' },
    })

    expect(citations).toHaveLength(1)
    expect(citations[0]?.username).toBe('wxid_a')
  })
})
