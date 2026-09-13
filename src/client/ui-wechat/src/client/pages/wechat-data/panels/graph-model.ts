/**
 * 社交图谱数据模型(移植自 st_control wechat/graph/graphModel.ts 设计)
 * GraphSnapshot → 节点/边。特性:饱和度指数半径、加权标签传播社区检测、
 * 亲密度拉力(dist/strength 随消息量指数衰减)、以「我」为枢纽。
 *
 * 另含**知识图谱 / 融合视图**（buildKnowledgeNetwork）：笔记节点 + `[[链接]]`
 * 边 + 未解析目标的 stub 节点，融合模式再叠加笔记的来源会话。
 */
import type { GraphSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { KnowledgeSnapshot } from '../types.ts'

export interface GNode {
  id: string
  label: string
  kind: 'person' | 'group' | 'self' | 'note' | 'stub'
  /** 公众号(gh_ 前缀)标记:详情/悬停显示「公众号」,「仅显示好友」时排除 */
  isOfficial?: boolean
  /** 消息量(亲密度代理);好友至少 100、非好友 80,叠加消息量 */
  weight: number
  radius: number
  /** 社区分组(-1=未分组中性灰;>=0 用 COMMUNITY_COLORS 取色) */
  community: number
  /** 亲密度拉力:消息量越高离「我」越近(people 模式) */
  intimacy?: number
  /** 好友/群友区分(悬停详情) */
  isFriend?: boolean
  /** 群成员数/共同成员数(群节点详情) */
  sharedCount?: number
  /** 共同群 code 列表(详情展示共同群名) */
  groupCodes?: string[]
  /**
   * 知识库 stub:被 `[[目标]]` 引用、但没有对应笔记的节点。
   * 画布据此画虚线描边 + 半透明,提示「这里还缺一篇笔记」而不是当成错误。
   */
  stub?: boolean
  /** note 节点:被引用次数(反链),详情展示 */
  backLinks?: number
  /** note 节点:出链数 */
  outLinks?: number
  /** note 节点:来源会话 username(融合视图连到人/群) */
  sourceUsername?: string
  /** note 节点:正文摘要(悬停详情) */
  excerpt?: string
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
}

export interface GEdge {
  source: string
  target: string
  weight: number
  dist: number
  /** 可选边强度(「我」的枢纽边随亲密度变化;普通边默认 1/min(度)) */
  strength?: number
  /** intimacy=我↔好友(消息量);common=好友↔好友(共同群数);
   *  wiki=笔记↔笔记([[链接]]);source=笔记↔来源会话(AI 问答沉淀)。 */
  kind: 'intimacy' | 'common' | 'wiki' | 'source'
  /** 双向连接:好友/群关系是互惠的,渲染时两端都显示箭头/参与邻居计算。 */
  bidirectional?: boolean
}

export interface BuiltGraph {
  nodes: GNode[]
  edges: GEdge[]
  /** 社区数量(0=未分组全部) */
  communityCount: number
}

export interface GraphSettings {
  mode: 'people' | 'groups' | 'knowledge' | 'fused'
  nodeLimit: number
  minCommon: number
  friendsOnly: boolean
  nodeScale: number
  /** 外观 */
  labelOpacity: number
  edgeWidth: number
  showArrows: boolean
  showLabels: boolean
  showGrid: boolean
  /** 节点模糊强度(px,0=关闭):对全部节点(头像/名字/圆点)做高斯模糊,连线保持清晰 */
  blurNodes: number
  /** 深度过滤:0=全部;>0=围绕选中节点的 hop 局部图 */
  depth: number
  /** 力度 */
  forceCentripetal: number
  forceRepulsion: number
  forceAttraction: number
  forceEdgeLength: number
  /** 节点间距倍率:碰撞/硬分离/弹簧下限的公共间距系数(1=默认舒适间距) */
  nodeGap: number
  /** 圈子分离度:不同社区节点对之间的额外排斥(圈与圈之间有留白) */
  communitySeparation: number
  /** 锁定布局:拖动节点不带动邻居,参数变化不自动重排 */
  lockLayout: boolean
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  mode: 'people',
  // 性能优先:默认最多渲染 250 个节点(约好友数×3/5 量级),力导向与头像加载流畅;
  // 需要更多可在「节点上限」调大。
  nodeLimit: 250,
  // 共同群阈值 =1:同一个群的人彼此有边,力导向直接聚团(参考实现默认)
  minCommon: 1,
  friendsOnly: true,
  // 性能优先:节点默认最小(降低重叠/渲染更轻),连线略细;默认关闭模糊/箭头/标签
  nodeScale: 0.4,
  labelOpacity: 0.9,
  edgeWidth: 1.3,
  showArrows: false,
  showLabels: false,
  showGrid: true,
  blurNodes: 0,
  depth: 0,
  // 力度:向心默认最大(整体聚合更紧),斥力/间距稍大让节点与圈子疏朗、连线略舒展
  forceCentripetal: 5,
  forceRepulsion: 4,
  forceAttraction: 0.25,
  forceEdgeLength: 1.05,
  nodeGap: 1.7,
  communitySeparation: 1.6,
  lockLayout: false,
}

/** 「我」节点 id(与 host 一致) */
export const SELF_ID = 'self'

/** 社区色盘(10 色,参考 st_control COMMUNITY_COLORS) */
export const COMMUNITY_COLORS = [
  '#0099ff', '#36c08f', '#f6a23c', '#ef6f6c', '#9b6dff',
  '#2bb6d6', '#e072b8', '#7e8bd9', '#5bbf6a', '#d98c4a',
]

/** 社区色:未分组(-1)→ 中性灰 */
export function communityColor(community: number): string {
  if (community < 0) return '#9aa0a6'
  const c = COMMUNITY_COLORS[community % COMMUNITY_COLORS.length]
  return c ?? '#9aa0a6'
}

/** 好友基准权重(消息量为 0 时仍可辨识),非好友较低 */
const NON_FRIEND_WEIGHT = 80
const FRIEND_BASE_WEIGHT = 100

/** 消息量(亲密度代理)→ 权重:好友至少 100、非好友 80,叠加消息量(上限 1000) */
function personWeight(isFriend: boolean, msgCount: number): number {
  const base = isFriend ? FRIEND_BASE_WEIGHT : NON_FRIEND_WEIGHT
  return base + Math.min(msgCount / 10, 1000)
}

/** 饱和度指数半径:低值增长快、高值趋平;区间 5–34,消息量差异肉眼可辨 */
function radiusByIntimacy(weight: number): number {
  const MIN_R = 5
  const MAX_R = 34
  const t = 1 - Math.exp(-weight / 200)
  return MIN_R + t * (MAX_R - MIN_R)
}

/** 平方根饱和度半径:value/divisor 归一后线性映射(群节点用) */
function radiusBySqrt(value: number, divisor: number, min: number, max: number): number {
  const t = Math.min(Math.sqrt(Math.max(value, 0)) / divisor, 1)
  return min + t * (max - min)
}

/**
 * 加权 Louvain 社区检测(确定性贪心):节点反复评估迁入邻居社区的
 * 模块度增益,只接受正增益移动。相比标签传播,「我」的枢纽边不再把
 * 所有人吸进同一个社区——共同群结构能拆出真正的社交圈子。
 * 孤立节点与成员数 <3 的社区标 -1(中性灰,与晕影成员数阈值一致)。
 */
export function detectCommunities(nodes: GNode[], edges: GEdge[]): number {
  if (nodes.length === 0) return 0
  const n = nodes.length
  const idx = new Map<string, number>(nodes.map((g, i) => [g.id, i]))
  const adj = new Map<number, Map<number, number>>()
  for (let i = 0; i < n; i++) adj.set(i, new Map())
  let m2 = 0
  for (const e of edges) {
    const a = idx.get(e.source)
    const b = idx.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    const wa = adj.get(a)
    const wb = adj.get(b)
    if (!wa || !wb) continue
    wa.set(b, (wa.get(b) ?? 0) + e.weight)
    wb.set(a, (wb.get(a) ?? 0) + e.weight)
    m2 += e.weight * 2
  }
  const comm = new Map<number, number>()
  const nodeW = new Map<number, number>()
  const commW = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    comm.set(i, i)
    let w = 0
    for (const ew of adj.get(i)?.values() ?? []) w += ew
    nodeW.set(i, w)
    commW.set(i, w)
  }
  // 模块度增益:迁入目标社区的 ΔQ 符号比较(常量分母不影响选优)
  const dq = (i: number, target: number): number => {
    const from = comm.get(i) ?? -1
    if (from === target || m2 <= 0) return 0
    let kIn = 0
    for (const [j, ew] of adj.get(i) ?? new Map<number, number>()) {
      if (comm.get(j) === target) kIn += ew
    }
    return (kIn - ((nodeW.get(i) ?? 0) * (commW.get(target) ?? 0)) / m2) / m2
  }
  for (let pass = 0; pass < 30; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      let best = comm.get(i) ?? i
      let bestDq = 0
      for (const j of adj.get(i)?.keys() ?? []) {
        const cand = comm.get(j) ?? j
        if (cand === best) continue
        const d = dq(i, cand)
        if (d > bestDq) {
          bestDq = d
          best = cand
        }
      }
      const from = comm.get(i) ?? i
      if (best !== from) {
        comm.set(i, best)
        commW.set(from, (commW.get(from) ?? 0) - (nodeW.get(i) ?? 0))
        commW.set(best, (commW.get(best) ?? 0) + (nodeW.get(i) ?? 0))
        moved = true
      }
    }
    if (!moved) break
  }
  // 孤立节点(无共同群边)与 <3 人社区 → -1 中性灰
  const memberCount = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const c = comm.get(i) ?? -1
    if ((nodeW.get(i) ?? 0) === 0) continue
    memberCount.set(c, (memberCount.get(c) ?? 0) + 1)
  }
  const remap = new Map<number, number>()
  let k = 0
  for (let i = 0; i < n; i++) {
    const g = nodes[i]
    if (!g) continue
    const c = comm.get(i) ?? -1
    if ((nodeW.get(i) ?? 0) === 0 || (memberCount.get(c) ?? 0) < 3) {
      g.community = -1
      continue
    }
    if (!remap.has(c)) remap.set(c, k++)
    g.community = remap.get(c) ?? -1
  }
  return k
}

