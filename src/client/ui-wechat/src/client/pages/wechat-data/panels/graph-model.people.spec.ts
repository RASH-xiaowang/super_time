/**
 * 社交图谱的**建边**口径：同群成员之间的共同边、以及它必须是双向的。
 *
 * 为什么单独有这个文件：`graph-model.ts` 的 people / groups 分支此前没有任何用例 ——
 * 只有 `graph-model.stub.spec.ts` 覆盖知识网络那一侧。于是「同群成员之间有没有生成边」
 * 这件事在生产代码里是**无人看守**的，而它正是用户报障的那一条。
 *
 * 真机实测（251 节点 / 998 边）的结论，也是本文件的判据来源：
 *   ① 生成侧一条不缺 —— 748 条同群关系与按 `group_codes` 独立推出的关系**逐条相等**，
 *      且 748/748 全部 `bidirectional: true`；
 *   ② 缺的是**画出来**（预算只放得下 226 条），那一层由 `graph-canvas.spec.ts` 守。
 * 所以这里守的是①：别让建边这一侧先坏掉，否则画布那边再怎么修都没有可画的东西。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, DEFAULT_GRAPH_SETTINGS, type GraphSettings } from './graph-model.ts'

/** 造一个原始快照节点（后端 queryGraph 的字段形状）。 */
interface RawNode {
  id: string
  label: string
  kind: string
  is_friend?: boolean
  msg_count?: number
  group_count?: number
  group_codes?: string[]
  shared_count?: number
  member_count?: number
  shared_members?: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
}

const SELF: RawNode = { id: 'self', label: '我', kind: 'self' }

/** 好友：`codes` 是它所在的群。 */
function friend(id: string, codes: string[], msg = 100): RawNode {
  return {
    id, label: id, kind: 'contact', is_friend: true,
    msg_count: msg, group_count: codes.length, group_codes: codes,
  }
}

/** 群：`members` 是与联系人表的交集（后端 shared_members 的前 GROUP_MEMBER_CAP=200 名口径）。 */
function group(id: string, members: string[], shared = members.length): RawNode {
  return {
    id, label: id, kind: 'group',
    member_count: shared, shared_count: shared,
    shared_members: members.map(u => ({ username: u, name: u, is_friend: true, msg_count: 100 })),
  }
}

const people: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, mode: 'people', nodeLimit: 250, friendsOnly: true, minCommon: 1 }
const groupsMode: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, mode: 'groups', nodeLimit: 250, minCommon: 1 }

/** 取所有共同边（同群关系的载体）。 */
function commonEdges(nodes: RawNode[], s: GraphSettings = people) {
  return buildGraph({ nodes: nodes as never, edges: [] }, s).edges.filter(e => e.kind === 'common')
}

