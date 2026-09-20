/**
 * 同备注编号边（`kind: 'class'`）的建边行为锁定（`graph-model.ts` 的 `buildGraph`）。
 *
 * 这一层的核心取舍是**不做完全图**：真机实测「宜州一中404」一个班 43 人，
 * 完全图是 C(43,2)=903 条边，而默认视图的预算只有 nodeLimit×5=1250 条 ——
 * 一个班就能吃掉七成额度，把「共同群」这类真实观测到的关系挤掉（9 个班合计 1233 条）。
 * 所以实现是「锚点串成链 + 其余轮转挂到锚上」，边数恒为 人数−1、整班仍连通。
 * 这条约束不会自己暴露：改成完全图后**界面照样出图**，只是线糊成一片、别的边看不见了，
 * 所以用「43 人班必须恰好 42 条边」把它钉死（写成 ≥ 就失去意义了）。
 *
 * 另有三条容易写错又看不出来的性质：同两点之间不能出现两条边（React key 会撞、
 * 度数统计虚高）、`minCommon` 不该管到备注班级（那个滑杆写的是「共同群阈值」）、
 * 群组模式不该有班级边（班级是人的属性）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, DEFAULT_GRAPH_SETTINGS, type GEdge, type GraphSettings } from './graph-model.ts'

type EnvNode = {
  id: string
  label: string
  kind: string
  is_friend?: boolean
  msg_count?: number
  group_count?: number
  group_codes?: string[]
  remark_group?: string
  shared_count?: number
  shared_members?: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
}

const S: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS }

/** 造一个 person 节点（默认好友）。 */
function person(id: string, remarkGroup?: string, groupCodes?: string[]): EnvNode {
  return {
    id,
    label: id,
    kind: 'contact',
    is_friend: true,
    msg_count: 0,
    group_count: groupCodes?.length ?? 0,
    group_codes: groupCodes ?? [],
    ...(remarkGroup ? { remark_group: remarkGroup } : {}),
  }
}

function env(nodes: EnvNode[]): { nodes: EnvNode[]; edges: Array<{ source: string; target: string; weight: number }> } {
  return { nodes, edges: [] }
}

/** 边的无序对键（同 buildGraph 的口径）。 */
function pairKey(e: GEdge): string {
  return e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source
}

/** 只看某个 kind 的边。 */
function ofKind(edges: GEdge[], kind: GEdge['kind']): GEdge[] {
  return edges.filter(e => e.kind === kind)
}

/** 用给定边把一组节点做连通性检查。 */
function isConnected(ids: string[], edges: GEdge[]): boolean {
  if (ids.length <= 1) return true
  const adj = new Map<string, Set<string>>(ids.map(id => [id, new Set<string>()]))
  for (const e of edges) {
    adj.get(e.source)?.add(e.target)
    adj.get(e.target)?.add(e.source)
  }
  const seen = new Set<string>([ids[0] as string])
  const stack = [ids[0] as string]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    for (const nxt of adj.get(cur) ?? []) {
      if (seen.has(nxt)) continue
      seen.add(nxt)
      stack.push(nxt)
    }
  }
  return seen.size === ids.length
}

