// @vitest-environment node
/**
 * 三个问答入口的回复契约（黑盒）。
 *
 * 这里不测内部函数，而是从生产编排入口 `askWithRuntime()` 跑完整链路：
 *   · 18 个「入口 × 异常」矩阵格都必须有可读回答，不能空串；
 *   · 状态与话术必须一致：failed 不能说成没数据，insufficient 不能说成故障；
 *   · 空结果、工具异常、超时、越权、参数错误、畸形结果都要可收敛；
 *   · 重复执行、并发执行、多轮继承与会话/知识库边界都不能互相污染。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import matrix from './acceptance-matrix.json'
import type { AskModelTurn, RunChatFn, RunChatTurnFn } from '../../../src/remotes/ask-run-chat.ts'
import type { AskRuntimeDeps, AskRuntimeOptions } from '../../../src/remotes/ask-runtime.ts'
import { askWithRuntime } from '../../../src/remotes/ask-runtime.ts'
import type {
  RetrievalTool,
  ToolContext,
  ToolHit,
  ToolName,
  ToolResult,
} from '../../../src/query/tools/types.ts'

const NOW = new Date('2026-10-22T10:00:00')

type ProfileId = 'wechat-ask' | 'session-ask' | 'clawbot-auto'
type Anomaly =
  | 'normal'
  | 'empty'
  | 'tool_error'
  | 'tool_timeout'
  | 'scope_violation'
  | 'invalid_arguments'
  | 'malformed_result'

interface MatrixCell {
  profile: ProfileId
  anomaly: Exclude<Anomaly, 'normal'>
  requestStatus: 'accepted' | 'blocked'
  answerStatus: string
  fallbackStatus: string | null
  statusSelector: 'answerStatus' | 'answerStatus-with-evidence-else-fallbackStatus'
  mustNotBeStatuses?: string[]
}

interface ProfileCase {
  options: AskRuntimeOptions
  tool: ToolName
  callArgs: Record<string, unknown>
  hit: ToolHit
}

const MESSAGE_HIT: ToolHit = {
  key: 'wxid_a:1',
  name: '项目群',
  time: '2026-10-20 10:00',
  snippet: '合同尾款下周一支付',
  source: 'msg',
}

const SESSION_HIT: ToolHit = {
  key: 'wxid_locked:1',
  name: '当前会话',
  time: '2026-10-20 10:00',
  snippet: '合同尾款下周一支付',
  source: 'msg',
}

const KB_HIT: ToolHit = {
  key: 'kb:7:1',
  name: '合同.pdf',
  time: '',
  snippet: '知识库里写明了验收标准',
  source: 'kb',
  trace: {
    kind: 'kb',
    kbId: 7,
    fileId: 1,
    chunkId: 1,
    ordinal: 0,
    page: 0,
    heading: '',
  },
}

const PROFILES: Record<ProfileId, ProfileCase> = {
  'wechat-ask': {
    options: { question: '合同尾款什么时候付？', source: 'ask' },
    tool: 'search_messages',
    callArgs: { keywords: ['合同尾款'] },
    hit: MESSAGE_HIT,
  },
  'session-ask': {
    options: {
      question: '合同尾款什么时候付？',
      source: 'session',
      username: 'wxid_locked',
    },
    tool: 'search_messages',
    callArgs: { keywords: ['合同尾款'] },
    hit: SESSION_HIT,
  },
  'clawbot-auto': {
    options: {
      question: '合同里写明的验收标准是什么？',
      source: 'auto',
      dataScope: 'kb-only',
      kbId: 7,
    },
    tool: 'search_kb',
    callArgs: { query: '验收标准' },
    hit: KB_HIT,
  },
}

const cells = matrix.matrix as MatrixCell[]

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

function turn(input: {
  text?: string
  calls?: Array<{ id: string; name: string; args: unknown }>
}): AskModelTurn {
  const blocks: AskModelTurn['blocks'] = []
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
  return input.messages.some(message =>
    message.content.some(block => block.type === 'tool-result'))
}

function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'answer-runtime-reply-contract' },
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeTool(profile: ProfileId, anomaly: Anomaly, onRun?: (ctx: ToolContext) => void): RetrievalTool {
  const base = PROFILES[profile]
  return fakeTool(base.tool, async (args, ctx) => {
    onRun?.(ctx)
    if (anomaly === 'tool_timeout') {
      await delay(80)
      return { tool: base.tool, ok: true, hits: [base.hit] }
    }
    if (anomaly === 'tool_error') {
      throw new Error('检索服务不可用')
    }
    if (anomaly === 'scope_violation' && profile === 'wechat-ask') {
      return {
        tool: base.tool,
        ok: false,
        error: '请求越过当前数据边界',
        errorCode: 'scope_violation',
        hits: [],
      }
    }
    if (anomaly === 'invalid_arguments') {
      return {
        tool: base.tool,
        ok: false,
        error: '缺少必填参数',
        errorCode: 'invalid_arguments',
        hits: [],
      }
    }
    if (anomaly === 'malformed_result') {
      return {
        tool: base.tool,
        ok: true,
        hits: [{ name: '缺少 key 与 snippet' }],
      } as unknown as ToolResult
    }
    if (anomaly === 'empty') {
      return { tool: base.tool, ok: true, hits: [] }
    }
    void args
    return { tool: base.tool, ok: true, hits: [base.hit] }
  })
}

function makeRunTurn(profile: ProfileId, anomaly: Anomaly): RunChatTurnFn {
  const base = PROFILES[profile]
  const args = anomaly === 'invalid_arguments'
    ? {}
    : anomaly === 'scope_violation' && profile === 'session-ask'
      ? { keywords: ['合同'], username: 'wxid_other' }
      : base.callArgs
  return (async (input: Parameters<RunChatTurnFn>[0]) => {
    if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
    return turn({
      calls: [{ id: `call_${profile}_${anomaly}`, name: base.tool, args }],
    })
  }) as RunChatTurnFn
}

function makeRunChat(profile: ProfileId): RunChatFn {
  return (async (system: string, userText: string) => {
    if (system.includes('意图分类器')) {
      return '{"kind":"lookup","confidence":0.98,"reason":"查找问题"}'
    }
    if (profile === 'clawbot-auto') {
      if (userText.includes('可参考的材料')) {
        return '这个我这边没查到相关的知识库内容。'
      }
      return '合同里写明了验收标准。'
    }
    return '合同尾款下周一支付 [1]'
  }) as RunChatFn
}

function makeDeps(
  profile: ProfileId,
  anomaly: Anomaly,
  extra: Partial<AskRuntimeDeps> = {},
  onRun?: (ctx: ToolContext) => void,
): AskRuntimeDeps {
  const tools = [makeTool(profile, anomaly, onRun)]
  if (profile === 'clawbot-auto') {
    tools.push(fakeTool('search_messages', () => ({
      tool: 'search_messages',
      ok: true,
      hits: [MESSAGE_HIT],
    })))
  }
  return {
    decryptedDir: '/fake',
    provider: 'test',
    model: 'test-model',
    privacyGate: (_feature, _counts, texts) => texts,
    tools,
    runTurn: makeRunTurn(profile, anomaly),
    runChat: makeRunChat(profile),
    now: NOW,
    ...(anomaly === 'tool_timeout'
      ? { toolDeadlineMs: 5, sleep: async () => undefined }
      : {}),
    ...extra,
  }
}

function optionsFor(profile: ProfileId, anomaly: Anomaly): AskRuntimeOptions {
  const base = PROFILES[profile].options
  if (profile === 'clawbot-auto' && anomaly === 'scope_violation') {
    return { ...base, kbId: undefined }
  }
  return { ...base }
}

async function runCell(profile: ProfileId, anomaly: Anomaly) {
  return askWithRuntime(
    makeDeps(profile, anomaly),
    optionsFor(profile, anomaly),
  )
}

function expectedStatus(cell: MatrixCell, actualStatus: string, hasEvidence: boolean): string | null {
  if (cell.statusSelector === 'answerStatus') return cell.answerStatus
  return hasEvidence ? cell.answerStatus : cell.fallbackStatus
}

describe('18 格异常矩阵：每个格都必须有可读回答且状态一致', () => {
  it.each(cells.map(cell => [`${cell.profile}/${cell.anomaly}`, cell] as const))(
    '%s',
    async (_label, cell) => {
      const result = await runCell(cell.profile, cell.anomaly)
      const answer = result.answer.trim()
      const hasEvidence = (result.evidence?.items.length ?? 0) > 0

      expect(answer, `${cell.profile}/${cell.anomaly} 返回了空回答`).not.toBe('')
      const requestStatus = result.status === 'blocked' ? 'blocked' : 'accepted'
      expect(requestStatus, `${cell.profile}/${cell.anomaly} 请求门禁状态不符`).toBe(cell.requestStatus)
      expect(result.status, `${cell.profile}/${cell.anomaly} 最终状态不符`).toBe(
        expectedStatus(cell, result.status, hasEvidence),
      )
      if (cell.mustNotBeStatuses) {
        expect(cell.mustNotBeStatuses).not.toContain(result.status)
      }
      if (result.status === 'blocked' || result.status === 'failed' || result.status === 'needs_clarification') {
        expect((result.statusReason ?? result.reason ?? '').trim()).not.toBe('')
      }
      expect(result.citations).toHaveLength(0)
      expect(result.resources).toHaveLength(0)

      if (cell.anomaly === 'empty') {
        expect(answer).toMatch(/没有检索到|没查到/)
        expect(answer).not.toContain('暂时失败')
      }
      if (cell.anomaly === 'tool_error' || cell.anomaly === 'tool_timeout' || cell.anomaly === 'malformed_result') {
        expect(answer).toContain('暂时失败')
        expect(answer).not.toContain('没有检索到')
        expect(result.evidence?.status).toBe('failed')
      }
      if (cell.anomaly === 'scope_violation') {
        expect(answer).toContain('没法开始检索')
        expect(result.evidence?.items).toEqual([])
      }
      if (cell.anomaly === 'invalid_arguments') {
        expect(answer).toMatch(/补充|检索条件|请问/)
        expect(result.toolCalls?.some(call => call.errorClass === 'invalid_arguments')).toBe(true)
      }
      if (cell.anomaly === 'tool_timeout') {
        expect(result.toolCalls?.some(call =>
          call.deadlineExceeded === true
          && call.attempts >= 2
          && call.errorClass === 'timeout')).toBe(true)
      }
      if (cell.anomaly === 'malformed_result') {
        expect(Number(result.evidence?.stats.malformedHits ?? 0)).toBeGreaterThan(0)
      }
    },
  )
})

describe('正常链路：三个入口都能稳定给出带依据的回答', () => {
  it.each(['wechat-ask', 'session-ask', 'clawbot-auto'] as const)(
    '%s 正常命中时可回答且保留引用/资源',
    async (profile) => {
      const result = await runCell(profile, 'normal')
      expect(result.status).toBe('ok')
      expect(result.answer.trim()).not.toBe('')
      expect(result.citations.length + (result.resources?.length ?? 0)).toBeGreaterThan(0)
      expect(result.answer).not.toContain('暂时失败')
      expect(result.basis).toContain('依据')
    },
  )

  it('同一问题顺序执行 20 次，状态与回答保持稳定', async () => {
    const results = []
    for (let index = 0; index < 20; index += 1) {
      results.push(await runCell('wechat-ask', 'normal'))
    }
    expect(new Set(results.map(result => result.status))).toEqual(new Set(['ok']))
    expect(new Set(results.map(result => result.answer))).toEqual(
      new Set(['合同尾款下周一支付 [1]']),
    )
    for (const result of results) {
      expect(result.answer.trim()).not.toBe('')
      expect(result.citations).toHaveLength(1)
    }
  })

  it('同一问题并发执行不串状态，也不产生空回复', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => runCell('wechat-ask', 'normal')),
    )
    expect(new Set(results.map(result => result.status))).toEqual(new Set(['ok']))
    expect(new Set(results.map(result => result.answer))).toEqual(
      new Set(['合同尾款下周一支付 [1]']),
    )
    expect(results.every(result => result.citations.length === 1)).toBe(true)
  })
})

describe('多轮上下文与边界', () => {
  it('「那上周呢」继承并递进上一轮的时间与会话范围', async () => {
    const scopes: ToolContext['scope'][] = []
    const runTurn = (async (input: Parameters<RunChatTurnFn>[0]) => {
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({
        calls: [{ id: 'call_week', name: 'search_messages', args: { keywords: ['合同'] } }],
      })
    }) as RunChatTurnFn
    const result = await askWithRuntime(
      makeDeps('wechat-ask', 'normal', {
        runTurn,
        tools: [fakeTool('search_messages', (_args, ctx) => {
          scopes.push(ctx.scope)
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
        runChat: (async (system: string) => (
          system.includes('意图分类器')
            ? '{"kind":"timeline","confidence":0.98,"reason":"时间问题"}'
            : '上周交付已经完成 [1]'
        )) as RunChatFn,
      }),
      {
        question: '那上周呢？',
        source: 'ask',
        threadState: {
          activeSession: 'team@chatroom',
          lastTimeRange: { from: '2026-10-14', to: '2026-10-14' },
          lastTimeGranularity: 'week',
          lastTimeHard: false,
          turns: 1,
        },
      },
    )

    expect(scopes[0]).toMatchObject({ username: 'team@chatroom', from: '2026-10-07', to: '2026-10-07' })
    expect(result.appliedThreadState?.from).toBe('2026-10-07')
    expect(result.appliedThreadState?.reason.join('\n')).toContain('时间递进')
    expect(result.threadState?.lastTimeRange).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(result.threadState?.history?.at(-1)?.content).toBe(result.answer)
    expect(result.answer.trim()).not.toBe('')
  })

  it('会话内问答重复执行只查锁定会话，不混入其他会话', async () => {
    const seen: Array<string | undefined> = []
    for (let index = 0; index < 10; index += 1) {
      const result = await askWithRuntime(
        makeDeps('session-ask', 'normal', {
          tools: [fakeTool('search_messages', (_args, ctx) => {
            seen.push(ctx.scope?.username)
            return { tool: 'search_messages', ok: true, hits: [SESSION_HIT] }
          })],
        }),
        PROFILES['session-ask'].options,
      )
      expect(result.status).toBe('ok')
      expect(result.citations.every(citation => citation.username === 'wxid_locked')).toBe(true)
      expect(result.answer).not.toContain('wxid_other')
    }
    expect(seen).toEqual(Array.from({ length: 10 }, () => 'wxid_locked'))
  })

  it('ClawBot 只向模型暴露 search_kb，消息工具不会进入调用清单', async () => {
    const schemas: string[][] = []
    const runTurn = (async (input: Parameters<RunChatTurnFn>[0]) => {
      schemas.push((input.tools ?? []).map(schema => schema.name))
      if (hasToolResult(input)) return turn({ text: '工具阶段完成。' })
      return turn({ calls: [{ id: 'call_kb', name: 'search_kb', args: { query: '验收标准' } }] })
    }) as RunChatTurnFn
    const result = await askWithRuntime(
      makeDeps('clawbot-auto', 'normal', { runTurn }),
      PROFILES['clawbot-auto'].options,
    )

    expect(result.status).toBe('ok')
    expect(schemas.length).toBeGreaterThan(0)
    expect(schemas.every(names => names.length === 1 && names[0] === 'search_kb')).toBe(true)
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0]?.source).toBe('kb')
  })
})

describe('模型与综合生成异常兜底', () => {
  it('工具选择阶段直接抛错时仍返回 failed 回复，而不是整轮 reject', async () => {
    const result = await askWithRuntime(
      makeDeps('wechat-ask', 'normal', {
        runTurn: (async () => {
          throw new Error('模型服务 503')
        }) as RunChatTurnFn,
      }),
      PROFILES['wechat-ask'].options,
    )

    expect(result.status).toBe('failed')
    expect(result.answer).toContain('暂时失败')
    expect(result.answer.trim()).not.toBe('')
    expect(result.reason).toContain('503')
    expect(result.evidence?.status).toBe('failed')
  })

  it('用户主动停止时继续抛 ASK_CANCELED，不能被失败兜底吞掉', async () => {
    const deps = makeDeps('wechat-ask', 'normal', {
      runTurn: (async () => {
        throw Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
      }) as RunChatTurnFn,
    })
    await expect(askWithRuntime(deps, PROFILES['wechat-ask'].options))
      .rejects
      .toMatchObject({ code: 'ASK_CANCELED' })
  })

  it('综合生成返回空白时降级为证据文本，不返回空回答', async () => {
    const result = await askWithRuntime(
      makeDeps('wechat-ask', 'normal', {
        synthesize: async () => '   ',
      }),
      PROFILES['wechat-ask'].options,
    )

    expect(result.status).toBe('degraded')
    expect(result.answer).toContain('合同尾款下周一支付')
    expect(result.answer.trim()).not.toBe('')
    expect(result.citations).toHaveLength(1)
    expect(result.statusReason).toContain('空文本')
  })

  it('综合生成抛错时保留证据与引用，并给出可读降级回答', async () => {
    const result = await askWithRuntime(
      makeDeps('wechat-ask', 'normal', {
        synthesize: async () => {
          throw new Error('模型不可用')
        },
      }),
      PROFILES['wechat-ask'].options,
    )

    expect(result.status).toBe('degraded')
    expect(result.answer).toContain('合同尾款下周一支付')
    expect(result.answer.trim()).not.toBe('')
    expect(result.citations).toHaveLength(1)
    expect(result.synthesisError).toContain('模型不可用')
  })

  it('ClawBot 检索失败时不再走普通聊天综合兜底', async () => {
    const synthesize = vi.fn(async () => '不应采用的聊天回答')
    const result = await askWithRuntime(
      makeDeps('clawbot-auto', 'tool_error', { synthesize }),
      PROFILES['clawbot-auto'].options,
    )

    expect(synthesize).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.answer).toContain('暂时失败')
    expect(result.answer.trim()).not.toBe('')
  })

  it('ClawBot 综合生成抛错时仍返回知识库范围的可读兜底', async () => {
    const result = await askWithRuntime(
      makeDeps('clawbot-auto', 'empty', {
        synthesize: async () => {
          throw new Error('模型不可用')
        },
      }),
      PROFILES['clawbot-auto'].options,
    )

    expect(result.status).toBe('insufficient')
    expect(result.answer.trim()).not.toBe('')
    expect(result.synthesisError).toContain('模型不可用')
    expect(result.answer).toMatch(/没查到|没有检索到/)
  })
})
