/**
 * 知识库**向量索引**的网关级验收（`docs/KB-MODEL-CONFIG.md` 的 V1 + V3）。
 *
 * 为什么这一份要打在 `WechatDataGateway` 上而不是只测 `kb-vectors.ts`：
 * P0 修的那三条缺陷全部长在**接线**上，纯模块测试看不见 ——
 *   ① 记账名与实际发送名来自两条链（`'default'` vs llm.json 的值），
 *      模块测试两边都拿同一个字符串喂，永远测不出漂移；
 *   ② 「换模型不触发重建」的现场是**问过一轮之后换**，要有 `getKbVectorIndex` 这一层才看得见；
 *   ③ `searchKb` 的降级说明以前是硬编码，只有走网关才会走到那段判定。
 *
 * LLM 用桩（与 `kb-summary.spec.ts` 同一技术）：`embed.calls` 存着每一次真实发出去的文本，
 * 所以「没出网」是可断言的（`calls.length === 0`），而不是「看起来没报错」。
 * 桩同时提供 `embeddingModelName()` —— 那正是 P0-2 要求宿主给出的「实际会用哪个模型」，
 * 换模型这个动作在测试里就是**改桩的返回值**，与真机换 `llm.json` 等价。
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { readPrivacySettings, writePrivacySettings } from '../src/query/privacy-audit.ts'
import { kbFilesDbPath } from '../src/query/kb-paths.ts'
import { at } from '../../tests/helpers/strict-index.ts'

let root = ''
let decrypted = ''
let srcDir = ''

/** 向量桩：字符直方图向量；`model` 可以中途改，用来模拟「换嵌入模型」。 */
interface EmbedStub {
  calls: string[]
  model: string
  fn: (texts: string[], opts?: { model?: string }) => Promise<number[][]>
  embeddingModelName: () => string
  embed: (texts: string[], opts?: { model?: string }) => Promise<number[][]>
}

function stubEmbed(dim = 24): EmbedStub {
  const stub: EmbedStub = {
    calls: [],
    model: 'stub-embed-v1',
    fn: async (texts: string[]): Promise<number[][]> => {
      stub.calls.push(...texts)
      return texts.map(t => {
        const v = new Array<number>(dim).fill(0)
        for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % dim; v[k] = (v[k] ?? 0) + 1 }
        return v
      })
    },
    embeddingModelName: () => stub.model,
    embed: (texts: string[], opts?: { model?: string }): Promise<number[][]> => stub.fn(texts, opts),
  }
  return stub
}

function fakeCtx(stub: EmbedStub): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: () => {},
    llm: { stream: async function* () { /* 本文件不测生成路径 */ }, embed: stub.embed, embeddingModelName: stub.embeddingModelName },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

let gw: WechatDataGateway
let stub: EmbedStub
let kbId = 0

/** 登记一个文件并返回它的 id。 */
function addFile(name: string, content: string, includeInRag = true): number {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = gw.addKbFiles({ kbId, paths: [p], includeInRag })
  if (!r.ok) throw new Error(`夹具登记失败：${r.error ?? '?'}`)
  const hit = gw.getKbFiles(kbId, { limit: 500 }).items.find(f => f.name === name)
  if (hit === undefined) throw new Error(`夹具里找不到 ${name}`)
  return hit.id
}