/** GraphSnapshot → 筛选后的图(people/groups 两模式;社区检测;亲密度拉力)。 */
export function buildGraph(env: {
  nodes: Array<{
    id: string
    label: string
    kind: string
    is_friend?: boolean
    msg_count?: number
    group_count?: number
    member_count?: number
    shared_count?: number
    group_codes?: string[]
    shared_members?: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
  }>
  edges: Array<{ source: string; target: string; weight: number }>
} | null, s: GraphSettings): BuiltGraph {
  if (!env) return { nodes: [], edges: [], communityCount: 0 }
  const selfNode = env.nodes.find(n => n.kind === 'self' && n.id === 'self')
  const rawNodes = env.nodes.filter((n) => {
    if (s.mode === 'people') {
      // 「仅显示好友」:排除群、公众号与未标记好友的联系人
      if (n.kind === 'group' || n.kind === 'self') return false
      if (s.friendsOnly) return n.kind !== 'official' && n.is_friend === true
      return true
    }
    return n.kind === 'group'
  })
  // 排序:好友优先(内部按共同群数),其后群友;再整体截前 nodeLimit(参考实现语义)
  const weightOf = (n: {
    msg_count?: number
    shared_count?: number
    group_count?: number
  }): number => n.msg_count ?? n.shared_count ?? n.group_count ?? 1
  const top = [...rawNodes]
    .sort((a, b) => {
      const fa = s.mode === 'people' ? Number(a.is_friend === true) : 0
      const fb = s.mode === 'people' ? Number(b.is_friend === true) : 0
      if (fa !== fb) return fb - fa
      return weightOf(b) - weightOf(a)
    })
    .slice(0, s.nodeLimit)
  const nodes: GNode[] = [
    ...(selfNode ? [{
      id: SELF_ID,
      label: selfNode.label || '我',
      kind: 'self' as const,
      weight: 0,
      radius: 16,
      community: -1,
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    }] : []),
    ...top.map(n => ({
      id: n.id,
      label: n.label,
      kind: (n.kind === 'group' ? 'group' : 'person') as GNode['kind'],
      ...(n.kind === 'official' ? { isOfficial: true } : {}),
      weight: s.mode === 'people'
        ? personWeight(n.is_friend === true, n.msg_count ?? 0)
        : Math.max(1, weightOf(n)),
      // 基础半径(不乘 nodeScale):节点大小作为外观参数,由画布侧统一应用
      radius: s.mode === 'people'
        ? radiusByIntimacy(personWeight(n.is_friend === true, n.msg_count ?? 0))
        : radiusBySqrt(n.shared_count ?? 0, 8, 9, 18),
      community: -1,
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      ...(n.msg_count !== undefined ? { intimacy: n.msg_count } : {}),
      ...(n.is_friend !== undefined ? { isFriend: n.is_friend } : {}),
      ...(n.shared_count !== undefined || n.member_count !== undefined ? { sharedCount: n.shared_count ?? n.member_count } : {}),
      ...(n.group_codes && n.group_codes.length > 0 ? { groupCodes: n.group_codes } : {}),
    })),
  ]
  // 边派生:people=共同群数交集;groups=共同成员数交集
  const byGroup = new Map<string, string[]>()
  const byMember = new Map<string, string[]>()
  for (const n of top) {
    if (s.mode === 'people') {
      for (const c of n.group_codes ?? []) {
        let arr = byGroup.get(c)
        if (!arr) { arr = []; byGroup.set(c, arr) }
        arr.push(n.id)
      }
    } else {
      for (const m of n.shared_members ?? []) {
        let arr = byMember.get(m.username)
        if (!arr) { arr = []; byMember.set(m.username, arr) }
        arr.push(n.id)
      }
    }
  }
  // 群内配对预算:每个群只取权重最高的 80 名成员参与配对
  // (大群全配对是 O(G²) 灾难:500 人群 12.5 万对、1 万人群 5 千万对;
  //  且同群内边权重多为 1,截掉弱尾部不影响结构)
  const GROUP_PAIR_MEMBERS = 80
  const edgeW = new Map<string, number>()
  for (const [, list] of (s.mode === 'people' ? byGroup : byMember)) {
    if (list.length < 2) continue
    const members = list.length > GROUP_PAIR_MEMBERS ? list.slice(0, GROUP_PAIR_MEMBERS) : list
    for (let i = 0; i < members.length; i++) {
      const ai = members[i]
      if (!ai) continue
      for (let j = i + 1; j < members.length; j++) {
        const bj = members[j]
        if (!bj) continue
        const key = ai < bj ? ai + '|' + bj : bj + '|' + ai
        edgeW.set(key, (edgeW.get(key) ?? 0) + 1)
      }
    }
  }
  const edges: GEdge[] = [...edgeW.entries()]
    .map(([key, w]) => {
      const [a, b] = key.split('|')
      return {
        source: a ?? '', target: b ?? '', weight: w,
        // 基础目标距离只随权重变化;「连线长度」由仿真侧统一应用(避免二次方)
        dist: (s.mode === 'people' ? 200 : 220) / Math.sqrt(Math.max(w, 1)),
        kind: 'common' as const,
        bidirectional: true,
      }
    })
    .filter(e => e.source && e.target && e.weight >= s.minCommon)
  edges.sort((a, b) => b.weight - a.weight)
  // 「我」→ 每个节点的亲密度连线(消息量→距离/强度指数衰减,参照参考实现 intimacyPull)
  const intimacy: GEdge[] = []
  if (selfNode) {
    for (const n of top) {
      const w = s.mode === 'people'
        ? personWeight(n.is_friend === true, n.msg_count ?? 0)
        : Math.max(1, weightOf(n))
      const t = 1 - Math.exp(-w / (s.mode === 'people' ? 600 : 60))
      intimacy.push({
        source: SELF_ID, target: n.id,
        weight: n.is_friend === true && s.mode === 'people' ? Math.max(1, n.group_count ?? 0) : Math.max(1, n.msg_count ?? 0),
        // 亲密度距离只随亲密度变化;「连线长度」由仿真侧统一应用
        dist: 340 - t * 260,
        strength: 0.02 + t * 0.16,
        kind: 'intimacy',
        bidirectional: true,
      })
    }
  }
  // 社区检测只跑在「共同群/共同成员」边上(「我」的枢纽亲密度边不参与),
  // 否则标签会把所有人吸进同一个圈子;self 无共同边 → 自然保持中性灰
  const communityCount = detectCommunities(nodes, edges)
  return { nodes, edges: [...intimacy, ...edges.slice(0, Math.max(0, 6000 - intimacy.length))], communityCount }
}

