/**
 * 首字连边（`kind: 'initial'`）的建边行为锁定（`graph-model.ts` 的 `buildGraph` + `firstCharKey`）。
 *
 * 规则只有一句话：**第一个字符完全相同**才建边，不同者之间一条线都不许有。
 * 正因为规则这么简单，反而全是容易写错又看不出来的地方：
 *   ① 归一化做多了（取拼音/切词）或做少了（`-张三` 与 `张三` 分家）都会**静默**改变分组；
 *   ② 去重是两类推断边（class / initial）**共用**一个点对集合，漏一处就会同两点两条边
 *      （详情面板 React key 撞、度数虚高）；
 *   ③ 自环（分组时把同一 id 和自己配对）在画布上表现为「节点上挂个圈」；
 *   ④ 这层是 C(n,2) 量级的候选，不按余量截断就会把「共同群」这类真实观测边挤掉
 *      —— 真机实测：默认视图候选 1534 对，可用余量只有 224 条。
 * 真机默认视图 250 人里，首字组 34 个、最大一组 36 人（「宜」）—— 所以④不是理论风险。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  DEFAULT_GRAPH_SETTINGS,
  firstCharKey,
  type GEdge,
  type GraphSettings,
} from './graph-model.ts'
import { edgeDensityCap, edgeHeadroom } from './graph-budget.ts'
import { selectEdges } from './graph-canvas.ts'

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

/** 首字层关掉，用于「对照」；单独打开时才测首字层。 */
const OFF: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, firstChar: false }
const ON: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, firstChar: true }

function person(id: string, label: string, groupCodes: string[] = [], remarkGroup?: string): EnvNode {
  return {
    id,
    label,
    kind: 'contact',
    is_friend: true,
    msg_count: 0,
    group_count: groupCodes.length,
    group_codes: groupCodes,
    ...(remarkGroup ? { remark_group: remarkGroup } : {}),
  }
}

function env(nodes: EnvNode[]): { nodes: EnvNode[]; edges: Array<{ source: string; target: string; weight: number }> } {
  return { nodes, edges: [] }
}

const pairKey = (e: GEdge): string => (e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source)
const ofKind = (edges: GEdge[], kind: GEdge['kind']): GEdge[] => edges.filter(e => e.kind === kind)
const build = (nodes: EnvNode[], s: GraphSettings = ON) => buildGraph(env(nodes) as never, s)

describe('firstCharKey：只取第一个字符，归一化不改变语义', () => {
  it('汉字取首字；同一首字归一键相同，不同首字键不同', () => {
    expect(firstCharKey('张三')).toBe('张')
    expect(firstCharKey('张四')).toBe('张')
    expect(firstCharKey('李三')).toBe('李')
    expect(firstCharKey('张三')).not.toBe(firstCharKey('李三'))
  })

  it('只比较第一个字符：第二个字符不同不影响（这就是规则本身）', () => {
    expect(firstCharKey('宜州一中404韦杰龙')).toBe('宜')
    expect(firstCharKey('宜州一中1410覃宇森')).toBe('宜')
  })

  it('去前导空白与标点，否则「-张三」会被单独归一组', () => {
    expect(firstCharKey(' 张三')).toBe('张')
    expect(firstCharKey('-张三')).toBe('张')
    expect(firstCharKey('_张三')).toBe('张')
    expect(firstCharKey('【官方】张三')).toBe('官')
    expect(firstCharKey('（张三）')).toBe('张')
    expect(firstCharKey('法院_梧州中院_平')).toBe('法')
  })

  it('全角折半角、ASCII 大小写归一（"Ａ" 与 "a" 是同一个首字）', () => {
    expect(firstCharKey('Ａlice')).toBe('a')
    expect(firstCharKey('Alice')).toBe('a')
    expect(firstCharKey('alice')).toBe('a')
    // 真机全量库里 A 组 62 人 / a 组 79 人，不折叠会把同一批人拆成两组
    expect(firstCharKey('Apifox')).toBe(firstCharKey('ai 回复机器人'))
  })

  it('首字符是 emoji 时继续往后取第一个实义字符（否则会归出「🔥 组」这种无意义簇）', () => {
    expect(firstCharKey('🔥张三')).toBe('张')
    expect(firstCharKey('💼小万今天也在努力上班')).toBe('小')
  })

  it('空标签 / 纯标点 → 空键（该节点不参与首字层）', () => {
    expect(firstCharKey('')).toBe('')
    expect(firstCharKey('   ')).toBe('')
    expect(firstCharKey('---')).toBe('')
  })
})

