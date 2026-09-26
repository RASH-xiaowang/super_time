/**
 * LLM 工厂的判据（#20 第三个协作者：`gateway-llm-factory.ts`）。
 *
 * 这一份是"组合而非继承"那一步真正想要换来的东西：三条出站纪律原先住在 `GatewayCore` 里，
 * 要验一次"拦截生效时到底有没有出网"就得**起一个真网关**（既有覆盖正是那个量级，
 * 见 `outbound-gates.spec.ts`）。现在依赖是显式参数，假桥 + 假闸门就能把每条纪律单独钉住，
 * 而且**不需要任何 vi.mock**。
 *
 * 三条纪律（来自第 59 轮，文件头也写着）：
 *   ① 拦截判在任何出网之前（早于"没配模型"那类早退）；
 *   ② 一批要一起过闸（只 gate 查询词 = 把 N 条正文裸发出去，审计还会记成"已脱敏"）；
 *   ③ 失败抛出，不吞（降级由调用方决定并说明原因）。
 * @module gateway-llm-factory
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmFactoryDeps } from '../src/gateway-llm-factory.ts'
import { EXTRACT_SYSTEM, makeChatAskerOf, makeEmbedFnOf, makeRerankFnOf } from '../src/gateway-llm-factory.ts'
import type { PrivacyGateResult } from '../src/gateway-privacy.ts'
import type { ResolvedModel } from '../src/query/kb/model-config.ts'

/** 假闸门：默认放行，但把每批文本都"脱敏"一遍 —— 判据要能看出发出去的是副本而不是原文。 */
const REDACTED = (t: string): string => t.replace(/@\d{3}/g, '〔用户〕')

const calls: { blocked: string[]; gate: Array<{ feature: string; stats: unknown; texts: string[] }> } = { blocked: [], gate: [] }

let blockedReturn: string | null = null
let gateReturn: PrivacyGateResult = { ok: true, texts: [] }

function deps(over: Partial<LlmFactoryDeps> = {}): LlmFactoryDeps {
  return {
    llm: {},
    host: {},
    kbModel: () => ({ model: 'chat-model-from-kb', source: 'inherit', ref: '' }),
    privacyBlocked: (feature: string) => {
      calls.blocked.push(feature)
      return blockedReturn
    },
    privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => {
      calls.gate.push({ feature, stats, texts })
      return gateReturn
    },
    ...over,
  }
}