/** 直接数向量表的行（绕开一切状态缓存与界面假设）。库文件还不存在时算「零行」。 */
function vectorRows(kb: number): Array<{ chunk_id: number; model: string }> {
  const file = join(root, 'wechat_kb_vectors.db')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT chunk_id, model FROM kb_vectors WHERE kb_id = ?').all(kb) as Array<{ chunk_id: number; model: string }>
  } finally {
    db.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbvec-'))
  // ⚠ 产物路径是 `dirname(decryptedDir)`，所以 decryptedDir 必须是 root 的**子目录**：
  // 直接把 root 传进去会把三个知识库产物写到系统临时目录根上，第二次跑就撞约束（踩过）。
  decrypted = join(root, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  stub = stubEmbed()
  gw = new WechatDataGateway(fakeCtx(stub))
  kbId = Number(gw.createKb({ name: '向量索引测试库' }).id)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('buildKbVectorIndex：按库建索引', () => {
  it('建完就有行，且**每一行都记着是哪个模型算的**（V1 的地基）', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元，单日累计最高二十万元。')
    const r = await gw.buildKbVectorIndex({ kbId })
    expect(r.ok, r.error ?? '?').toBe(true)
    expect(r.embedded).toBeGreaterThan(0)
    expect(stub.calls.length).toBeGreaterThan(0)
    const rows = vectorRows(kbId)
    expect(rows.length).toBe(r.embedded)
    expect(rows.every(x => x.model === 'stub-embed-v1')).toBe(true)

    const view = gw.getKbVectorIndex({ kbId })
    expect(view.model).toBe('stub-embed-v1')
    expect(view.configured).toBe(true)
    expect(view.status.ready).toBe(true)
    expect(view.status.staleReason).toBe('')
  })

  it('换嵌入模型 ⇒ 状态立刻判「模型不符」且 ready=false（旧缺陷是恒判就绪）', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    await gw.buildKbVectorIndex({ kbId })
    expect(gw.getKbVectorIndex({ kbId }).status.ready).toBe(true)

    // 换模型 = 改桩的返回值，与真机改 llm.json 的 embeddingModel 等价
    stub.model = 'stub-embed-v2'
    const after = gw.getKbVectorIndex({ kbId })
    expect(after.model).toBe('stub-embed-v2')
    expect(after.status.current).toBe('stub-embed-v2')
    expect(after.status.models).toEqual(['stub-embed-v1'])
    expect(after.status.staleReason).toBe('model-mismatch')
    expect(after.status.ready).toBe(false)
    // 旧行**还在**（判不可用不等于偷偷删数据；删除只发生在下一次构建里）
    expect(vectorRows(kbId).length).toBeGreaterThan(0)
  })

  it('换了模型再建一次：只重算本库，旧模型的行被替换', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    const other = Number(gw.createKb({ name: '另一个库' }).id)
    await gw.buildKbVectorIndex({ kbId })
    // 另一个库也建过，用它来证明「换模型不会把别人的向量清掉」
    const savedKb = kbId
    kbId = other
    addFile('b.md', '玄武纪要第九附录：本季度采购计划与预算调整。')
    await gw.buildKbVectorIndex({ kbId })
    kbId = savedKb

    stub.model = 'stub-embed-v2'
    const rebuilt = await gw.buildKbVectorIndex({ kbId })
    expect(rebuilt.ok).toBe(true)
    expect(vectorRows(kbId).every(x => x.model === 'stub-embed-v2')).toBe(true)
    /**
     * 别的库：**一行都没被动过**（这才是「只作废本库」的可观测形式）。
     * 它现在报 `model-mismatch` 是**对的** —— 嵌入模型目前是全局配置（P2 才按库绑定），
     * 两个库都还是 v1 的向量，而当前模型已经是 v2 了。
     * 也就是说：换模型之后各库**各自**决定何时重算，没有任何人被顺手清掉。
     */
    expect(vectorRows(other).every(x => x.model === 'stub-embed-v1')).toBe(true)
    const otherView = gw.getKbVectorIndex({ kbId: other })
    expect(otherView.status.staleReason).toBe('model-mismatch')
    expect(otherView.status.models).toEqual(['stub-embed-v1'])
    // 它自己重建一次之后就好了，且这次重算不影响甲库
    kbId = other
    expect((await gw.buildKbVectorIndex({ kbId })).ok).toBe(true)
    expect(gw.getKbVectorIndex({ kbId: other }).status.ready).toBe(true)
    expect(vectorRows(savedKb).every(x => x.model === 'stub-embed-v2')).toBe(true)
  })

  it('开了「禁止 AI 出网」时一次 embedding 都不发，且说的是拦截', async () => {
    addFile('a.md', '微信转账限额说明')
    writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: true })
    const r = await gw.buildKbVectorIndex({ kbId })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('出站拦截')
    expect(stub.calls).toEqual([])
    expect(vectorRows(kbId)).toEqual([])
  })

  it('关掉「参与语义检索」的文件：正文从未被发出去过', async () => {
    const id = addFile('private.md', '合同金额一百万元，违约金按日万分之五计。', false)
    const r = await gw.buildKbVectorIndex({ kbId })
    expect(r.embedded).toBe(0)
    expect(stub.calls.join('')).not.toContain('违约金')
    expect(vectorRows(kbId)).toEqual([])
    expect(id).toBeGreaterThan(0)
  })

  it('没有文件时不发起任何调用', async () => {
    const r = await gw.buildKbVectorIndex({ kbId })
    expect(r.ok).toBe(true)
    expect(r.embedded).toBe(0)
    expect(stub.calls).toEqual([])
  })
})

