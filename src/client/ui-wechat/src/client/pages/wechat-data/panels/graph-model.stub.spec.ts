/**
 * L14：知识库 stub 节点（被 `[[目标]]` 引用、但没有对应笔记）—— **既有实现的行为锁定**。
 *
 * 结论先说：这一条在源码里**已经是实现**而不是 stub 占位（L14 行给的 `graph-model.ts:26`
 * 是文档写下时的行号，现在那一行是 `isFriend?: boolean`）。为避免「已被实现」随下次重构
 * 悄悄退化，这里用 `buildKnowledgeNetwork` 把契约钉住：id 命名空间 `kb:`、
 * `kind/stub/community/weight/backLinks/excerpt`、**不参与 nodeLimit 截断**、以及 wiki 边不断链。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRAPH_SETTINGS, buildKnowledgeNetwork } from './graph-model.ts'
import type { KnowledgeSnapshot } from '../types.ts'

/** 2 篇笔记 + 3 个 stub（其中 rust 被 6 处引用，用于验证 weight 封顶）。 */
function snapshot(): KnowledgeSnapshot {
  const note = (id: number, title: string, extra: Partial<KnowledgeSnapshot['notes'][number]> = {}) => ({
    id, title, excerpt: '', tags: [], sourceKind: 'manual' as const,
    createdAt: id, updatedAt: id, outLinks: 1, backLinks: 0, ...extra,
  })
  return {
    notes: [note(1, '笔记一', { outLinks: 3 }), note(2, '笔记二', { backLinks: 1, sourceKind: 'ask', sourceUsername: 'wxid_a' })],
    stubs: [
      { key: 'kubectl', label: 'kubectl', refCount: 3, referencedBy: [1] },
      { key: 'observability', label: 'observability', refCount: 1, referencedBy: [2] },
      { key: 'rust', label: 'rust', refCount: 6, referencedBy: [1, 2] },
    ],
    edges: [
      { source: 'note:1', target: 'kb:kubectl', weight: 1, kind: 'wiki' },
      { source: 'note:1', target: 'kb:rust', weight: 2, kind: 'wiki' },
      { source: 'note:2', target: 'kb:observability', weight: 1, kind: 'wiki' },
      { source: 'note:1', target: 'note:2', weight: 1, kind: 'wiki' },
    ],
    sessionNames: { wxid_a: '甲' },
    summary: { noteCount: 2, linkCount: 4, stubCount: 3, orphanCount: 0, askCount: 1, manualCount: 1 },
  }
}

const SETTINGS = { ...DEFAULT_GRAPH_SETTINGS, mode: 'knowledge' as const, nodeLimit: 50 }

describe('L14 知识库 stub 节点', () => {
  it('每个未解析的 [[目标]] 都成为 kb: 前缀的 stub 节点（不与他人 id 撞）', () => {
    const g = buildKnowledgeNetwork(snapshot(), null, SETTINGS)
    const stubs = g.nodes.filter(n => n.kind === 'stub')
    expect(stubs.map(n => n.id)).toEqual(['kb:kubectl', 'kb:observability', 'kb:rust'])
    expect(stubs.map(n => n.label)).toEqual(['kubectl', 'observability', 'rust'])
    expect(stubs.every(n => n.stub === true)).toBe(true)
  })

  it('画布依赖的字段：中性灰（community = -1）、截断掉的小圆点、反链数与提示文案', () => {
    const g = buildKnowledgeNetwork(snapshot(), null, SETTINGS)
    for (const n of g.nodes.filter(x => x.kind === 'stub')) {
      expect(n.community).toBe(-1) // 画布据它取中性灰，而不是分进某个圈子
      expect(n.radius).toBe(12)
    }
    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get('kb:kubectl')).toMatchObject({ weight: 100, backLinks: 3, excerpt: '被 3 处引用，尚无同名笔记' })
    expect(byId.get('kb:observability')).toMatchObject({ weight: 60, backLinks: 1 })
    // refCount 越高越显眼，但封顶（40 + min(refCount*20, 200)）
    expect(byId.get('kb:rust')).toMatchObject({ weight: 160, backLinks: 6 })
  })

  it('wiki 边不断链：指向 stub 的边在两侧节点都存在时保留', () => {
    const g = buildKnowledgeNetwork(snapshot(), null, SETTINGS)
    const ids = new Set(g.nodes.map(n => n.id))
    const wiki = g.edges.filter(e => e.kind === 'wiki')
    expect(wiki).toHaveLength(4)
    expect(wiki.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(wiki.filter(e => e.target.startsWith('kb:')).map(e => e.target))
      .toEqual(['kb:kubectl', 'kb:rust', 'kb:observability'])
  })

  it('stub 不参与 nodeLimit 截断（笔记被截到 1 篇时，3 个缺口提示仍在）', () => {
    const g = buildKnowledgeNetwork(snapshot(), null, { ...SETTINGS, nodeLimit: 1 })
    expect(g.nodes.filter(n => n.kind === 'note')).toHaveLength(1)
    expect(g.nodes.filter(n => n.kind === 'stub')).toHaveLength(3)
    // 被截掉的笔记所连的边随之消失，但不影响 stub 自身的存在
    expect(g.edges.every(e => e.kind === 'wiki')).toBe(true)
  })

  it('没有知识快照时不造任何 stub（防空转：断言对象真的由数据产生）', () => {
    const empty = buildKnowledgeNetwork(null, null, SETTINGS)
    expect(empty.nodes).toEqual([])
    // 同一份设置 + 真快照 ⇒ 有 stub，证明上一条不是「怎么调都空」
    expect(buildKnowledgeNetwork(snapshot(), null, SETTINGS).nodes.length).toBeGreaterThan(0)
  })
})

