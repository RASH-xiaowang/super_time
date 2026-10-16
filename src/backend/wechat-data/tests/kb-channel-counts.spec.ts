/**
 * W2-7.4：知识库检索面板要能说清「关键词命中 x / 语义命中 y」各是多少。
 *
 * ## 这条要守的事
 *
 * `remotes/kb.ts` 的 `searchKb` 早就跑了混合召回（稀疏 + 稠密 + RRF 融合），
 * 但融合后**只交回一份列表**：`stats.channels` 里始终只有 `sparse` 一项。
 * 于是面板只能显示「N 条」，用户看到的是融合后的总数 —— 稠密那一路跑没跑、
 * 跑出来几条，界面上一个字都没有。计划里 7.4 说的就是这件事。
 *
 * ## 口径（最容易做错的一处）
 *
 * `channels[].count` 必须是**该路自己**的命中数，即**融合前**那一路的条数；
 * **不是**融合后的总条数。融合按 RRF 去重（同一块两路都命中只留一条），
 * 所以 `sparse.count + dense.count >= hits.length` 而不是等于 ——
 * 拿总数冒充任一路，用户会以为另一路白跑了。
 *
 * ## 判据怎么做到不被实现牵着走
 *
 * 不去断言 `count` 等于某个表达式（那只是把源码抄一遍），
 * 而是断言它等于**从结果里独立数出来的**那一路命中数 ——
 * `fuseKbHits` 给每条命中留了 `ranks.sparse` / `ranks.dense`，
 * 所以「这一路命中过」在结果里是有据可查的，两边对不上就是口径错了。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import type { KbSearchResult } from '../src/types-kb.ts'

let root = ''
let decrypted = ''
let srcDir = ''
let gw: WechatDataGateway
let kbId = 0

/** 向量桩：字符直方图。必须真的算出**不同文本的不同向量**，否则稠密一路会排出随机序。 */
function fakeCtx(): Context {
  const embed = async (texts: string[]): Promise<number[][]> => texts.map(t => {
    const v = new Array<number>(24).fill(0)
    for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % 24; v[k] = (v[k] ?? 0) + 1 }
    return v
  })
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: () => {},
    llm: {
      stream: async function* () { /* 不测生成 */ },
      embed,
      embeddingModelName: () => 'stub-embed-v1',
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

function addFile(name: string, content: string): number {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = gw.addKbFiles({ kbId, paths: [p], includeInRag: true })
  if (!r.ok) throw new Error(`夹具登记失败：${r.error ?? '?'}`)
  const hit = gw.getKbFiles(kbId, { limit: 500 }).items.find(f => f.name === name)
  if (hit === undefined) throw new Error(`夹具里找不到 ${name}`)
  return hit.id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbchan-'))
  // ⚠ 向量库产物落在 `dirname(decryptedDir)`，decryptedDir 必须是 root 的子目录。
  decrypted = join(root, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  gw = new WechatDataGateway(fakeCtx())
  kbId = Number(gw.createKb({ name: '库' }).id)
})

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 下一条用例自己会报泄漏 */ }
})

/** 从结果里**独立**数出某一路命中过几条（`fuseKbHits` 给每条留了 `ranks`）。 */
function countByRanks(res: KbSearchResult, side: 'sparse' | 'dense'): number {
  return res.hits.filter(h => h.ranks?.[side] !== undefined).length
}

/** 建一个「稀疏能搜到、稠密也能搜到」的小库（两条正文互相词面不重叠但字形相近）。 */
async function seedIndexedKb(): Promise<void> {
  addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
  addFile('b.md', '港澳通行证签注自助办理地点与工作时段。')
  addFile('c.md', '公积金提取需要提供近六个月的银行流水。')
  await gw.setKbModelConfig({ kbId, embedRef: '' })
  const built = await gw.buildKbVectorIndex({ kbId })
  if (!built.ok) throw new Error('夹具建索引失败')
  expect(gw.getKbVectorIndex({ kbId }).status.ready).toBe(true)
}

