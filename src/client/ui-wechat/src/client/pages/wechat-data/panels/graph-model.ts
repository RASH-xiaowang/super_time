/**
 * 社交图谱数据模型(移植自 st_control wechat/graph/graphModel.ts 设计)
 * GraphSnapshot → 节点/边。特性:饱和度指数半径、加权标签传播社区检测、
 * 亲密度拉力(dist/strength 随消息量指数衰减)、以「我」为枢纽。
 *
 * 另含**知识图谱**（buildKnowledgeNetwork）：笔记节点 + `[[链接]]` 边 + 未解析目标的
 * stub 节点。**它的节点一律来自笔记库本身**（`wechat_notes.db`）：笔记 + 「被引用但
 * 还没写」的待补目标。曾经有过一个 `mode='fused'` 把来源会话（人/群）也叠进这张图，
 * 那会把通讯录数据混进知识图谱，已按产品要求移除 —— 别再加回来。
 */
import type { GraphSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { KnowledgeSnapshot } from '../types.ts'
import { edgeDensityCap, edgeHeadroom, OBSERVED_EDGE_CAP } from './graph-budget.ts'

export interface GNode {
  id: string
  label: string
  kind: 'person' | 'group' | 'self' | 'note' | 'stub' | 'file' | 'section' | 'entity'
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
  /** 备注里的班级/批次键(宜州一中404);详情面板据此列出同班名册 */
  remarkGroup?: string
  /**
   * 知识库 stub:被 `[[目标]]` 引用、但没有对应笔记的节点。
   * 画布据此画虚线描边 + 半透明,提示「这里还缺一篇笔记」而不是当成错误。
   */
  stub?: boolean
  /** note 节点:被引用次数(反链),详情展示 */
  backLinks?: number
  /** note 节点:出链数 */
  outLinks?: number
  /** note 节点:来源会话 username(AI 问答沉淀)。仅用于「跳回来源聊天」的入口按钮，
   *  不作为图的节点 —— 人/群属通讯录数据，见 buildKnowledgeNetwork 的文件头约束。 */
  sourceUsername?: string
  /** note 节点:正文摘要(悬停详情) */
  excerpt?: string
  /** file 节点：扩展名 / 分块数 / 字数 / 解析状态（详情面板与悬停用）。 */
  fileMeta?: { ext: string; chunkCount: number; charCount: number; parseState: string }
  /** section 节点：出现过这一节的文件 id。跨文件同名才合并，所以这条列表
   *  就是「哪些资料讲的是同一块内容」，详情面板直接列出来。 */
  sectionFileIds?: number[]
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
   *  wiki=笔记↔笔记([[链接]]);source=笔记↔来源会话(**已停用**:随「节点只来自知识库」
   *  的约束一并删除,不再有任何产出方;保留枚举只是不动画布现有的取色分支);
   *  class=同备注编号(同班级/同批次,由用户自己的备注结构推得);
   *  initial=首字相同(网名/备注的第一个字符一样,见 firstCharKey);
   *  contain=文件↔章节(这一节确实在这份文件里,是**结构事实**,归观测层);
   *  mention=笔记↔文件(笔记标题作为连续子串出现在文件正文里,是**推断**,归推断层)。 */
  kind: 'intimacy' | 'common' | 'wiki' | 'source' | 'class' | 'initial' | 'contain' | 'mention' | 'suggest'
  /** 双向连接:好友/群关系是互惠的,渲染时两端都显示箭头/参与邻居计算。 */
  bidirectional?: boolean
}

export interface BuiltGraph {
  nodes: GNode[]
  edges: GEdge[]
  /** 社区数量(0=未分组全部) */
  communityCount: number
}

/** 实体类别 → 中文。详情与气泡里要说「模型推断的人名」，而不是裸的 `person`。 */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  person: '人名', org: '机构', product: '产品', place: '地名', topic: '主题词',
}

