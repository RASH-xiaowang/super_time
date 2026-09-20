/**
 * 问答历史（`ask-history.ts`）：记录、列表/搜索/筛选/排序/分页、删除、清空。
 *
 * 这个模块的边界与 `export-history.ts` 不同，用例把它钉住：
 *   · 导出历史记的是「文件在哪」（可操作口径）；
 *   · 本模块记的是**问答正文本身**（内容口径）—— 所以「没检索到原文」这种
 *     **没调用模型**的轮次也必须留下，否则用户回看历史会以为当时根本没问过。
 *
 * 另外三条容易写错的语义：
 *   ① 问题与回答都空的记录不落库（避免攒一堆空行）；
 *   ② 搜索必须转义 LIKE 的 `%` / `_`（用户搜 "2026_09" 时下划线不是通配符）；
 *   ③ 聚合计数按**未分页**的命中集合算（否则页签数字会随翻页变化）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from '../src/query/ask-history.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个数据根 + decrypted 目录；返回 decryptedDir。 */
function makeRoot(): string {
  const dataRoot = join(mkdtempSync(join(tmpdir(), 'wx-askhist-')), 'wechat-data')
  const decrypted = join(dataRoot, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  scratch.push(join(dataRoot, '..'))
  return decrypted
}

/** 一条最简问答（只给用例关心的字段）。 */
function seed(dec: string, over: Partial<Parameters<typeof recordAsk>[1]> = {}): number | null {
  return recordAsk(dec, {
    question: '最近一次转账给我的是谁？',
    answer: '房东说了收到转账 13.00 元 [1]',
    ...over,
  })
}

describe('问答历史：记录与读取', () => {
  it('记录一次问答后能完整读回来（问题/回答/模型/范围/耗时/状态）', () => {
    const dec = makeRoot()
    const id = seed(dec, {
      source: 'ask',
      username: 'wxid_room',
      usernameName: '项目群',
      from: '2026-09-01',
      to: '2026-09-07',
      model: 'deepseek · chat',
      intent: 'entity_lookup',
      terms: ['转账', '房东'],
      basis: '共 12 条 / 2 个会话 / 2026-08-01 ~ 2026-09-07',
      citedIndexes: [1],
      elapsedMs: 4321,
      ts: 1_760_000_000_000,
    })
    expect(id).toBeGreaterThan(0)
    const snap = listAskHistory(dec, {})
    expect(snap.total).toBe(1)
    const row = snap.items[0]!
    expect(row.id).toBe(id)
    expect(row.ts).toBe(1_760_000_000_000)
    expect(row.question).toBe('最近一次转账给我的是谁？')
    expect(row.answer).toContain('13.00')
    expect(row.source).toBe('ask')
    expect(row.username).toBe('wxid_room')
    expect(row.usernameName).toBe('项目群')
    expect(row.from).toBe('2026-09-01')
    expect(row.to).toBe('2026-09-07')
    expect(row.model).toBe('deepseek · chat')
    expect(row.intent).toBe('entity_lookup')
    expect(row.terms).toEqual(['转账', '房东'])
    expect(row.citedIndexes).toEqual([1])
    expect(row.basis).toContain('2026-08-01')
    expect(row.status).toBe('ok')
    expect(row.elapsedMs).toBe(4321)
  })

  it('引用以 JSON 往返：读回来仍是可点击跳转所需的完整对象', () => {
    const dec = makeRoot()
    seed(dec, {
      citations: [{ name: '房东', time: '2026-09-05 20:11', snippet: '收到转账 13.00 元', username: 'wxid_a', local_id: 42, sender: '张三' }],
    })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.citations).toHaveLength(1)
    expect(row.citations[0]).toEqual({
      name: '房东', time: '2026-09-05 20:11', snippet: '收到转账 13.00 元',
      username: 'wxid_a', local_id: 42, sender: '张三',
    })
  })

  it('「没检索到原文」这种未调模型的轮次也要落库（status=insufficient）', () => {
    const dec = makeRoot()
    seed(dec, { answer: '本机记录里没有检索到与这个问题相关的原文，因此不作回答。', insufficient: true })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.status).toBe('insufficient')
    expect(row.answer).toContain('没有检索到')
  })

  it('「不予采用」记 withheld；带 error 记 fail（error 优先）', () => {
    const dec = makeRoot()
    seed(dec, { withheld: true })
    seed(dec, { error: '未配置默认模型' })
    const byStatus = new Map(listAskHistory(dec, {}).items.map(i => [i.status, i]))
    expect(byStatus.get('withheld')!.answer).toContain('13.00')
    expect(byStatus.get('fail')!.error).toBe('未配置默认模型')
  })

  it('问题与回答都空的记录不落库（返回 null，不留空行）', () => {
    const dec = makeRoot()
    expect(recordAsk(dec, { question: '   ', answer: '' })).toBe(null)
    expect(listAskHistory(dec, {}).total).toBe(0)
  })

  it('问题为空但有回答仍然落库（问题可能来自快捷入口）', () => {
    const dec = makeRoot()
    expect(seed(dec, { question: '' })).toBeGreaterThan(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('超长回答按上限截断（防一行撑爆库），正常长度的回答逐字保存', () => {
    const dec = makeRoot()
    const long = 'x'.repeat(25_000)
    seed(dec, { question: '长回答', answer: long })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.answer.length).toBe(20_000)
    const normal = 'a'.repeat(1_500)
    seed(dec, { question: '正常回答', answer: normal })
    const got = listAskHistory(dec, { q: '正常回答' }).items[0]!
    expect(got.answer.length).toBe(1_500)
  })
})

describe('问答历史：搜索 / 筛选 / 排序 / 分页', () => {
  it('搜索同时命中问题与回答', () => {
    const dec = makeRoot()
    seed(dec, { question: '关于合同的事', answer: '合同已签 [1]', ts: 1000 })
    seed(dec, { question: '别的', answer: '提到了合同的补充条款 [1]', ts: 2000 })
    seed(dec, { question: '无关', answer: '无关内容', ts: 3000 })
    expect(listAskHistory(dec, { q: '合同' }).total).toBe(2)
  })

  it('LIKE 的 % 与 _ 被转义：搜 "2026_09" 不匹配 "2026X09"', () => {
    const dec = makeRoot()
    seed(dec, { question: '关于 2026_09 的报价', answer: 'A', ts: 1000 })
    seed(dec, { question: '关于 2026X09 的报价', answer: 'B', ts: 2000 })
    const snap = listAskHistory(dec, { q: '2026_09' })
    expect(snap.total).toBe(1)
    expect(snap.items[0]!.question).toContain('2026_09')
  })

  it('状态筛选生效，且聚合计数按未分页的命中集合算', () => {
    const dec = makeRoot()
    seed(dec, { question: 'q1', ts: 1000 })
    seed(dec, { question: 'q2', ts: 2000 })
    seed(dec, { question: 'q3', ts: 3000, insufficient: true })
    const filtered = listAskHistory(dec, { status: 'ok', limit: 1 })
    expect(filtered.total).toBe(2)
    expect(filtered.items).toHaveLength(1)
    expect(filtered.statusCounts['ok']).toBe(2)
    expect(filtered.statusCounts['insufficient']).toBeUndefined()
    const all = listAskHistory(dec, {})
    expect(all.statusCounts['ok']).toBe(2)
    expect(all.statusCounts['insufficient']).toBe(1)
  })

  it('来源筛选 + 来源计数（面板问答 / 会话内问答分开看）', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a', source: 'ask', ts: 1000 })
    seed(dec, { question: 'b', source: 'session', ts: 2000 })
    seed(dec, { question: 'c', source: 'session', ts: 3000 })
    const onlySession = listAskHistory(dec, { sources: ['session'] })
    expect(onlySession.total).toBe(2)
    expect(onlySession.sourceCounts['session']).toBe(2)
    expect(listAskHistory(dec, {}).sourceCounts['ask']).toBe(1)
  })

  it('默认最新优先；order=asc 可翻成最早优先', () => {
    const dec = makeRoot()
    seed(dec, { question: '旧', ts: 1000 })
    seed(dec, { question: '新', ts: 3000 })
    seed(dec, { question: '中', ts: 2000 })
    expect(listAskHistory(dec, {}).items.map(i => i.question)).toEqual(['新', '中', '旧'])
    expect(listAskHistory(dec, { order: 'asc' }).items.map(i => i.question)).toEqual(['旧', '中', '新'])
  })

  it('分页：limit 生效、offset 跳过、total 是命中总数', () => {
    const dec = makeRoot()
    for (let i = 0; i < 5; i += 1) seed(dec, { question: `q${i}`, ts: 1000 + i })
    const p1 = listAskHistory(dec, { limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.total).toBe(5)
    const p2 = listAskHistory(dec, { limit: 2, offset: 4 })
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0]!.question).toBe('q0')
  })

  it('时间范围筛选按 ts 闭区间', () => {
    const dec = makeRoot()
    seed(dec, { question: '早', ts: 1000 })
    seed(dec, { question: '中', ts: 2000 })
    seed(dec, { question: '晚', ts: 3000 })
    expect(listAskHistory(dec, { from: 2000, to: 3000 }).items.map(i => i.question)).toEqual(['晚', '中'])
  })
})