describe('首字相同 → 建边；首字不同 → 一条都不建', () => {
  it('★ 首字不同的任意两人之间，绝不能有 initial 边', () => {
    const people = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十']
      .map((label, i) => person(`u${i}`, label))
    const edges = ofKind(build(people).edges, 'initial')
    // 8 个人 8 个不同首字 → 一个组都凑不出来
    expect(edges).toEqual([])
    for (const e of edges) {
      expect(firstCharKey(String(e.source))).toBe(firstCharKey(String(e.target)))
    }
  })

  it('★ 每一条 initial 边的两端，首字键必然相同（全量不变量）', () => {
    const labels = ['张三', '张四', '张五', '李三', '李四', ' Alice', '-王五', '王六', '王七']
    const nodes = labels.map((label, i) => person(`u${i}`, label))
    const byId = new Map(nodes.map(n => [n.id, n.label]))
    const edges = ofKind(build(nodes).edges, 'initial')
    expect(edges.length).toBeGreaterThan(0)
    for (const e of edges) {
      const ka = firstCharKey(byId.get(String(e.source)) ?? '')
      const kb = firstCharKey(byId.get(String(e.target)) ?? '')
      expect(ka, `边 ${e.source}-${e.target} 两端首字不同`).toBe(kb)
    }
  })

  it('首字相同的人两两相连（小组、余量充足时不漏一对）', () => {
    const nodes = ['张三', '张四', '张五'].map((label, i) => person(`u${i}`, label))
    const edges = ofKind(build(nodes).edges, 'initial')
    expect(edges.length).toBe(3) // C(3,2)
    expect(new Set(edges.map(pairKey))).toEqual(new Set(['u0|u1', 'u0|u2', 'u1|u2']))
  })

  it('开关关闭 → 一条 initial 边都没有（可精确复原）', () => {
    const nodes = ['张三', '张四', '张五', '张六'].map((label, i) => person(`u${i}`, label))
    expect(ofKind(build(nodes, OFF).edges, 'initial')).toEqual([])
    expect(ofKind(build(nodes, ON).edges, 'initial').length).toBe(6) // C(4,2)
  })

  it('群组模式不产生首字边（首字层是「网名/备注」的属性，与群名无关）', () => {
    const groups: EnvNode[] = [
      { id: 'g1@chatroom', label: '张三群', kind: 'group', shared_count: 5, shared_members: [] },
      { id: 'g2@chatroom', label: '张四群', kind: 'group', shared_count: 5, shared_members: [] },
      { id: 'g3@chatroom', label: '张五群', kind: 'group', shared_count: 5, shared_members: [] },
    ]
    const edges = ofKind(build(groups, { ...ON, mode: 'groups' }).edges, 'initial')
    expect(edges).toEqual([])
  })
})

describe('去重：无自环、无重复点对（含与 class / common 跨类型）', () => {
  it('没有自环（source !== target）', () => {
    // 故意让一批人的 label 完全相同 —— 最容易在分组时把 id 和自己配成一对
    const nodes = ['张三', '张三', '张三', '张三'].map((label, i) => person(`u${i}`, label))
    for (const e of build(nodes).edges) {
      expect(e.source, `出现自环 ${e.source}`).not.toBe(e.target)
    }
  })

  it('同一对节点在整张图里只有一条边（跨 kind 也不重复）', () => {
    const nodes = ['张三', '张四', '李三', '李四', '王五', '王六']
      .map((label, i) => person(`u${i}`, label, i < 2 ? ['g1'] : []))
    const keys = build(nodes).edges.map(pairKey)
    expect(new Set(keys).size, '出现重复点对（React key 会撞、度数虚高）').toBe(keys.length)
  })

  it('已有「共同群」边的点对不再加首字边（共同群优先）', () => {
    const nodes = [person('u0', '张三', ['g1']), person('u1', '张四', ['g1'])]
    const edges = build(nodes).edges
    expect(ofKind(edges, 'common').length).toBe(1)
    expect(ofKind(edges, 'initial').length).toBe(0)
  })

  it('既是同班又同首字时，只有「同备注编号」边（class 优先于 initial）', () => {
    // 两人同班（宜州一中404）且首字都是「宜」
    const nodes = [
      person('u0', '宜州一中404韦杰龙', [], '宜州一中404'),
      person('u1', '宜州一中404黎定', [], '宜州一中404'),
    ]
    const edges = build(nodes).edges
    expect(ofKind(edges, 'class').length).toBe(1)
    expect(ofKind(edges, 'initial').length).toBe(0)
    expect(new Set(edges.map(pairKey)).size).toBe(edges.length)
  })

  it('每条 initial 边都带 bidirectional 标记（无向：不是两条反向边）', () => {
    const nodes = ['张三', '张四', '张五'].map((label, i) => person(`u${i}`, label))
    const edges = ofKind(build(nodes).edges, 'initial')
    expect(edges.length).toBeGreaterThan(0)
    for (const e of edges) expect(e.bidirectional, `${e.source}-${e.target} 丢了双向标记`).toBe(true)
  })
})