export interface GraphSettings {
  /** `knowledge` = 知识网络（节点全部来自笔记库）；没有「融合」档 —— 见文件头注释。 */
  mode: 'people' | 'groups' | 'knowledge'
  nodeLimit: number
  minCommon: number
  friendsOnly: boolean
  /** 同备注编号连边(同班级/同批次):people 模式下的结构推断层,可关 */
  remarkClass: boolean
  /** 首字连边(网名/备注第一个字符相同):推断层,默认开、可关 */
  firstChar: boolean
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
  // 同班级连边:默认开 —— 它把「同一批人」这类用户自建的组织结构画出来
  remarkClass: true,
  // 首字连边:默认开 —— 备注/网名首字相同的人往往同属一类(法院_*、工商银行_*、亲戚_*)
  firstChar: true,
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

/**
 * 同备注编号边(class)的「锚点数」:一个班里保留几个枢纽,其余成员各挂一条。
 *
 * 为什么不做完全图:真机实测 `宜州一中404` 一个班 43 人,完全图是 C(43,2)=**903** 条边,
 * 而默认视图的连线预算只有 nodeLimit×5 = 1250 条 —— 一个班就能吃掉 72% 的额度,
 * 把「共同群」这类真实观测到的关系挤掉(9 个班全量成对统计共 **1233** 条)。
 * 改成「锚点串成链 + 其余轮转挂到锚上」后边数恒为 人数−1(全部 9 个班合计 77 条),
 * 但整班仍然连通:力导向会把同班的人拉到一起,社区检测也能拿到这一层结构。
 * 想看全班名单走详情面板的「同班级」区块(那里给的是名册,不是边)。
 */
const CLASS_ANCHORS = 3

/** 首字键前导垃圾：空白（含全角/零宽）+ 常见标点。 */
const LEAD_JUNK_RE = /^[\s\u3000\u200b-\u200f\ufeff\-_—–~～·、,，.。:：;；/|\\()（）[\]【】{}｛｝#*+"'“”‘’!！?？@&+]+/

/** 全角 ASCII → 半角；全角空格 → 半角空格（同形异宽只算一种写法）。 */
function foldWidth(ch: string): string {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0x3000) return ' '
  if (c >= 0xff01 && c <= 0xff5e) return String.fromCodePoint(c - 0xfee0)
  return ch
}

/**
 * 首字键（`initial` 边层的分组依据）：取标签的**第一个字符**，相同即视为同类。
 *
 * 归一化只做「不改变语义」的三件事，其余一律不动：
 *   ① 去首尾空白；
 *   ② 去**前导**空白+标点 —— 否则「-张三」与「张三」会被拆成两组（同一个「张」）；
 *   ③ 全角 ASCII 折半角 + ASCII 小写 —— 「Ａlice」「Alice」是同一个首字，
 *      而把 `A`/`a` 当成两组会把同一批人拆开（真机全量库里 `A` 62 人 / `a` 79 人，
 *      折叠后合成 79 人一组，这显然才是「首字相同」想要的结果）；
 *   ④ 首字符是 emoji / 图案时继续往后取第一个实义字符 —— 否则 45 个互不相干的
 *      emoji 名会被归成「🔥 组」这种没有任何意义的簇。
 *
 * 刻意**不做**的事（做了就不是「第一个字符完全相同」了）：不取拼音、不切词、
 * 不合并同音字、不比较第二个字符。
 *
 * 与 `remarkClassKey` 的关系：那个是「前缀+编号」的**精确**结构（宜州一中404），
 * 这个是**粗粒度**的首字（宜）—— 所以首字组会把「宜州一中404」和「宜州一中1410」
 * 合成一组，也会把「物联本202」与「物联本201」合成一组。这是规则的必然结果，
 * 不是缺陷；两级关系各自独立可关。
 * @param label - 节点标签（备注 || 昵称 || wxid）。
 * @returns 首字键；标签为空、或去掉前导标点后为空时返回 `''`（该节点不参与首字层）。
 */
export function firstCharKey(label: string): string {
  const t = (label ?? '').trim().replace(LEAD_JUNK_RE, '')
  if (!t) return ''
  for (const ch of t) {
    // 首字符就是 emoji/图案时跳过它（见上文 ④）
    if (/\p{Extended_Pictographic}/u.test(ch) || /\p{Emoji_Presentation}/u.test(ch)) continue
    return foldWidth(ch).toLowerCase()
  }
  return ''
}

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
    remark_group?: string
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
      x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
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
      x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
      ...(n.msg_count !== undefined ? { intimacy: n.msg_count } : {}),
      ...(n.is_friend !== undefined ? { isFriend: n.is_friend } : {}),
      ...(n.shared_count !== undefined || n.member_count !== undefined ? { sharedCount: n.shared_count ?? n.member_count } : {}),
      ...(n.group_codes && n.group_codes.length > 0 ? { groupCodes: n.group_codes } : {}),
      ...(n.remark_group ? { remarkGroup: n.remark_group } : {}),
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
  // ── 观测层额度：亲密度 + 共同群/成员 ───────────────────────────────────────
  // 这两类是**真实观测**到的关系（不是推断），所以「有多少画多少」，只受两道上限约束：
  //   min(OBSERVED_EDGE_CAP, edgeDensityCap(n))
  //   - `edgeDensityCap`：绘制层这一帧到底能容纳多少条（小图 251 节点 → 1255，这才是真约束）；
  //   - `OBSERVED_EDGE_CAP=6000`：大图上共同群点对是 O(G²) 的（真机全量视图实测**原始 34953 条**），
  //     到这个量级图已经糊到看不出结构，按 `edges` 既有的权重降序保留最强的那些。
  // **这里只夹观测层，不夹推断层** —— 老代码写的是 `[...edges, ...inferred].slice(0, 6000 - intimacy)`，
  // 把两类合在一起夹：全量视图里观测层独占满 6000 条，共用的那道切片就把推断层整批切掉
  // （实测首字层 +0 条）。分开之后观测层仍是 6000 条，而 6000 与密度上限之间的差额
  // （真机 13030 − 6000 = 7030）留给推断层 —— 那是**绘制层本来就能画、原来却没人生成**的额度。
  const observed = [...intimacy, ...edges]
    .slice(0, Math.min(OBSERVED_EDGE_CAP, edgeDensityCap(nodes.length)))

