/**
 * 模型名解析的判据（#20 第二个协作者：`gateway-models.ts`）。
 *
 * 这条红线出过实错（§7 F1）：网关这边自己拼了一遍优先级，宿主那边发请求时又拼一遍，
 * 两处漂移后向量库里记的是 `'default'`、实际发的是 `llm.json` 的值 ——
 * 「换没换嵌入模型」的判定读的恰恰是库里那串，于是换模型**永远不触发重建**，
 * 旧向量被当成新模型的用。修法是记账名必须由发送方（桥）给出。
 * 改前这段判断住在 986 行的 `GatewayCore` 里，要测就得起整个网关；
 * 搬成以桥为参数的纯函数后，三个角色 × 四种缺失组合可以逐格喂假桥。
 *
 * `resolveModelRef` **用真的**（只 mock 读库那一步）：这里要断的是「库级覆盖叠在全局之上」
 * 这个组合关系，把组合律本身 mock 掉就只剩下"函数被调用了"这种空断言。
 * @module gateway-model-resolution
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KbModelRole, ModelRef, ResolvedModel } from '../src/query/kb/model-config.ts'

const readers = vi.hoisted(() => ({
  loadRetrievalConfig: vi.fn(),
  readKbModelSettings: vi.fn(),
}))
vi.mock('../src/query/retrieval/config.ts', () => ({ loadRetrievalConfig: readers.loadRetrievalConfig }))
vi.mock('../src/query/kb/model-config.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/query/kb/model-config.ts')>()),
  readKbModelSettings: readers.readKbModelSettings,
}))

const { embedModelNameOf, globalModelNameOf, kbModelOf } = await import('../src/gateway-models.ts')

const DIR = '/tmp/gateway-models-spec-decrypted'
const settings = (over: Partial<{ chatRef: ModelRef; embedRef: ModelRef; rerankRef: ModelRef }> = {}) => ({
  chatRef: '', embedRef: '', rerankRef: '', ...over,
})

/** 三个来源凑一份 `ModelSource`。 */
const src = (bridge: unknown, host: unknown = {}) => ({ bridge, host, decryptedDir: DIR })

beforeEach(() => {
  readers.loadRetrievalConfig.mockReset().mockReturnValue({ embedding: { model: '' } })
  readers.readKbModelSettings.mockReset().mockReturnValue(settings())
})

describe('嵌入模型名：记账名必须由发送方给出', () => {
  it('桥提供了 `embeddingModelName` ⇒ 逐字用桥的回答，并把自己收到的 override 透传回去', () => {
    const seen: string[] = []
    const bridge = { embeddingModelName: (o?: string): string => { seen.push(String(o)); return 'vec-2-from-bridge' } }
    expect(embedModelNameOf(bridge, 'caller-picks')).toBe('vec-2-from-bridge')
    expect(seen, '没把 override 交给桥 ⇒ 桥那套优先级被绕过，正是 §7 F1 的形状').toEqual(['caller-picks'])
  })

  it('桥没提供该方法（测试桩/老版本）⇒ 退回 override 本身，不猜一个默认名', () => {
    expect(embedModelNameOf({ config: { model: 'chat-only' } }, 'explicit')).toBe('explicit')
    expect(embedModelNameOf({ config: { model: 'chat-only' } })).toBe('')
  })

  it('桥回答 null/undefined ⇒ 空串（不许变成 "null" / "undefined" 这种没人用得上的字符串）', () => {
    const asNull = { embeddingModelName: () => null as unknown as string }
    const asUndef = { embeddingModelName: () => undefined as unknown as string }
    expect(embedModelNameOf(asNull, 'x')).toBe('')
    expect(embedModelNameOf(asUndef, 'x')).toBe('')
  })

  it('桥是 undefined / 不是对象也不炸（宿主没注入 llm 时）', () => {
    expect(embedModelNameOf(undefined, 'fallback')).toBe('fallback')
    expect(globalModelNameOf(src(undefined), 'chat')).toBe('')
  })
})