describe('searchKb：降级说明要说本次真话（V3）', () => {
  it('没配向量模型 ⇒ no-embed-model，而不是照抄「未建向量索引」', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    // 让宿主报「没配」：模型名解析回空
    ;(gw as unknown as { _ctx: { llm: { embeddingModelName?: () => string } } })._ctx.llm.embeddingModelName = () => ''
    const r = await gw.searchKb({ kbId, query: '转账限额' })
    expect(r.degraded?.reason).toBe('no-embed-model')
    expect(r.degraded?.label ?? '').toContain('未配置向量模型')
  })

  it('配了模型但本库没建过 ⇒ no-vector-index + 「还没有」；建完再搜 ⇒ 不再有降级说明', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元，单日累计最高二十万元。')
    const before = await gw.searchKb({ kbId, query: '转账限额' })
    expect(before.degraded?.reason).toBe('no-vector-index')
    expect(before.degraded?.label ?? '').toContain('还没有')

    await gw.buildKbVectorIndex({ kbId })
    const after = await gw.searchKb({ kbId, query: '转账限额' })
    expect(after.degraded, '索引就绪之后仍报降级').toBeUndefined()
    expect(after.hits.length).toBeGreaterThan(0)
    // 稠密跑过之后，命中里应能看到 dense 名次（两路都命中的块会同时记 sparse/dense）
    expect(after.hits.some(h => h.ranks.dense !== undefined)).toBe(true)
  })

  it('建过但换了模型 ⇒ index-stale，并说明要重建（不能谎报「还没建」）', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    await gw.buildKbVectorIndex({ kbId })
    stub.model = 'stub-embed-v2'
    const r = await gw.searchKb({ kbId, query: '转账限额' })
    expect(r.degraded?.reason).toBe('index-stale')
    expect(r.degraded?.label ?? '').toContain('需重建')
  })

  it('关键词逐字搜不到、语义能搜到时，稠密必须补上（这正是它存在的意义）', async () => {
    const text = '玄武纪要第九附录：本季度采购计划与预算调整，涉及三家供应商的比价结论。'
    addFile('b.md', text)
    await gw.buildKbVectorIndex({ kbId })
    // 用一个**不在正文里出现**、但向量桩会算出相近结果的问法：桩是字符直方图，
    // 所以「同字不同序」的句子就是它的「换个说法」。
    const q = '纪要第九附录 采购计划 预算调整'
    const r = await gw.searchKb({ kbId, query: q })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(at(r.hits, 0, 'hits').fileName).toBe('b.md')
  })

  it('embedding 抛错时关键词一路照常可用，且说明如实（H7）', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    await gw.buildKbVectorIndex({ kbId })
    // 建完之后把 embed 换成必抛错的那个：模拟断网 / 无 Key
    stub.embed = async (): Promise<number[][]> => { throw new Error('embedding HTTP 503') }
    ;(gw as unknown as { _ctx: { llm: { embed: unknown } } })._ctx.llm.embed = stub.embed
    const r = await gw.searchKb({ kbId, query: '转账' })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.degraded?.reason).toBe('embed-failed')
    expect(r.degraded?.label ?? '').toContain('503')
  })
})

describe('getKbVectorIndex：状态读取不越界', () => {
  it('拿别的库的 id 问状态 ⇒ 该库 rows=0，不串味', async () => {
    addFile('a.md', '微信转账限额说明')
    await gw.buildKbVectorIndex({ kbId })
    const other = Number(gw.createKb({ name: '空库' }).id)
    const v = gw.getKbVectorIndex({ kbId: other })
    expect(v.status.rows).toBe(0)
    expect(v.status.staleReason).toBe('no-index')
    expect(gw.getKbVectorIndex({ kbId }).status.rows).toBeGreaterThan(0)
  })

  it('kbId 非法 ⇒ 不抛错，按「没有索引」回答', () => {
    const v = gw.getKbVectorIndex({ kbId: 0 })
    expect(v.kbId).toBe(0)
    expect(v.status.ready).toBe(false)
  })
})

/** 收尾时确认夹具库文件真的落在临时 root 里，没写到系统临时目录根上（路径口径的自检）。 */
afterEach(() => {
  const p = kbFilesDbPath(decrypted)
  expect(p.startsWith(root)).toBe(true)
})

/**
 * P2：库级模型覆盖。
 *
 * 这一组只测一件事：**同一个全局配置下，两个库可以走两个嵌入模型，且互不污染**。
 * 它最容易坏在「解析时漏带 kbId」—— 那不会崩，只会让甲库的索引被乙库的模型判成过期，
 * 于是两个库互相把对方的 `ready` 打成假。
 */