/** 把 `GenerateOptions.messages` 里所有文本拼出来，方便断"发出去的到底是哪份文本"。 */
function sentText(opts: unknown): string {
  const o = opts as { messages?: Array<{ content?: Array<{ text?: string }> }> }
  return (o.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('|')
}

beforeEach(() => {
  calls.blocked = []
  calls.gate = []
  blockedReturn = null
  gateReturn = { ok: true, texts: [] }
})

describe('makeEmbedFnOf：embedding 走与 chat 同一道闸', () => {
  it('桥没提供 embed ⇒ undefined（调用方报「通道不可用」，而不是发了再失败）', () => {
    expect(makeEmbedFnOf(deps(), 'v1', 'ask_embed')).toBeUndefined()
  })

  it('发出去的是**闸门返回的副本**，不是原文', async () => {
    const embed = vi.fn(async (_texts: string[], _opts?: { model?: string }): Promise<number[][]> => [[0.1]])
    gateReturn = { ok: true, texts: ['联系 〔用户〕 处理'] }
    const fn = makeEmbedFnOf(deps({ llm: { embed } }), 'v1', 'kb_embed')
    await fn!(['联系 @123 处理'])
    expect(embed.mock.calls[0]?.[0], '把原文交给桥 ⇒ 开了脱敏也没生效').toEqual(['联系 〔用户〕 处理'])
  })

  it('模型名为空 ⇒ 不带 `{model}` 选项（空串会被桥当成一个真实模型名）', async () => {
    const embed = vi.fn(async (_texts: string[], _opts?: { model?: string }): Promise<number[][]> => [[0]])
    gateReturn = { ok: true, texts: ['a'] }
    await makeEmbedFnOf(deps({ llm: { embed } }), '', 'ask_embed')!(['a'])
    expect(embed.mock.calls[0]?.[1]).toBeUndefined()
    await makeEmbedFnOf(deps({ llm: { embed } }), 'vec-2', 'ask_embed')!(['a'])
    expect(embed.mock.calls[1]?.[1]).toEqual({ model: 'vec-2' })
  })

  it('审计的功能名必须原样带过去（三种数据范围分不开 = 用户只对其中一类给过同意也看不出来）', async () => {
    const embed = vi.fn(async (_texts: string[], _opts?: { model?: string }): Promise<number[][]> => [[0]])
    gateReturn = { ok: true, texts: ['x'] }
    for (const feature of ['ask_embed', 'kb_embed', 'kb_link_suggest'] as const) {
      await makeEmbedFnOf(deps({ llm: { embed } }), '', feature)!(['x'])
    }
    expect(calls.gate.map((g) => g.feature)).toEqual(['ask_embed', 'kb_embed', 'kb_link_suggest'])
    expect(calls.gate.every((g) => (g.stats as { messages: number }).messages === 1), '条数没按实际批量记').toBe(true)
  })

  it('闸门拒绝 ⇒ 抛出且桥一次都没被调（纪律③：不吞失败）', async () => {
    const embed = vi.fn()
    gateReturn = { ok: false, error: '隐私设置已开启「出站拦截」' }
    const fn = makeEmbedFnOf(deps({ llm: { embed } }), 'v', 'ask_embed')!
    await expect(fn(['a'])).rejects.toThrow('出站拦截')
    expect(embed).not.toHaveBeenCalled()
  })
})

describe('makeChatAskerOf：拦截判在出网之前', () => {
  const streamBridge = () => {
    const opts: unknown[] = []
    return {
      opts,
      llm: {
        stream: (o: unknown): AsyncGenerator<{ type: string; index: number; text: string }> => {
          opts.push(o)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: '  · 要点一\n· 要点二  ' }
          })()
        },
      },
    }
  }

  it('桥不支持流式 ⇒ undefined', () => {
    expect(makeChatAskerOf(deps({ llm: {} }), 1, 'ask_entities')).toBeUndefined()
  })

  it('拦截开着 ⇒ 抛出，而且**连闸门都没走到**（纪律①：早退分支会把「拦截生效」盖掉）', async () => {
    blockedReturn = '隐私设置已开启「出站拦截」，已阻止「ask_entities」把数据发送给模型'
    const { llm, opts } = streamBridge()
    const fn = makeChatAskerOf(deps({ llm }), 3, 'ask_entities')!
    await expect(fn('提示词')).rejects.toThrow('出站拦截')
    expect(opts, '拦截之后还发了请求').toHaveLength(0)
    expect(calls.gate, '被拦截的这批不该再过一次闸、写一条审计').toEqual([])
    expect(calls.blocked).toEqual(['ask_entities'])
  })

  it('模型名取自库级解析、provider 取自默认选择器', async () => {
    const { llm, opts } = streamBridge()
    gateReturn = { ok: true, texts: ['提示词'] }
    const d = deps({
      llm,
      host: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'g' }) } },
      kbModel: () => ({ model: 'kb-chat-override', source: 'inline', ref: 'm:kb-chat-override' }),
    })
    await makeChatAskerOf(d, 9, 'ask_entities')!('提示词')
    const o = opts[0] as { model?: string; provider?: string }
    expect(o.model, '没读库级覆盖 ⇒ 这个库配的模型被全局的顶掉').toBe('kb-chat-override')
    expect(o.provider).toBe('deepseek')
  })

  it('发出去的是闸门副本，且带的是"抽取器"口径的 system 与 500 token 上界', async () => {
    const { llm, opts } = streamBridge()
    gateReturn = { ok: true, texts: ['联系 〔用户〕 处理'] }
    await makeChatAskerOf(deps({ llm }), 1, 'kb_link_suggest')!('联系 @123 处理')
    const o = opts[0] as { system?: string; maxTokens?: number }
    expect(sentText(o)).toBe('联系 〔用户〕 处理')
    expect(o.system).toBe(EXTRACT_SYSTEM)
    expect(o.maxTokens).toBe(500)
  })

  it('收流文本去掉首尾空白（调用方按行解析，多个空行会被当成一条空记录）', async () => {
    const { llm } = streamBridge()
    gateReturn = { ok: true, texts: ['p'] }
    const out = await makeChatAskerOf(deps({ llm }), 1, 'ask_entities')!('p')
    expect(out).toBe('· 要点一\n· 要点二')
  })

  it('闸门拒绝 ⇒ 抛出且不发请求', async () => {
    const { llm, opts } = streamBridge()
    gateReturn = { ok: false, error: '读到隐私设置失败' }
    await expect(makeChatAskerOf(deps({ llm }), 1, 'ask_entities')!('p')).rejects.toThrow('读到隐私设置失败')
    expect(opts).toHaveLength(0)
  })
})