/** 节点邻居集合(悬停高亮用)。 */
export function neighboursOf(graph: BuiltGraph, id: string): Set<string> {
  const out = new Set<string>()
  for (const e of graph.edges) {
    if (e.source === id) out.add(e.target)
    else if (e.target === id) out.add(e.source)
  }
  return out
}

/** 局部子图:围绕 focusId 的 depth 跳邻域(深度过滤)。 */
export function localGraph(graph: BuiltGraph, focusId: string, depth: number): BuiltGraph {
  if (depth <= 0) return graph
  const seen = new Map<string, number>([[focusId, 0]])
  const stack = [focusId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) continue
    const d = seen.get(id) ?? 0
    if (d >= depth) continue
    for (const e of graph.edges) {
      const other = e.source === id ? e.target : e.target === id ? e.source : null
      if (other === null || seen.has(other)) continue
      seen.set(other, d + 1)
      stack.push(other)
    }
  }
  const nodes = graph.nodes.filter(n => seen.has(n.id))
  const ids = new Set(nodes.map(n => n.id))
  const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target))
  return { nodes, edges, communityCount: graph.communityCount }
}

/** 圈子概览:按成员数降序分组(self 不参与、community < 0 排除)。 */
export function groupCommunities(graph: BuiltGraph): Array<{ id: number; members: GNode[] }> {
  const map = new Map<number, GNode[]>()
  for (const n of graph.nodes) {
    if (n.kind === 'self' || n.community < 0) continue
    const arr = map.get(n.community) ?? []
    arr.push(n)
    map.set(n.community, arr)
  }
  return [...map.entries()]
    .map(([id, members]) => ({ id, members }))
    .sort((a, b) => b.members.length - a.members.length)
}

