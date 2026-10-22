// @vitest-environment node
/**
 * ClawBot 自动回复的边界契约（黑盒）。
 *
 * 通过 mock `createClawbotRemotes` 截获网关装配给自动回复的 `ask` 闭包，
 * 不启动 iLink、不建 ClawBot 库、不联网。断言的是无人值守出网的硬边界：
 *   · 每次 ask 固定 `source='auto'` 与 `dataScope='kb-only'`；
 *   · kbId/prompt/history/images 按约定透传或省略；
 *   · 上游抛错一律转成 `{ ok:false }`，不向长轮询循环冒泡。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLAWBOT_SYSTEM_PROMPT } from '../../../src/query/clawbot/clawbot-prompt.ts'
import type { ClawbotAskContext, ClawbotAskFn } from '../../../src/query/clawbot/clawbot-auto-reply.ts'

const captured = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../src/remotes/clawbot.ts', () => ({
  createClawbotRemotes: (input: Record<string, unknown>) => {
    captured.inputs.push(input)
    return {
      ensureClawbotChannel: () => {},
      listClawbotInstances: () => ({}),
      createClawbotInstance: () => ({}),
      deleteClawbotInstance: () => ({}),
      setClawbotInstanceConfig: () => ({}),
      renameClawbotInstance: () => ({}),
      getClawbotBinding: () => ({}),
      createClawbotBindQr: async () => ({}),
      getClawbotBindState: async () => ({}),
      unbindClawbot: () => ({}),
      listClawbotMessages: () => ({}),
      clearClawbotMessages: () => ({}),
      checkClawbotEnv: () => ({}),
      sendClawbotMessage: async () => ({}),
      getClawbotMedia: async () => ({}),
    }
  },
}))

import { GatewayClawbot } from '../../../src/gateway-clawbot.ts'

interface AskCall {
  question: string
  source?: string
  dataScope?: string
  kbId?: number
  systemPromptOverride?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  images?: Array<{ data: string; mediaType: string; name?: string }>
}

interface GatewayHarness {
  ask: ClawbotAskFn
  askWechat: ReturnType<typeof vi.fn>
  ops: Array<{ category: string, action: string, status: string, target: string, detail: string }>
}

function mountGateway(answer: string | Error | Record<string, unknown>, usage?: unknown): GatewayHarness {
  const askWechat = vi.fn(async (_options: AskCall) => {
    if (answer instanceof Error) throw answer
    if (typeof answer === 'object') return answer
    return { answer, ...(usage === undefined ? {} : { usage }) }
  })
  const ops: GatewayHarness['ops'] = []
  const fake = {
    _dirs: { decrypted: 'C:/temp/acceptance-clawbot' },
    _clawbotRemotes: undefined,
    askDeepRemotes: () => ({ askWechat }),
    op: (category: string, action: string, status: string, target: string, detail: string) => {
      ops.push({ category, action, status, target, detail })
    },
    _ctx: { emit: () => {} },
  }
  const mount = (GatewayClawbot.prototype as unknown as {
    clawbotRemotes: (this: typeof fake) => unknown
  }).clawbotRemotes
  mount.call(fake)
  const input = captured.inputs.at(-1)
  const ask = input?.['ask']
  if (typeof ask !== 'function') throw new Error('网关没有把 ask 能力注入 ClawBot remotes')
  return { ask: ask as ClawbotAskFn, askWechat, ops }
}

afterEach(() => {
  captured.inputs.length = 0
})

describe('ClawBot ask 闭包：数据面固定 kb-only', () => {
  it('kbId=null 时在调用上游前就拒绝，绝不以无库模式继续', async () => {
    const harness = mountGateway({
      answer: '在的，有事你说。',
      status: 'ok',
      citations: [{ index: 1, evidenceId: 'kb:7:1' }],
    })
    const result = await harness.ask(3, '在吗', null, '')

    // 没有选择知识库时，连模型/检索管道都不该进入 —— 无库不是一种运行模式。
    expect(result.ok).toBe(false)
    expect(result.error).toContain('自动回复需要选择知识库')
    expect(harness.askWechat, 'kbId=null 仍调用上游 = 允许无库纯聊天路径').not.toHaveBeenCalled()
    expect(harness.ops.at(-1)).toMatchObject({
      category: 'clawbot', action: 'clawbot_auto_reply', status: 'fail', target: 'slot=3',
    })
    expect(harness.ops.at(-1)?.detail).toContain('自动回复需要选择知识库')
  })

  it('kbId 与自定义提示词原样透传，history/images 一并带入', async () => {
    const harness = mountGateway({
      answer: '合同里写的是 12000 元。',
      status: 'ok',
      citations: [{ index: 1, evidenceId: 'kb:7:2' }],
    })
    const context: ClawbotAskContext = {
      history: [
        { role: 'user', content: '[图片]' },
        { role: 'assistant', content: '我看看' },
      ],
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png', name: 'wx-image-1' }],
    }
    await harness.ask(1, '合同验收款多少', 7, '  你是客服小助手  ', context)

    const options = harness.askWechat.mock.calls[0]?.[0] as AskCall | undefined
    expect(options?.kbId).toBe(7)
    // 非空提示词按原文透传（当前闭包只判断 trim 后是否为空，不改写用户内容）。
    expect(options?.systemPromptOverride).toBe('  你是客服小助手  ')
    expect(options?.history).toEqual(context.history)
    expect(options?.images).toEqual(context.images)
    expect(options?.source).toBe('auto')
    expect(options?.dataScope).toBe('kb-only')
  })

  it('空提示词回落到内置默认值，而不是“没有提示词”', async () => {
    const harness = mountGateway({
      answer: '好的。',
      status: 'ok',
      citations: [{ index: 1, evidenceId: 'kb:7:3' }],
    })
    await harness.ask(1, '你好', 7, '   ')
    const options = harness.askWechat.mock.calls[0]?.[0] as AskCall | undefined
    expect(options?.systemPromptOverride).toBe(DEFAULT_CLAWBOT_SYSTEM_PROMPT)
  })

  it('上游抛错转成 ok:false，不向自动回复循环冒泡', async () => {
    const harness = mountGateway(new Error('上游 503'))
    const result = await harness.ask(1, '在吗', 7, '')
    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
    expect(result.error).toContain('上游 503')
  })

  it.each([
    ['blocked', '缺少知识库'],
    ['failed', '检索工具全部超时'],
  ])('运行状态 %s 不当作可发送成功回复，并记录可诊断原因', async (status, reason) => {
    const harness = mountGateway({
      answer: '这条正文不应被发送',
      status,
      statusReason: reason,
    })
    const result = await harness.ask(1, '合同验收款多少', 7, '')

    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
    expect(result.error).toContain(status)
    expect(result.error).toContain(reason)
    expect(harness.ops.at(-1)).toMatchObject({
      category: 'clawbot', action: 'clawbot_auto_reply', status: 'fail', target: 'slot=1',
    })
    expect(harness.ops.at(-1)?.detail).toContain(status)
    expect(harness.ops.at(-1)?.detail).toContain(reason)
  })

  it.each(['insufficient', 'needs_clarification'] as const)(
    '运行状态 %s 不发送，并记录可诊断原因',
    async (status) => {
      const harness = mountGateway({
        answer: '请问你指的是哪位联系人？',
        status,
        statusReason: '对象不明确',
        citations: [{ index: 1, evidenceId: 'kb:7:4' }],
      })
      const result = await harness.ask(1, '他说的那个呢', 7, '')

      expect(result.ok).toBe(false)
      expect(result.answer).toBe('')
      expect(result.error).toContain(status)
      expect(harness.ops.at(-1)).toMatchObject({
        category: 'clawbot', action: 'clawbot_auto_reply', status: 'fail', target: 'slot=1',
      })
      expect(harness.ops.at(-1)?.detail).toContain(status)
      expect(harness.ops.at(-1)?.detail).toContain('对象不明确')
    },
  )

  it('运行状态 degraded 可发送，但审计明确记录降级，不伪装成完整检索', async () => {
    const harness = mountGateway({
      answer: '根据知识库内容整理如下。',
      status: 'degraded',
      statusReason: '部分工具失败，证据可能不完整',
      citations: [{ index: 1, evidenceId: 'kb:7:5' }],
      grounding: { checked: 1, unsupported: [], cited: 1, repaired: false },
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result).toMatchObject({ ok: true, answer: '根据知识库内容整理如下。', status: 'degraded' })
    expect(result.sendDecision).toMatchObject({ send: true })
    expect(result.citations).toHaveLength(1)
    expect(harness.ops.at(-1)).toMatchObject({
      category: 'clawbot', action: 'clawbot_auto_reply', status: 'ok', target: 'slot=1',
    })
    expect(harness.ops.at(-1)?.detail).toContain('degraded')
    expect(harness.ops.at(-1)?.detail).toContain('证据可能不完整')
  })

  it('综合生成失败时即使有引用也不发送兜底文本', async () => {
    const harness = mountGateway({
      answer: '证据兜底文本不应出网',
      status: 'degraded',
      synthesisError: '模型不可用',
      citations: [{ index: 1, evidenceId: 'kb:7:9' }],
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
    expect(result.error).toContain('综合生成失败')
    expect(result.error).toContain('模型不可用')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('degraded 缺少接地快照时不发送，不能把未核对内容当成可发送回复', async () => {
    const harness = mountGateway({
      answer: '无法确认这段内容是否经过核对',
      status: 'degraded',
      citations: [{ index: 1, evidenceId: 'kb:7:10' }],
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
    expect(result.error).toContain('缺少接地核对')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('运行状态 ok 保持原有成功路径，不额外写状态审计', async () => {
    const harness = mountGateway({
      answer: '可以。',
      status: 'ok',
      citations: [{ index: 1, evidenceId: 'kb:7:6' }],
    })
    const result = await harness.ask(1, '在吗', 7, '')

    expect(result).toMatchObject({ ok: true, answer: '可以。', status: 'ok' })
    expect(result.sendDecision).toEqual({ send: true })
    expect(harness.ops).toEqual([])
  })

  it('未知运行状态按失败处理，不把新状态误当成功发送', async () => {
    const harness = mountGateway({ answer: '不应发送', status: 'future_state' })
    const result = await harness.ask(1, '在吗', 7, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('send:false 时仍保留工具调用、证据、引用、资源和接地详情', async () => {
    const toolCalls = [{ index: 0, name: 'kb_search', ok: true }]
    const evidence = { items: [{ evidenceId: 'kb:7:11', snippet: '合同验收款为 12000 元' }] }
    const citations = [{ index: 1, evidenceId: 'kb:7:11' }]
    const resources = [{ evidenceId: 'kb:7:11', tool: 'kb_search', key: 'chunk:11' }]
    const grounding = { checked: 1, unsupported: [], cited: 1, repaired: false }
    const harness = mountGateway({
      answer: '合同验收款是 12000 元。',
      status: 'ok',
      citations,
      toolCalls,
      evidence,
      resources,
      grounding,
    })
    const result = await harness.ask(1, '合同验收款多少', 8, '')

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'send_decision_rejected',
      sendDecision: { send: false, errorCode: 'send_decision_rejected' },
      toolCalls,
      evidence,
      citations,
      resources,
      grounding,
    })
    expect(result.error).toContain('知识库')
  })

  it('缺失运行状态默认拒绝，不能把旧响应当成可发送结果', async () => {
    const harness = mountGateway({ answer: '旧响应正文' })
    const result = await harness.ask(1, '在吗', 7, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('运行状态缺失')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('withheld 结果即使状态 ok 也不发送', async () => {
    const harness = mountGateway({
      answer: '模型内容未通过核对',
      status: 'ok',
      withheld: true,
      citations: [{ index: 1, evidenceId: 'kb:7:7' }],
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('未通过接地核对')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('有引用但回答未实际使用材料时仍拒绝发送', async () => {
    const harness = mountGateway({
      answer: '可以，我稍后回复你。',
      status: 'ok',
      citations: [{ index: 1, evidenceId: 'kb:7:9' }],
      evidenceUsed: false,
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有实际使用知识库材料')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it.each([
    ['ok 无引用', { answer: '无引用', status: 'ok', citations: [] }, '没有可追溯'],
    ['degraded 无引用', { answer: '无引用', status: 'degraded', citations: [] }, '没有可追溯'],
    ['degraded 有未核实数值', {
      answer: '有未核实数值',
      status: 'degraded',
      citations: [{ index: 1, evidenceId: 'kb:7:8' }],
      grounding: { unsupported: ['12000'] },
    }, '未核实数值'],
  ] as const)('%s 默认拒绝', async (_label, payload, expected) => {
    const harness = mountGateway(payload)
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain(expected)
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it.each([
    ['消息证据混入', { index: 1, source: 'msg', evidenceId: 'msg:wxid_a:1' }],
    ['其他知识库', { index: 1, source: 'kb', evidenceId: 'kb:8:1', kb: { kbId: 8, chunkId: 1 } }],
    ['非规范引用', { index: 1, source: 'kb', evidenceId: 'kb:unstable' }],
  ] as const)('知识库引用校验：%s 时拒绝出网', async (_label, citation) => {
    const harness = mountGateway({
      answer: '这条正文不应出网',
      status: 'ok',
      citations: [citation],
    })
    const result = await harness.ask(1, '合同要点', 7, '')

    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
    expect(result.error).toContain('知识库')
    expect(harness.ops.at(-1)).toMatchObject({ status: 'fail' })
  })

  it('未选择知识库时即使有引用也不出网', async () => {
    const harness = mountGateway({
      answer: '不应发送',
      status: 'ok',
      citations: [{ index: 1, source: 'kb', evidenceId: 'kb:7:1' }],
    })
    const result = await harness.ask(1, '在吗', null, '')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('未选择知识库')
  })
})