describe('全局模型名：三个角色各走各的来源', () => {
  it('embed ⇒ 把检索配置里的 `embedding.model` 当 override 交给桥（自己不再拼优先级）', () => {
    readers.loadRetrievalConfig.mockReturnValue({ embedding: { model: 'from-retrieval-cfg' } })
    const asked: string[] = []
    const bridge = { embeddingModelName: (o?: string): string => { asked.push(String(o)); return 'bridge-final' } }
    expect(globalModelNameOf(src(bridge), 'embed' as KbModelRole)).toBe('bridge-final')
    expect(asked).toEqual(['from-retrieval-cfg'])
    expect(readers.loadRetrievalConfig).toHaveBeenCalledWith(DIR)
  })

  it('rerank ⇒ 优先桥的 `rerankModelName()`，没有才退到 `config.rerankModel`，都没有就是空串', () => {
    expect(globalModelNameOf(src({ rerankModelName: () => 'rr-bridge', config: { rerankModel: 'rr-config' } }), 'rerank' as KbModelRole))
      .toBe('rr-bridge')
    expect(globalModelNameOf(src({ config: { rerankModel: 'rr-config' } }), 'rerank' as KbModelRole)).toBe('rr-config')
    expect(globalModelNameOf(src({ config: { model: 'chat-1' } }), 'rerank' as KbModelRole)).toBe('')
  })

  it('rerank 的桥方法返回空串 ⇒ 不退回 config（空是桥的明确回答，它才知道实际会发什么）', () => {
    expect(globalModelNameOf(src({ rerankModelName: () => '', config: { rerankModel: 'rr-config' } }), 'rerank' as KbModelRole)).toBe('')
  })

  it('chat ⇒ 优先默认模型选择器的当前选择，没有才退到 `config.model`', () => {
    const host = { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'sel-chat' }) } }
    expect(globalModelNameOf(src({ config: { model: 'cfg-chat' } }, host), 'chat' as KbModelRole)).toBe('sel-chat')
    expect(globalModelNameOf(src({ config: { model: 'cfg-chat' } }, {}), 'chat' as KbModelRole)).toBe('cfg-chat')
    expect(globalModelNameOf(src({ config: {} }, {}), 'chat' as KbModelRole)).toBe('')
  })

  it('选择器存在但**明确回了空串** ⇒ 不再退回 config（这条 `??` 语义要钉住）', () => {
    const host = { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: '' }) } }
    expect(globalModelNameOf(src({ config: { model: 'cfg-chat' } }, host), 'chat' as KbModelRole)).toBe('')
  })

  it('选择器方法整个缺失 ⇒ 退到 config，而不是抛', () => {
    expect(globalModelNameOf(src({ config: { model: 'cfg-chat' } }, { agentDefaultModel: {} }), 'chat' as KbModelRole)).toBe('cfg-chat')
  })
})

describe('库级覆盖叠在全局之上', () => {
  it('三个角色各读各的引用字段（不许串位：chat 用 embedRef 会让库的设置悄悄失效）', () => {
    readers.readKbModelSettings.mockReturnValue(settings({ chatRef: 'm:chat-inline', embedRef: 'm:embed-inline', rerankRef: 'm:rerank-inline' }))
    const out: Record<string, ResolvedModel> = {
      chat: kbModelOf(src({ config: { model: 'g' } }), 7, 'chat' as KbModelRole),
      embed: kbModelOf(src({ config: { model: 'g' } }), 7, 'embed' as KbModelRole),
      rerank: kbModelOf(src({ config: { model: 'g' } }), 7, 'rerank' as KbModelRole),
    }
    expect(out.chat?.model).toBe('chat-inline')
    expect(out.embed?.model, '嵌入读了别的库级字段 ⇒ 向量库记的模型名与实际发的又不一致了').toBe('embed-inline')
    expect(out.rerank?.model).toBe('rerank-inline')
  })

  it('没有库级覆盖（空引用）⇒ 继承全局，并把来源如实标成 inherit 给界面与审计说话', () => {
    readers.readKbModelSettings.mockReturnValue(settings())
    const r = kbModelOf(src({ config: { model: 'g-chat' } }, {}), 3, 'chat' as KbModelRole)
    expect(r).toEqual({ model: 'g-chat', source: 'inherit', ref: '' })
  })

  it('库级写了 `m:` 但名字是空的 ⇒ 仍算继承（不许把 `m:` 当成一个模型名发出去）', () => {
    readers.readKbModelSettings.mockReturnValue(settings({ embedRef: 'm:' }))
    const r = kbModelOf(src({ embeddingModelName: () => 'g-embed' }), 2, 'embed' as KbModelRole)
    expect(r.model).toBe('g-embed')
    expect(r.source).toBe('inherit')
    expect(r.ref, '原始引用串要留着给界面回填下拉框').toBe('m:')
  })

  it('非法 kbId 由读库那一步兜（这里只保证：读到什么引用就按它解析，不额外缓存）', () => {
    readers.readKbModelSettings.mockReturnValue(settings({ chatRef: 'm:inline-for-bad-id' }))
    expect(kbModelOf(src({ config: { model: 'g' } }), -1, 'chat' as KbModelRole).model).toBe('inline-for-bad-id')
    expect(readers.readKbModelSettings).toHaveBeenLastCalledWith(DIR, -1)
    // 每次调用都重读：缓存住就会让库级覆盖比全局配置还难改（`llm.json` 那条链是"下一次生效"的语义）
    kbModelOf(src({ config: { model: 'g' } }), -1, 'chat' as KbModelRole)
    expect(readers.readKbModelSettings).toHaveBeenCalledTimes(2)
  })

  it('全局也没配 ⇒ 空串（调用方据此静默关闭该能力，而不是带着空 model 出网）', () => {
    readers.readKbModelSettings.mockReturnValue(settings())
    expect(kbModelOf(src({ config: {} }, {}), 1, 'chat' as KbModelRole).model).toBe('')
  })
})