/** 与指定节点相连的边(按权重降序,含对端节点解析;默认取前 12)。 */
export function connectedEdgesOf(
  graph: BuiltGraph,
  nodeId: string,
  limit = 12,
): Array<{ edge: GEdge; other: GNode | undefined }> {
  return graph.edges
    .filter(e => e.source === nodeId || e.target === nodeId)
    .map(e => ({
      edge: e,
      other: graph.nodes.find(x => x.id === (e.source === nodeId ? e.target : e.source)),
    }))
    .sort((a, b) => b.edge.weight - a.edge.weight)
    .slice(0, limit)
}

/** 共同群名(详情展示,群名缺失时回退 code)。 */
export function sharedGroupNames(
  n: GNode,
  groupNames: Record<string, string> | undefined,
  limit = 6,
): string[] {
  return (n.groupCodes ?? [])
    .map(c => groupNames?.[c] || c)
    .slice(0, limit)
}

/* rankNodes / communityOf 曾服务于已删除的 canvas 版图渲染器 graph-canvas.tsx(零引用),
   存活的 EchartsGraphCanvas 直接使用节点自带字段,故一并移除。 */

/* ── 知识图谱 / 融合视图 ───────────────────────────────────────────────
 *
 * 与社交图谱分开构建、由面板按 mode 二选一：社交侧节点口径是「联系人/群/我」，
 * 知识侧是「笔记/未解析目标」。两者 id 空间不同（note:<id> / kb:<key> vs username / self），
 * 因此可以安全地放进同一张图；融合视图靠笔记的 sourceUsername 把两边接起来。
 */