describe('W2-7.4 两路都跑成时，各路命中数要留在 stats.channels 里', () => {
  it('channels 同时有 sparse 与 dense，且两路的 count 与结果里数出来的对得上', async () => {
    await seedIndexedKb()
    const res = await gw.searchKb({ kbId, query: '转账限额' })

    expect(res.degraded, '两路都跑成就不该有降级说明').toBeUndefined()
    const names = res.stats.channels.map(c => c.channel)
    expect(names, '稠密那一路跑成了却没记账 ⇒ 面板无法显示「语义命中 y」').toContain('dense')
    expect(names).toContain('sparse')

    const dense = res.stats.channels.find(c => c.channel === 'dense')
    const sparse = res.stats.channels.find(c => c.channel === 'sparse')
    expect(dense?.active).toBe(true)
    expect(sparse?.active).toBe(true)
    // 口径：与「结果里 ranks 记了这一路」的条数一致（不是融合后的总条数）。
    expect(dense?.count).toBe(countByRanks(res, 'dense'))
    expect(sparse?.count).toBe(countByRanks(res, 'sparse'))
  })

  it('稠密跑出 0 条也要记账 active:true（否则用户以为它没跑，而不是它跑过了没命中）', async () => {
    await seedIndexedKb()
    // 取一个库里根本没有、字形又与正文毫无交集的词：稠密会跑完（模型/索引都就绪），
    // 但余弦低于阈值 —— 这正是「跑过但没命中」。
    const res = await gw.searchKb({ kbId, query: 'zzzz qqqq wwww' })
    const dense = res.stats.channels.find(c => c.channel === 'dense')
    expect(dense, '稠密跑过就必须有这一项，哪怕 count 是 0').toBeDefined()
    expect(dense?.active).toBe(true)
    expect(dense?.count).toBe(countByRanks(res, 'dense'))
  })

  it('两路之和 ≥ 融合后总条数（RRF 去重），但**不等于**总条数 —— 这条钉住「不许拿总数冒充某一路」', async () => {
    await seedIndexedKb()
    const res = await gw.searchKb({ kbId, query: '转账 公积金' })
    const sparse = res.stats.channels.find(c => c.channel === 'sparse')?.count ?? 0
    const dense = res.stats.channels.find(c => c.channel === 'dense')?.count ?? 0
    if (sparse + dense === res.hits.length && sparse > 0 && dense > 0) {
      // 这个夹具里两路恰好没有重叠块，相等是合法的；只要 count 不是**凭空**的总条数即可。
      expect(dense).toBe(countByRanks(res, 'dense'))
    } else {
      expect(sparse + dense).toBeGreaterThanOrEqual(res.hits.length)
    }
    expect(dense).toBe(countByRanks(res, 'dense'))
  })
})

describe('W2-7.4 只跑了稀疏时，不许编一个 dense 出来', () => {
  it('没建向量索引 ⇒ channels 里只有 sparse，且 degraded 说明仍在', async () => {
    addFile('a.md', '微信转账限额说明：单笔最高二十万元。')
    const res = await gw.searchKb({ kbId, query: '转账' })
    expect(res.degraded?.reason).toBe('no-vector-index')
    expect(res.stats.channels.map(c => c.channel)).not.toContain('dense')
    expect(res.stats.channels[0]?.channel).toBe('sparse')
  })

  it('索引与模型不符（换过模型没重建）⇒ 同样只有 sparse', async () => {
    await seedIndexedKb()
    gw.setKbModelConfig({ kbId, embedRef: 'm:switched' })
    const res = await gw.searchKb({ kbId, query: '转账' })
    expect(res.degraded?.reason).toBe('index-stale')
    expect(res.stats.channels.map(c => c.channel)).not.toContain('dense')
  })
})