  // ── 推断层（虚线）：同备注编号(class) 与 首字相同(initial) 共用同一套机制 ─────────
  // 两类都停在「锚点生成树 + 按余量截断」，而不是完全图。首字层实测：默认视图同首字组
  // 34 个、候选点对 1534 条，而**未被使用的余量只有 224 条**（见 graph-budget 的 edgeHeadroom）
  // —— 完全图根本画不下，硬画就会按分桶把「共同群」这类真实观测边挤掉。
  const degOf = new Map<string, number>()
  for (const key of edgeW.keys()) {
    const [a, b] = key.split('|')
    if (a) degOf.set(a, (degOf.get(a) ?? 0) + 1)
    if (b) degOf.set(b, (degOf.get(b) ?? 0) + 1)
  }
  /**
   * 已占用的点对。**两类推断边共用这一个集合**，这是「避免重复」的唯一机制：
   * 一对节点在图上只能有一条边，否则详情面板的 React key 会撞、度数统计虚高。
   * 优先级由插入顺序决定：共同群（观测）> 同备注编号（用户自建结构）> 首字（启发式）。
   */
  const paired = new Set(edgeW.keys())
  const inferred: GEdge[] = []
  /** 已经有「首字边」的节点：只用于 `coverAll` 的兜底扫描。 */
  const initialCovered = new Set<string>()
  /**
   * 加一条推断边（无向：`source`/`target` 只由 id 字典序决定，不代表方向）。
   * @returns 是否真的新增（已存在同点对、或自连时为 `false`）。
   */
  const addInferred = (a: string, b: string, kind: 'class' | 'initial'): boolean => {
    // 自连守卫：同一节点不成边（分组时已按 id 去重，这里是最后一道）
    if (!a || !b || a === b) return false
    const key = a < b ? a + '|' + b : b + '|' + a
    if (paired.has(key)) return false
    paired.add(key)
    inferred.push({ source: a, target: b, weight: 1, dist: 200, kind, bidirectional: true })
    if (kind === 'initial') { initialCovered.add(a); initialCovered.add(b) }
    return true
  }
  /**
   * 按 key 分组（只保留 ≥2 个成员的组），组内按「已有点度数」降序 ——
   * 度数高的人更可能是真枢纽（真的认识组里其他人）。
   * 组间顺序 = `top` 的遍历顺序（保持确定性，便于断言）。
   */
  const keyedGroups = (keyOf: (n: (typeof top)[number]) => string | undefined): string[][] => {
    const byKey = new Map<string, string[]>()
    for (const n of top) {
      const k = keyOf(n)
      if (!k) continue
      let arr = byKey.get(k)
      if (!arr) { arr = []; byKey.set(k, arr) }
      arr.push(n.id)
    }
    return [...byKey.values()]
      .filter(ids => ids.length >= 2)
      .map(ids => [...ids].sort((a, b) => (degOf.get(b) ?? 0) - (degOf.get(a) ?? 0) || a.localeCompare(b)))
  }
  /**
   * 锚点生成树：`n` 个成员恰好 `n-1` 条（锚点之间串成链 + 其余各挂到锚点），整组连通。
   * @param coverAll - 首选锚点已被**更强**的边（共同群/同班级）占用时，是否继续在组内另找搭档。
   *   首字层需要它：真机默认视图实测，只要不加这一层，34 个首字组里只有 **22 个**能靠
   *   首字边自己连通 —— 剩下的组里有人「这层一条线都没有」（他与组内某人的关系已经被
   *   更优先的边占了，于是那一条被去重掉）。`class` 层不用它：那边 `n-1` 是硬约束。
   * @returns 实际新增的条数（已存在的点对会被 `addInferred` 跳过）。
   */
  const addAnchorTree = (ids: string[], kind: 'class' | 'initial', coverAll = false): number => {
    // 锚点数 ≥1 且 ≤ n-1：保证「锚之间串起来 + 其余各挂一条」正好是 n-1 条
    const anchors = ids.slice(0, Math.min(CLASS_ANCHORS, Math.max(1, ids.length - 1)))
    const before = inferred.length
    for (let i = 1; i < anchors.length; i++) addInferred(anchors[0] as string, anchors[i] as string, kind)
    const rest = ids.slice(anchors.length)
    rest.forEach((id, i) => {
      const preferred = anchors[i % anchors.length] as string
      if (addInferred(preferred, id, kind)) return
      if (!coverAll) return
      // 首选锚点已连通 → 依次试其余锚点
      for (let k = 1; k < anchors.length; k++) {
        if (addInferred(anchors[(i + k) % anchors.length] as string, id, kind)) return
      }
    })
    // coverAll 兜底扫描：**锚点链本身也可能整条被更强边占掉**（真机实测：不加这一步，
    // 34 个首字组里只有 22 个能靠首字边自己连通，剩下 12 组里有人「这层一条线都没有」）。
    // 逐个补齐，让组内每个成员至少有一条蓝虚线。
    if (coverAll) {
      for (const id of ids) {
        if (initialCovered.has(id)) continue
        for (const other of ids) {
          if (other !== id && addInferred(other, id, kind)) break
        }
      }
    }
    return inferred.length - before
  }