describe('同群成员之间必须生成共同边（且是双向的）', () => {
  it('★ 同群 3 人 → 3 对全部生成，且每对都 bidirectional=true', () => {
    const edges = commonEdges([SELF, friend('a', ['g1']), friend('b', ['g1']), friend('c', ['g1'])])
    expect(edges.length).toBe(3)
    for (const e of edges) {
      expect(e.kind).toBe('common')
      expect(e.bidirectional, `同群边 ${e.source}-${e.target} 丢了双向标记`).toBe(true)
      expect(e.weight).toBe(1)
    }
  })

  it('n 个同群成员 → C(n,2) 对，一对不少', () => {
    for (const n of [2, 3, 5, 8, 19]) {
      const nodes: RawNode[] = [SELF, ...Array.from({ length: n }, (_, i) => friend(`p${i}`, ['g1']))]
      expect(commonEdges(nodes).length, `${n} 人同群应得 ${(n * (n - 1)) / 2} 对`).toBe((n * (n - 1)) / 2)
    }
  })

  it('共同群数累加进权重（两个群都重合 → weight 2）', () => {
    const edges = commonEdges([SELF, friend('a', ['g1', 'g2']), friend('b', ['g1', 'g2'])])
    expect(edges.length).toBe(1)
    expect(edges[0]?.weight).toBe(2)
  })

  it('没有共同群的人之间**不**生成共同边（别把没关系的人连起来）', () => {
    const edges = commonEdges([SELF, friend('a', ['g1']), friend('b', ['g2']), friend('c', [])])
    expect(edges).toEqual([])
  })

  it('边没有方向偏好：source/target 谁在前只由 id 决定，不是「单向」', () => {
    // 同一个人对，换 id 的字典序应当只是让 source/target 互换，边本身仍是同一条
    const forward = commonEdges([SELF, friend('aaa', ['g1']), friend('zzz', ['g1'])])
    expect(forward.length).toBe(1)
    const e = forward[0]
    expect([e?.source, e?.target].sort()).toEqual(['aaa', 'zzz'])
    expect(e?.bidirectional).toBe(true)
  })

  it('minCommon 阈值只筛「共同群数」弱的边，不去筛双向标记', () => {
    const nodes = [SELF, friend('a', ['g1', 'g2']), friend('b', ['g1', 'g2']), friend('c', ['g3']), friend('d', ['g3'])]
    const strict = commonEdges(nodes, { ...people, minCommon: 2 })
    expect(strict.length).toBe(1)              // 只剩 a-b（共同 2 个群）
    expect(strict[0]?.bidirectional).toBe(true)
  })

  it('我 → 每个节点都有亲密度边，且同样双向（枢纽关系也是互惠的）', () => {
    const built = buildGraph({ nodes: [SELF, friend('a', ['g1']), friend('b', ['g2'])] as never, edges: [] }, people)
    const intimacy = built.edges.filter(e => e.kind === 'intimacy')
    expect(intimacy.length).toBe(2)
    for (const e of intimacy) {
      expect(e.source).toBe('self')
      expect(e.bidirectional).toBe(true)
    }
  })

  it('nodeLimit 截断后，共同边只涉及被保留的节点（不产生悬空端点）', () => {
    const nodes: RawNode[] = [SELF, ...Array.from({ length: 30 }, (_, i) => friend(`p${i}`, ['g1'], 500 - i))]
    const built = buildGraph({ nodes: nodes as never, edges: [] }, { ...people, nodeLimit: 10 })
    const ids = new Set(built.nodes.map(n => n.id))
    expect(built.nodes.length).toBe(11)
    for (const e of built.edges) {
      expect(ids.has(e.source), `边端点 ${e.source} 不在渲染集合里`).toBe(true)
      expect(ids.has(e.target), `边端点 ${e.target} 不在渲染集合里`).toBe(true)
    }
    // 10 个同群好友之间仍然是 C(10,2)=45 对
    expect(built.edges.filter(e => e.kind === 'common').length).toBe(45)
  })

  it('「仅显示好友」把非好友挡在外面时，同群关系只在留下的人之间建立', () => {
    const nodes: RawNode[] = [
      SELF,
      friend('a', ['g1']),
      friend('b', ['g1']),
      { id: 'c', label: 'c', kind: 'contact', is_friend: false, msg_count: 10, group_count: 1, group_codes: ['g1'] },
    ]
    expect(commonEdges(nodes).length).toBe(1)                                  // 只剩 a-b
    expect(commonEdges(nodes, { ...people, friendsOnly: false }).length).toBe(3) // a-b / a-c / b-c
  })
})

describe('群组网络里的「共同成员」关系', () => {
  it('两个群共享成员 → 一条双向边', () => {
    const nodes = [SELF, friend('a', ['g1', 'g2']), group('g1', ['a']), group('g2', ['a'])]
    const built = buildGraph({ nodes: nodes as never, edges: [] }, groupsMode)
    expect(built.nodes.filter(n => n.kind === 'group').length).toBe(2)
    const common = built.edges.filter(e => e.kind === 'common')
    expect(common.length).toBe(1)
    expect(common[0]?.bidirectional).toBe(true)
  })

  it('共享成员越多，权重越高', () => {
    const nodes = [
      SELF,
      friend('a', ['g1', 'g2']), friend('b', ['g1', 'g2']), friend('c', ['g1', 'g2']),
      group('g1', ['a', 'b', 'c']), group('g2', ['a', 'b', 'c']),
    ]
    const common = buildGraph({ nodes: nodes as never, edges: [] }, groupsMode).edges.filter(e => e.kind === 'common')
    expect(common.length).toBe(1)
    expect(common[0]?.weight).toBe(3)
  })

  it('只有一个群时不产生任何共同边（一个群谈不上「群之间」）', () => {
    const nodes = [SELF, friend('a', ['g1']), group('g1', ['a'])]
    expect(buildGraph({ nodes: nodes as never, edges: [] }, groupsMode).edges.filter(e => e.kind === 'common')).toEqual([])
  })
})