describe('额度：候选是 C(n,2) 量级，必须按余量截断，且不许挤掉真实观测边', () => {
  it('★ 大首字组被余量截断，且「共同群」边一条不牺牲', () => {
    // 100 个「张*」→ 候选 C(100,2)=4950 条，而余量只有 405 条
    const people = Array.from({ length: 100 }, (_, i) => person(`z${i}`, `张${i}`))
    // 再放两个有共同群的人（真实观测边），它们必须活下来
    const withGroup = [person('ga', '阿甲', ['g1']), person('gb', '阿乙', ['g1'])]
    const nodes = [...people, ...withGroup]

    // 余量 = 密度上限 edgeDensityCap(节点数) − 已占用的边（此处是那 1 条共同群边）
    const on = build(nodes, ON)
    const off = build(nodes, OFF)
    const n = off.nodes.length
    const commonCount = ofKind(off.edges, 'common').length
    const expectedHeadroom = edgeHeadroom(n, commonCount + ofKind(off.edges, 'intimacy').length)
    const initial = ofKind(on.edges, 'initial')

    expect(initial.length).toBeGreaterThan(0)
    expect(initial.length).toBeLessThanOrEqual(expectedHeadroom)
    // 候选远超余量 → 应当正好用满余量（不是「只画了生成树」）
    expect(initial.length).toBe(expectedHeadroom)
    // 共同群边：开/关首字层都一样（没被挤掉）
    expect(ofKind(on.edges, 'common').length).toBe(commonCount)
    expect(commonCount).toBe(1)
    // 模型总边数正好落在密度上限内 → 绘制层不会截掉任何一条
    expect(selectEdges(on.edges, on.nodes).length).toBe(on.edges.length)
  })

  it('★ 生成树保底：每个首字组的成员之间是连通的（不会有人被落下）', () => {
    // 40 人一组；余量（edgeDensityCap(41)=300 减去亲密度 40 = 260）远小于候选 780 条
    const nodes = Array.from({ length: 40 }, (_, i) => person(`z${i}`, `张${i}`))
    const graph = build(nodes, ON)
    const initial = ofKind(graph.edges, 'initial')

    // 从任一成员出发，经 initial 边应能走遍全组
    const adj = new Map<string, string[]>()
    for (const e of initial) {
      for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
        let arr = adj.get(String(a))
        if (!arr) { arr = []; adj.set(String(a), arr) }
        arr.push(String(b))
      }
    }
    const seen = new Set<string>(['z0'])
    const stack = ['z0']
    while (stack.length) {
      const cur = stack.pop() as string
      for (const nx of adj.get(cur) ?? []) {
        if (!seen.has(nx)) { seen.add(nx); stack.push(nx) }
      }
    }
    const members = graph.nodes.filter(nd => nd.label.startsWith('张')).map(nd => nd.id)
    expect(members.length).toBe(40)
    expect(seen.size, '有的同首字成员在首字层上是孤立的').toBe(members.length)
  })

  it('余量用完时不再新增（关掉 class 腾出的余量会被首字层用上，但不超上限）', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => person(`z${i}`, `张${i}`))
    const on = build(nodes, ON)
    const n = on.nodes.length
    const intimacy = ofKind(on.edges, 'intimacy').length
    // 首字层 + 亲密度 不得超过密度上限
    const initial = ofKind(on.edges, 'initial').length
    expect(intimacy + initial).toBeLessThanOrEqual(edgeDensityCap(n))
  })
})