  // 同备注编号边(class)：同样按余量截断。真机全量视图 class 上限只有 77 条、远没到额度，
  // 但额度必须由公式给出，不能靠「实测它很小」来保证 —— 备注里带编号的人一多，它就会
  // 独自吃掉整个额度、把后面的首字层挤成 0。整组放不下就跳过**整组**（用 continue 而不是
  // break：后面还有小组合适放），这样「每个被处理的组恰好 n−1 条」这条硬约束不会被从中间截断。
  if (s.mode === 'people' && s.remarkClass) {
    let left = edgeHeadroom(nodes.length, observed.length + inferred.length)
    for (const ids of keyedGroups(n => n.remark_group)) {
      if (ids.length - 1 > left) continue
      left -= addAnchorTree(ids, 'class')
    }
  }

  // 首字连边(initial)：先问余量，再决定生成多少 —— 额度来自 graph-budget（与绘制层同源）。
  if (s.mode === 'people' && s.firstChar) {
    const groups = keyedGroups(n => firstCharKey(n.label))
    // 余量 = 密度上限 − **已经真正产出的全部边**（夹过的观测层 + 同备注编号层）。
    // 关键是「产出」而不是「原始」：观测层被 OBSERVED_EDGE_CAP 夹掉的那些**不占额度**，
    // 用原始条数去算会把余量算成 0（真机全量视图：原始观测 37558 → 余量 0 → 首字层 +0）。
    // 同时观测层仍必须**算进来**：漏掉它会高估余量、刚好越过上限一条，
    // 让绘制层从尾部截掉一条真实关系。
    const headroom = edgeHeadroom(nodes.length, observed.length + inferred.length)
    const start = inferred.length
    let left = headroom
    // ① 生成树保底：每个首字组的成员至少有一条蓝虚线，且组内连通
    for (const ids of groups) {
      if (left <= 0) break
      left -= addAnchorTree(ids, 'initial', true)
    }
    // ② 余量回填：按「两端度数之和」降序补密，尽可能贴近「两两相连」的意图
    if (left > 0) {
      const cand: Array<{ a: string; b: string; score: number }> = []
      for (const ids of groups) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i] as string
            const b = ids[j] as string
            const key = a < b ? a + '|' + b : b + '|' + a
            if (paired.has(key)) continue
            cand.push({ a, b, score: (degOf.get(a) ?? 0) + (degOf.get(b) ?? 0) })
          }
        }
      }
      cand.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
      for (const c of cand) {
        if (left <= 0) break
        if (addInferred(c.a, c.b, 'initial')) left--
      }
    }
    // ③ 硬夹一次：①的「保覆盖」是逐组独立判断的，累计可能小幅越过余量（②是按 `left` 递减的，不会越）。
    //   首字边是最后 push 的一批，直接截尾即可 —— 截掉的都是自己推断出来的边，
    //   不会动到观测层。这一夹同时是「模型边总数 ≤ 密度上限」这条不变量的最后一道保证。
    //   `paired` 里会残留几个「已配对但无边」的键 —— 它此后不再被读取，无影响。
    const over = inferred.length - start - headroom
    if (over > 0) inferred.length = start + headroom
  }

  // 社区检测跑在「共同群/共同成员/同班级」边上(「我」的枢纽亲密度边不参与),
  // 否则标签会把所有人吸进同一个圈子;self 无共同边 → 自然保持中性灰。
  // 首字层**刻意不参与**社区检测:它是启发式的粗粒度规则(「宜」会把两个不同的班并成一组),
  // 让它去改圈子归属会把观测到的结构带偏;蓝虚线跨圈子穿过反而正好说明「这里是推断关系」。
  const communityCount = detectCommunities(nodes, [...edges, ...inferred.filter(e => e.kind !== 'initial')])
  // 拼接顺序 = 并列时的优先级：观测层（亲密度 → 共同群，权重降序）在前，推断层在后。
  // 不再有「按 weight 排序后整体切 6000」这一步 —— 那是上一版「两边额度不一致」的根源：
  // 排序把推断边混进同一批里切，切到谁全看权重并列时的稳定性，等于用一道天花板
  // 悄悄吃掉另一个模块算好的额度。
  // 现在的不变量（可由 edgeHeadroom 的语义直接推出）：
  //   观测层 ≤ min(OBSERVED_EDGE_CAP, edgeDensityCap(n))
  //   推断层 ≤ edgeDensityCap(n) − 观测层
  //   ⇒ 模型边总数 ≤ edgeDensityCap(n) ≤ 绘制层 edgeBudget 的下限
  //   ⇒ **模型里的边一条都不会被绘制层裁掉**。
  return { nodes, edges: [...observed, ...inferred], communityCount }
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