/* ── 融合视图（mode='fused'）────────────────────────────────────────────
 *
 * 右侧面板「数据」分段里的**知识网络 / 融合视图**这一对开关，在真机上没法用界面验证：
 * 只有「来自 AI 问答」的笔记（`sourceKind='ask'` + `sourceUsername`）才会把来源会话拉进来，
 * 而面板里手写的笔记两样都没有 ⇒ 切到融合视图节点数一个都不变（真机实测 5/4/0/4/1 前后一致）。
 * 那属于**数据不满足**而不是功能失效，所以这条参数改在这里锁逻辑：给定带来源会话的笔记，
 * 融合视图必须真的把「人/群」拉进同一张图并用 source 边连上。
 */
export function fusedSnapshot(): KnowledgeSnapshot {
  const note = (id: number, title: string, extra: Partial<KnowledgeSnapshot['notes'][number]> = {}) => ({
    id, title, excerpt: '', tags: [], sourceKind: 'manual' as const,
    createdAt: id, updatedAt: id, outLinks: 0, backLinks: 0, ...extra,
  })
  return {
    notes: [note(1, '来自问答的笔记', { sourceKind: 'ask', sourceUsername: 'wxid_a' }), note(2, '手写笔记')],
    stubs: [],
    edges: [],
    sessionNames: { wxid_a: '甲' },
    summary: { noteCount: 2, linkCount: 0, stubCount: 0, orphanCount: 0, askCount: 1, manualCount: 1 },
  }
}

describe('融合视图（mode=fused）—— 真机上无法用界面覆盖的那条参数', () => {
  const social = {
    nodes: [
      { id: 'wxid_a', label: '甲', kind: 'person', is_friend: true, msg_count: 30 },
      { id: 'wxid_b', label: '乙', kind: 'person', is_friend: true, msg_count: 10 },
    ],
    edges: [],
  }

  it('融合视图把笔记的来源会话拉进图里，并用 source 边连到笔记', () => {
    const fused = buildKnowledgeNetwork(fusedSnapshot(), social, { ...SETTINGS, mode: 'fused' })
    const ids = fused.nodes.map(n => n.id)
    expect(ids).toContain('wxid_a')
    // 没有来源的会话不该被顺手拉进来（否则融合视图会把整个通讯录都带进来）
    expect(ids).not.toContain('wxid_b')
    const sourceEdges = fused.edges.filter(e => e.kind === 'source')
    expect(sourceEdges).toHaveLength(1)
    expect(sourceEdges[0]).toMatchObject({ source: 'note:1', target: 'wxid_a' })
    // 会话名优先用知识快照里的 sessionNames
    expect(fused.nodes.find(n => n.id === 'wxid_a')?.label).toBe('甲')
  })

  it('知识网络（不融合）不放任何会话节点 —— 两个模式必须有差别', () => {
    const plain = buildKnowledgeNetwork(fusedSnapshot(), social, { ...SETTINGS, mode: 'knowledge' })
    expect(plain.nodes.map(n => n.id)).not.toContain('wxid_a')
    expect(plain.edges.filter(e => e.kind === 'source')).toHaveLength(0)
    // 防空转：两份结果确实来自同一份输入
    expect(plain.nodes.some(n => n.id === 'note:1')).toBe(true)
  })
})