describe('makeRerankFnOf：一批文档必须一起过闸', () => {
  const rerankBridge = () => {
    const seen: Array<{ q: string; docs: string[]; o?: { model?: string } }> = []
    return {
      seen,
      llm: {
        rerank: async (q: string, docs: string[], o?: { model?: string }): Promise<number[]> => {
          seen.push({ q, docs, o })
          return [0, 1]
        },
      },
    }
  }

  it('桥没提供 rerank ⇒ undefined（管道跳过这一段，而不是报错）', () => {
    expect(makeRerankFnOf(deps(), 1)).toBeUndefined()
  })

  it('没配 rerank 模型 ⇒ undefined（不许带着空 model 出网）', () => {
    const d = deps({ llm: { rerank: async () => [] }, kbModel: () => ({ model: '', source: 'inherit', ref: '' }) })
    expect(makeRerankFnOf(d, 1)).toBeUndefined()
  })

  it('查询词与**全部候选**一起过闸（纪律②），审计按文档条数记账', async () => {
    const { llm, seen } = rerankBridge()
    gateReturn = { ok: true, texts: ['q〔用户〕', 'd1〔用户〕', 'd2〔用户〕'] }
    const fn = makeRerankFnOf(deps({ llm }), 4)!
    await fn('q @999', ['d1 @999', 'd2 @999'])
    expect(calls.gate[0]?.texts, '只 gate 查询词 ⇒ 两条正文裸发出去，而审计记成「已脱敏」').toEqual(['q @999', 'd1 @999', 'd2 @999'])
    expect(calls.gate[0]?.stats).toEqual({ sessions: 0, messages: 2 })
    expect(calls.gate[0]?.feature).toBe('ask_rerank')
    expect(seen[0]).toEqual({ q: 'q〔用户〕', docs: ['d1〔用户〕', 'd2〔用户〕'], o: { model: 'chat-model-from-kb' } })
  })

  it('库级 rerank 覆盖生效（读的是 rerank 角色，不是 chat）', async () => {
    const { llm } = rerankBridge()
    gateReturn = { ok: true, texts: ['q'] }
    const kbModel = vi.fn((): ResolvedModel => ({ model: 'rr-override', source: 'inline', ref: 'm:rr-override' }))
    await makeRerankFnOf(deps({ llm, kbModel }), 6)!('q', [])
    expect(kbModel).toHaveBeenCalledWith(6, 'rerank')
  })

  it('拦截开着 ⇒ 抛出且桥没被调', async () => {
    blockedReturn = '隐私设置已开启「出站拦截」，已阻止「ask_rerank」把数据发送给模型'
    const { llm, seen } = rerankBridge()
    await expect(makeRerankFnOf(deps({ llm }), 1)!('q', ['a'])).rejects.toThrow('出站拦截')
    expect(seen).toHaveLength(0)
  })
})