/* ── 知识图谱（知识网络）────────────────────────────────────────────────
 *
 * 与社交图谱分开构建、由面板按 variant 二选一：社交侧节点口径是「联系人/群/我」，
 * 知识侧是「笔记/未解析目标」。两者 id 空间不同（note:<id> / kb:<key> vs username / self）。
 *
 * 这里**没有「融合」档**：早先可以按笔记的 sourceUsername 把来源会话（人/群）拉进同一张图，
 * 但那是通讯录数据、不属于知识库内容。该模式已整体删除，图与社交快照彻底解耦 ——
 * `buildKnowledgeNetwork` 连参数都不再接收社交快照，从签名上杜绝再次混入。
 */

/** 知识节点半径:链接越多越大(复用好友侧的饱和度手感)。
 *  区间刻意比好友侧大：nodeScale 默认 0.4，若基数太小会被画布的 8px 下限压平，
 *  链接数不同的笔记就长得一样大、看不出结构。 */
function radiusByLinks(links: number): number {
  return radiusBySqrt(links, 6, 16, 46)
}

/**
 * 构建知识网络：节点**只来自知识库**（笔记 + 待补目标），没有任何外部数据。
 *
 * 产品约束（2026-09-18）：图谱的节点必须全部来源于知识库内容，不得混入知识库之外的
 * 数据。所以这里**不接受社交快照** —— 早先的 `buildKnowledgeNetwork(knowledge, social, s)`
 * 在 `mode='fused'` 下会把笔记的来源会话（人/群）拉进图里，那是通讯录数据，
 * 不是知识库内容；该模式已删除，参数也随之收掉，从签名上就杜绝再次混入。
 *
 * 节点构成（四类，全部都在知识库之内）：
 *   · `note:N` —— 一篇真实存在的笔记（id 取自 notes 表主键）；
 *   · `kb:目标名` —— 正文里被 `[[…]]` 引用、但还没有同名笔记的「待补目标」。
 *     它是**笔记正文的解析结果**（后端 parseWikiLinks 产出），仍属于知识库内容 ——
 *     作用是把断链显性化，而不是引入外部实体。
 *   · `file:F` —— 一份登记文件（2026-09-19 文档实体层）。**一文件一节点，绝不按 chunk**：
 *     分块是 500 字一块、单文件上限两万块，拿块当节点会撑爆额度并画出星形塌陷。
 *   · `doc:章节名` —— 归一化后**跨文件合并**的章节；同一节出现在三份文件里就是一个节点，
 *     于是「哪些资料讲的是同一块内容」第一次变得可见。
 *
 * 后两类的取数与归一化在后端 `query/kb/entities.ts`，合并点在 gateway 的
 * `getKnowledgeGraph`（笔记库与文件库是两个 db 文件，notes 层看不见文件）。
 * @param knowledge - 知识图谱快照（笔记 + stub + 文档实体 + 各类边），来自 `apiGetKnowledgeGraph()`。
 * @param s - 图谱设置（`nodeLimit` 截断笔记节点；文档族另有其一半的额度；stub 不参与截断）。
 * @returns BuiltGraph —— 与社交侧同构，画布无需区分数据来源。
 */