describe('问答历史：删除与清空', () => {
  it('按 id 删除，只删指定的那条', () => {
    const dec = makeRoot()
    const a = seed(dec, { question: 'a', ts: 1000 })!
    seed(dec, { question: 'b', ts: 2000 })
    const r = deleteAskHistory(dec, [a])
    expect(r.removed).toBe(1)
    expect(listAskHistory(dec, {}).items.map(i => i.question)).toEqual(['b'])
  })

  it('空 id 列表 / 非法 id 不删任何东西', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a' })
    expect(deleteAskHistory(dec, []).removed).toBe(0)
    expect(deleteAskHistory(dec, [0, -3, Number.NaN]).removed).toBe(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('清空全部返回删除条数，且清完还能继续写入', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a', ts: 1000 })
    seed(dec, { question: 'b', ts: 2000 })
    expect(clearAskHistory(dec).removed).toBe(2)
    expect(listAskHistory(dec, {}).total).toBe(0)
    expect(seed(dec, { question: 'c', ts: 3000 })).toBeGreaterThan(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('删除后 id 不复用（AUTOINCREMENT），不会把新记录顶到旧 id 上', () => {
    const dec = makeRoot()
    const a = seed(dec, { question: 'a', ts: 1000 })!
    deleteAskHistory(dec, [a])
    const b = seed(dec, { question: 'b', ts: 2000 })!
    expect(b).toBeGreaterThan(a)
  })
})

describe('问答历史：按数据根隔离', () => {
  it('两个数据根各存各的（换账号/换数据目录不会串味）', () => {
    const dec1 = makeRoot()
    const dec2 = makeRoot()
    seed(dec1, { question: '只在根 1' })
    expect(listAskHistory(dec1, {}).total).toBe(1)
    expect(listAskHistory(dec2, {}).total).toBe(0)
  })

  it('空库读取返回空快照而不是抛错（面板不该因为没历史而崩）', () => {
    const dec = makeRoot()
    const snap = listAskHistory(dec, {})
    expect(snap).toEqual({ items: [], total: 0, statusCounts: {}, sourceCounts: {} })
  })
})