describe('同备注编号边：数量与连通性', () => {
  it('4 人班是 3 条边（人数−1），且整班连通', () => {
    const ids = ['p0', 'p1', 'p2', 'p3']
    const g = buildGraph(env(ids.map(id => person(id, '宜州一中404'))), S)
    const cls = ofKind(g.edges, 'class')
    expect(cls.length).toBe(3)
    expect(isConnected(ids, cls)).toBe(true)
    for (const e of cls) {
      expect(e.bidirectional).toBe(true)
      expect(e.weight).toBe(1)
      expect(e.dist).toBe(200)
    }
  })

  it('2 人班也必须有 1 条边（锚点数的下界是 1，不是 3）', () => {
    const g = buildGraph(env([person('p0', '物联本202'), person('p1', '物联本202')]), S)
    const cls = ofKind(g.edges, 'class')
    expect(cls.length).toBe(1)
    expect(pairKey(cls[0] as GEdge)).toBe('p0|p1')
  })

  it('43 人班恰好 42 条边：绝不是完全图（完全图是 903 条）', () => {
    const ids = Array.from({ length: 43 }, (_, i) => `p${String(i).padStart(2, '0')}`)
    const g = buildGraph(env(ids.map(id => person(id, '宜州一中404'))), S)
    const cls = ofKind(g.edges, 'class')
    expect(cls.length).toBe(42)
    expect(isConnected(ids, cls)).toBe(true)
    // 完全图的边数是 903：这条断言是「别哪天被改成 O(n²)」的最后一道闸
    expect(new Set(cls.map(pairKey)).size).toBe(42)
  })

  it('节点带上 remarkGroup，供详情面板找同班名册', () => {
    const g = buildGraph(env([person('p0', '宜州一中404'), person('p1', '宜州一中404')]), S)
    expect(g.nodes.find(n => n.id === 'p0')?.remarkGroup).toBe('宜州一中404')
    expect(g.nodes.find(n => n.id === 'p1')?.remarkGroup).toBe('宜州一中404')
  })

  it('同班成员本就有共同群边时不重复建（同两点只能有一条边）', () => {
    const g = buildGraph(
      env([
        person('pa', '宜州一中404', ['g1']),
        person('pb', '宜州一中404', ['g1']),
        person('pc', '宜州一中404'),
        person('pd', '宜州一中404'),
      ]),
      S,
    )
    const pairs = g.edges.map(pairKey)
    expect(new Set(pairs).size).toBe(pairs.length)
    // pa-pb 这条边保留「共同群」身份（观测到的共处优先于推断出的同门）
    const ab = g.edges.find(e => pairKey(e) === 'pa|pb')
    expect(ab?.kind).toBe('common')
    // 剩下的 2 条把 pc / pd 挂上（3 条锚点边里有一条被去重吃掉了）
    expect(ofKind(g.edges, 'class').length).toBe(2)
    expect(isConnected(['pa', 'pb', 'pc', 'pd'], g.edges)).toBe(true)
  })
})

describe('同备注编号边：开关与作用域', () => {
  it('remarkClass 关掉后一条班级边都不建', () => {
    const g = buildGraph(env([person('p0', '宜州一中404'), person('p1', '宜州一中404')]), { ...S, remarkClass: false })
    expect(ofKind(g.edges, 'class').length).toBe(0)
  })

  it('群组模式下不建班级边（班级是人的属性，群节点没有备注）', () => {
    const groups: EnvNode[] = [
      { id: 'g1@chatroom', label: 'g1', kind: 'group', shared_count: 1, shared_members: [{ username: 'u1', name: 'u1', is_friend: true, msg_count: 1 }], remark_group: '宜州一中404' },
      { id: 'g2@chatroom', label: 'g2', kind: 'group', shared_count: 1, shared_members: [{ username: 'u1', name: 'u1', is_friend: true, msg_count: 1 }], remark_group: '宜州一中404' },
    ]
    const g = buildGraph(env(groups), { ...S, mode: 'groups' })
    expect(ofKind(g.edges, 'class').length).toBe(0)
    // 上一行如果因为「群里本来就没有 remark_group」而通过，这条就白写了 —— 所以顺手证明共同成员边还在
    expect(ofKind(g.edges, 'common').length).toBe(1)
  })

  it('minCommon 管不到班级边（那个滑杆写的是「共同群阈值」）', () => {
    const ids = ['p0', 'p1', 'p2', 'p3']
    const g = buildGraph(env(ids.map(id => person(id, '宜州一中404'))), { ...S, minCommon: 5 })
    expect(ofKind(g.edges, 'common').length).toBe(0)
    expect(ofKind(g.edges, 'class').length).toBe(3)
  })

  it('单个成员不构成班级（各成一班时不建边）', () => {
    const g = buildGraph(env([person('p0', '宜州一中404'), person('p1', '物联本202')]), S)
    expect(ofKind(g.edges, 'class').length).toBe(0)
  })
})