/** 知识节点半径:链接越多越大(复用好友侧的饱和度手感)。
 *  区间刻意比好友侧大：nodeScale 默认 0.4，若基数太小会被画布的 8px 下限压平，
 *  链接数不同的笔记就长得一样大、看不出结构。 */
function radiusByLinks(links: number): number {
  return radiusBySqrt(links, 6, 16, 46)
}

/**
 * 构建知识网络（mode='knowledge'）或融合视图（mode='fused'）。
 * @param knowledge - 知识图谱快照（笔记 + stub + wiki 边）。
 * @param social - 社交图谱快照（融合视图取来源会话节点）。
 * @param s - 图谱设置；`mode` 决定是否叠加来源会话。
 * @returns BuiltGraph —— 与社交侧同构，画布无需区分数据来源。
 */
export function buildKnowledgeNetwork(
  knowledge: KnowledgeSnapshot | null,
  social: GraphSnapshot | null,
  s: GraphSettings,
): BuiltGraph {
  if (!knowledge) return { nodes: [], edges: [], communityCount: 0 }
  const fused = s.mode === 'fused'

  const noteNodes: GNode[] = knowledge.notes.map(n => {
    const links = n.outLinks + n.backLinks
    return {
      id: 'note:' + n.id,
      label: n.title,
      kind: 'note' as const,
      // weight 沿用好友侧的语义(消息量→亲密度)，这里换成「连接度」。
      weight: 100 + Math.min(links * 20, 900),
      radius: radiusByLinks(links),
      community: -1,
      backLinks: n.backLinks,
      outLinks: n.outLinks,
      ...(n.sourceUsername ? { sourceUsername: n.sourceUsername } : {}),
      ...(n.excerpt ? { excerpt: n.excerpt } : {}),
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    }
  })

  // stub 不参与 nodeLimit 截断：它是「缺口提示」，数量本就很少，截掉就失去意义。
  const stubNodes: GNode[] = knowledge.stubs.map(st => ({
    id: 'kb:' + st.key,
    label: st.label,
    kind: 'stub' as const,
    stub: true,
    weight: 40 + Math.min(st.refCount * 20, 200),
    radius: 12,
    community: -1,
    backLinks: st.refCount,
    excerpt: `被 ${st.refCount} 处引用，尚无同名笔记`,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
  }))

  const edges: GEdge[] = knowledge.edges.map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    // [[链接]] 是有向语义关系，距离给固定基准，长度缩放交给仿真侧统一处理。
    dist: 150 / Math.sqrt(Math.max(e.weight, 1)),
    kind: 'wiki' as const,
  }))

  // 融合：把笔记的来源会话（人/群）拉进来，并以 source 边连到笔记。
  const personNodes: GNode[] = []
  if (fused && social) {
    const wanted = new Set<string>()
    for (const n of knowledge.notes) if (n.sourceUsername) wanted.add(n.sourceUsername)
    const socialById = new Map(social.nodes.map(n => [n.id, n]))
    for (const username of wanted) {
      const src = socialById.get(username)
      if (!src) continue
      const isGroup = src.kind === 'group'
      personNodes.push({
        id: src.id,
        label: knowledge.sessionNames[username] || src.label || username,
        kind: isGroup ? 'group' : 'person',
        weight: isGroup
          ? Math.max(1, src.shared_count ?? 1)
          : personWeight(src.is_friend === true, src.msg_count ?? 0),
        radius: isGroup
          ? radiusBySqrt(src.shared_count ?? 0, 8, 9, 18)
          : radiusByIntimacy(personWeight(src.is_friend === true, src.msg_count ?? 0)),
        community: -1,
        ...(src.is_friend !== undefined ? { isFriend: src.is_friend } : {}),
        ...(src.kind === 'official' ? { isOfficial: true } : {}),
        x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      })
    }
    personNodes.sort((a, b) => b.weight - a.weight)
    if (personNodes.length > s.nodeLimit) personNodes.length = s.nodeLimit
    const kept = new Set(personNodes.map(n => n.id))
    for (const n of knowledge.notes) {
      if (!n.sourceUsername || !kept.has(n.sourceUsername)) continue
      edges.push({
        source: 'note:' + n.id,
        target: n.sourceUsername,
        weight: 1,
        dist: 220,
        kind: 'source' as const,
        bidirectional: true,
      })
    }
  }

  const limit = Math.max(1, s.nodeLimit)
  const keptNotes = noteNodes.length > limit ? noteNodes.slice(0, limit) : noteNodes
  const allNodes = [...keptNotes, ...stubNodes, ...personNodes]
  const ids = new Set(allNodes.map(n => n.id))
  const keptEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target))

  // 社区检测只喂「笔记 + 融合进来的人」：stub 是缺口而非圈子成员，
  // 把「尚未存在的笔记」分进某个圈子会产生误导，因此让它保持中性灰。
  const communityCount = detectCommunities([...keptNotes, ...personNodes], keptEdges)
  return { nodes: allNodes, edges: keptEdges, communityCount }
}