export function buildKnowledgeNetwork(
  knowledge: KnowledgeSnapshot | null,
  s: GraphSettings,
): BuiltGraph {
  if (!knowledge) return { nodes: [], edges: [], communityCount: 0 }

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
      x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
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
    x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
  }))

  // ── 文档实体层 ─────────────────────────────────────────────
  // `?? []` 不是防御性冗余，而是**必须**：首帧读的是 localStorage 里的渲染缓存
  // （`kbCacheKey('kb-graph', kbId)`），而那份缓存可能是这次改动之前写下的、
  // 根本没有 docFiles 的旧形状。类型上它是必填的，运行期却会缺 —— 不兜就是整张图崩。
  const fileNodes: GNode[] = (knowledge.docFiles ?? []).map(f => ({
    id: 'file:' + f.id,
    label: f.label,
    kind: 'file' as const,
    // 半径按分块数走：分块多=这份资料长=信息量大，与笔记侧「按链接数」同一手感。
    weight: 100 + Math.min(f.chunkCount * 20, 900),
    radius: radiusByLinks(f.chunkCount),
    community: -1,
    outLinks: f.chunkCount,
    fileMeta: { ext: f.ext, chunkCount: f.chunkCount, charCount: f.charCount, parseState: f.parseState },
    x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
  }))
  const sectionNodes: GNode[] = (knowledge.docSections ?? []).map(st => ({
    id: 'doc:' + st.key,
    label: st.label,
    kind: 'section' as const,
    weight: 40 + Math.min(st.occurrences * 20, 200),
    radius: 12,
    community: -1,
    backLinks: st.occurrences,
    sectionFileIds: st.files.map(f => f.id),
    excerpt: st.files.length > 1
      ? `${st.files.length} 份文件里都有这一节 · 共出现 ${st.occurrences} 次`
      : `出现 ${st.occurrences} 次`,
    x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
  }))

  /**
   * 推断层的实体节点（`ent:<key>`）。与上面的章节节点**不同源**：
   * 章节是「文档里确实有这么一节」（观测），实体是「模型说这份文件里提到了它」（推断）。
   * 所以它排在文档族最后、额度最少，且连到它的边一律虚线。
   */
  const entityNodes: GNode[] = (knowledge.docEntities ?? []).map(en => ({
    id: 'ent:' + en.key,
    label: en.label,
    kind: 'entity' as const,
    weight: 30 + Math.min(en.occurrences * 15, 150),
    radius: 10,
    community: -1,
    backLinks: en.occurrences,
    sectionFileIds: en.files.map(f => f.id),
    // 两个分支都必须以「模型推断」开头：详情里少说一次，跨文件实体就被读成
    // 「这几份文件里都写着它」—— 而这一层唯一比观测层弱的地方正是这句话。
    excerpt: (en.files.length > 1
      ? `模型推断 · ${en.files.length} 份文件里都抽到了它`
      : `模型推断的${ENTITY_KIND_LABEL[en.kind] ?? '实体'}`)
      + ` · 由 ${en.model || '未知模型'} 抽出`,
    x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
  }))

  const edges: GEdge[] = knowledge.edges.map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    // [[链接]] 是有向语义关系，距离给固定基准，长度缩放交给仿真侧统一处理。
    dist: 150 / Math.sqrt(Math.max(e.weight, 1)),
    // 笔记↔笔记与笔记↔待补都走画布现有的 wiki 取色分支（改前 stub 边也叫 wiki，
    // 这里刻意不动，免得顺手动掉一处渲染口径）；文档层三类边是新分支。
    kind: e.kind === 'contain' ? 'contain' as const
      : e.kind === 'mention' ? 'mention' as const
        : e.kind === 'suggest' ? 'suggest' as const
          : 'wiki' as const,
  }))

  // 刻意**没有**「把来源会话拉进来」这一步（曾经有，见函数头注释）：
  // 人/群是通讯录数据，不属于知识库内容。
  const limit = Math.max(1, s.nodeLimit)
  const keptNotes = noteNodes.length > limit ? noteNodes.slice(0, limit) : noteNodes
  // 文档族只有笔记族一半的额度，且**排在笔记之后**：这一层是后加的，
  // 不能因为它把笔记节点挤出图。截断按权重降序，留下的总是这个库里最有内容的部分。
  const docLimit = Math.max(20, Math.floor(limit / 2))
  const byWeight = (list: GNode[]): GNode[] =>
    [...list].sort((a, b) => b.weight - a.weight).slice(0, docLimit)
  const keptFiles = fileNodes.length > docLimit ? byWeight(fileNodes) : fileNodes
  const keptSections = sectionNodes.length > docLimit ? byWeight(sectionNodes) : sectionNodes
  // 实体是**推断**，额度只给文档族的另一半：宁可图上少几个点，也不要让模型的一次
  // 幻觉把观测到的章节/文件挤出去。
  const entLimit = Math.max(10, Math.floor(docLimit / 2))
  const keptEntities = entityNodes.length > entLimit ? byWeight(entityNodes).slice(0, entLimit) : entityNodes
  const allNodes: GNode[] = [...keptNotes, ...stubNodes, ...keptFiles, ...keptSections, ...keptEntities]
  const ids = new Set(allNodes.map(n => n.id))

  // mention / suggest 两条边都是**推断层**：它们只能吃观测层用剩下的额度，
  // 绝不能把真实的 [[链接]] 挤掉。这条纪律与社交侧同源（见 graph-budget.ts 的 edgeHeadroom），
  // 后果也实测过 —— 推断边填满额度时，被裁掉的是真实观测到的关系。
  const observed = edges.filter(e => e.kind !== 'mention' && e.kind !== 'suggest')
  const headroom = edgeHeadroom(allNodes.length, observed.length)
  const inferred = edges.filter(e => e.kind === 'mention' || e.kind === 'suggest')
  const keptEdges = [...observed, ...inferred.slice(0, headroom)]
    .filter(e => ids.has(e.source) && ids.has(e.target))

  // 社区检测只喂笔记节点：stub 是缺口而非圈子成员，而文档节点是**资料**不是**圈子**，
  // 把「一份 PDF」分进某个圈子同样会产生误导 —— 让它保持中性灰。
  const communityCount = detectCommunities(keptNotes, keptEdges)
  return { nodes: allNodes, edges: keptEdges, communityCount }
}