describe('库级模型覆盖（V4）', () => {
  it('本库指定嵌入模型 ⇒ 建出来的行记的是指定名，全局值不受影响', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    const r = gw.setKbModelConfig({ kbId, embedRef: 'm:per-lib-bge' })
    expect(r.ok).toBe(true)

    const built = await gw.buildKbVectorIndex({ kbId })
    expect(built.ok).toBe(true)
    expect(vectorRows(kbId).every(x => x.model === 'per-lib-bge')).toBe(true)

    const view = gw.getKbVectorIndex({ kbId })
    expect(view.model).toBe('per-lib-bge')
    expect(view.source).toBe('inline')
    expect(view.status.ready).toBe(true)
    // 发出去的请求里模型名也是它（makeEmbedFn 用的是同一个解析结果）
    expect(stub.calls.length).toBeGreaterThan(0)
  })

  it('换一个库不受影响：乙库仍按全局解析', async () => {
    addFile('a.md', '微信转账限额说明')
    gw.setKbModelConfig({ kbId, embedRef: 'm:only-this-lib' })
    const other = Number(gw.createKb({ name: '乙库' }).id)
    expect(gw.getKbVectorIndex({ kbId: other }).model).toBe('stub-embed-v1')
    expect(gw.getKbVectorIndex({ kbId: other }).source).toBe('inherit')
    expect(gw.getKbModelConfig({ kbId: other }).settings.embedRef).toBe('')
  })

  it('改覆盖 ⇒ 原本库「正常」的索引立刻变成模型不符（不会静默继续用）', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    await gw.buildKbVectorIndex({ kbId })
    expect(gw.getKbVectorIndex({ kbId }).status.ready).toBe(true)

    gw.setKbModelConfig({ kbId, embedRef: 'm:a-different-one' })
    const after = gw.getKbVectorIndex({ kbId })
    expect(after.status.ready).toBe(false)
    expect(after.status.staleReason).toBe('model-mismatch')
    // 面板检索的降级说明要跟着换成「需重建」，不能还报「还没建」
    const s = await gw.searchKb({ kbId, query: '转账' })
    expect(s.degraded?.reason).toBe('index-stale')
    expect(s.degraded?.label ?? '').toContain('需重建')
  })

  it('取消覆盖（传空串）⇒ 回到全局，索引重新算作可用', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    await gw.buildKbVectorIndex({ kbId })
    gw.setKbModelConfig({ kbId, embedRef: 'm:other' })
    expect(gw.getKbVectorIndex({ kbId }).status.ready).toBe(false)
    gw.setKbModelConfig({ kbId, embedRef: '' })
    const back = gw.getKbVectorIndex({ kbId })
    expect(back.model).toBe('stub-embed-v1')
    expect(back.source).toBe('inherit')
    expect(back.status.ready).toBe(true)
  })

  it('非法引用串 ⇒ 拒绝写入，界面上原值还在（不静默变成继承）', () => {
    gw.setKbModelConfig({ kbId, embedRef: 'm:good-one' })
    const bad = gw.setKbModelConfig({ kbId, embedRef: 'bare-model-name' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('格式')
    expect(gw.getKbModelConfig({ kbId }).settings.embedRef).toBe('m:good-one')
  })

  it('getKbModelConfig 同时给引用串、全局值与生效值（界面两样都要显示）', () => {
    gw.setKbModelConfig({ kbId, rerankRef: 'm:my-reranker' })
    const v = gw.getKbModelConfig({ kbId })
    expect(v.settings.rerankRef).toBe('m:my-reranker')
    expect(v.resolved.rerank.model).toBe('my-reranker')
    expect(v.resolved.rerank.source).toBe('inline')
    expect(v.resolved.chat.source).toBe('inherit')
    // 全局 chat 名取自 agentDefaultModel（桩里是 stub-model）
    expect(v.global.chat).toBe('stub-model')
  })

  it('删库 ⇒ 设置行跟着消失（否则将来复用同一个 id 的库会继承上一个库的覆盖）', () => {
    gw.setKbModelConfig({ kbId, embedRef: 'm:gone-with-kb' })
    expect(gw.getKbModelConfig({ kbId }).settings.embedRef).toBe('m:gone-with-kb')
    const r = gw.deleteKb({ id: kbId, action: { kind: 'purge' } })
    expect(r.ok).toBe(true)
    // 默认库仍在，用它确认读路径没坏
    expect(gw.getKbModelConfig({ kbId: 1 }).settings.embedRef).toBe('')
  })

  it('getKbs 合流带出 modelOverrides（rail 芯片的「N 项自定义」靠它）', () => {
    expect(gw.getKbs().items.find(k => k.id === kbId)?.modelOverrides).toBe(0)
    gw.setKbModelConfig({ kbId, chatRef: 'm:x', embedRef: 'm:y' })
    expect(gw.getKbs().items.find(k => k.id === kbId)?.modelOverrides).toBe(2)
  })
})
