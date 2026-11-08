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
import type { GraphCoverage, GraphSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { KnowledgeSnapshot } from '../types.ts'
import { edgeDensityCap, edgeHeadroom, OBSERVED_EDGE_CAP } from './graph-budget.ts'
import type { GraphSettings } from './graph-settings.ts'

export {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_FORCE_CONTROLS,
  GRAPH_FORCE_FACTOR_MAX,
  GRAPH_FORCE_FACTOR_MIN,
  GRAPH_FORCE_KEYS,
  formatGraphForceMultiplier,
  graphForceMultiplier,
} from './graph-settings.ts'
export type {
  GraphForceControl,
  GraphForceKey,
  GraphSettings,
} from './graph-settings.ts'

export interface GNode {
  id: string
  label: string
  kind: 'person' | 'group' | 'self' | 'note' | 'stub' | 'file' | 'section' | 'entity'
  /** 企业微信联系人的企业名称；不拼进 label，避免影响首字分组与社区聚类。 */
  enterpriseName?: string
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
  /** Group membership snapshot availability; unknown is not the same as zero. */
  membershipStatus?: 'known' | 'unknown'
  membersTotal?: number
  membersTruncated?: boolean
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

export type GEdgeKind =
  | 'intimacy'
  | 'social'
  | 'common'
  | 'wiki'
  | 'source'
  | 'class'
  | 'initial'
  | 'contain'
  | 'mention'
  | 'suggest'
  | 'custom'

/**
 * 一条视觉边里承载的一种语义关系。
 *
 * 图上一个节点对只画一条线，避免物理仿真重复受力、详情 key 冲突和视觉双线；
 * 但同一对节点完全可能同时是「同群」「同班」「同首字」。这些语义不能像旧实现
 * 那样靠 `paired` 静默丢掉，因此聚合成关系明细。`source/target/bidirectional`
 * 是**这条关系自己的方向**，不是视觉边的主方向。
 */
export interface GEdgeRelation {
  kind: GEdgeKind
  /** 后端原始类型。未知类型归入 custom 时仍原样保留，避免信息损失。 */
  rawKind?: string
  /** 后端给出的可读关系名（如「同事」「同项目」）。 */
  label?: string
  source: string
  target: string
  bidirectional: boolean
  /** 聚合后的关系权重。同源重复记录按规则累加，推断重复不虚增。 */
  weight: number
  /** 合并了多少条原始关系记录。 */
  count: number
  /** 证据摘要（去重、有界），完整数量见 evidenceCount。 */
  evidence?: string[]
  evidenceCount?: number
  /** 关系来自后端观测边，还是客户端从节点字段推导。 */
  origin: 'backend' | 'derived'
  strength?: number
  dist?: number
}

export interface GEdge {
  source: string
  target: string
  weight: number
  dist: number
  /** 可选边强度(「我」的枢纽边随亲密度变化;普通边默认 1/min(度)) */
  strength?: number
  /** intimacy=我↔好友(消息量);social=好友/邀请/回复/提及/朋友圈/资金等直接互动;
   *  common=好友↔好友(共同群数);
   *  wiki=笔记↔笔记([[链接]]);source=笔记↔来源会话(**已停用**:随「节点只来自知识库」
   *  的约束一并删除,不再有任何产出方;保留枚举只是不动画布现有的取色分支);
   *  class=同备注编号(同班级/同批次,由用户自己的备注结构推得);
   *  initial=首字相同(网名/备注的第一个字符一样,见 firstCharKey);
   *  contain=文件↔章节(这一节确实在这份文件里,是**结构事实**,归观测层);
   *  mention=笔记↔文件(笔记标题作为连续子串出现在文件正文里,是**推断**,归推断层)。 */
  kind: GEdgeKind
  /** 双向连接:好友/群关系是互惠的,渲染时两端都显示箭头/参与邻居计算。 */
  bidirectional?: boolean
  /** 同一节点对聚合后的全部关系；第一项是决定线条样式的主关系。 */
  relations?: GEdgeRelation[]
  /** 关系种类数（不是线数）。 */
  relationCount?: number
  /** 至少含一条后端提供的观测边。 */
  authoritative?: boolean
}

export interface BuiltGraph {
  nodes: GNode[]
  edges: GEdge[]
  /** 社区数量(0=未分组全部) */
  communityCount: number
  /** 各类节点的个数（一次遍历数完，见 countByKind）—— 缺某种就是没出现过，不是 0。 */
  kindCounts: GraphKindCounts
  /** Visibility/truncation facts so a node limit is not mistaken for missing data. */
  coverage?: GraphBuildCoverage
}

/** 每种节点各多少个（缺某种就是 `undefined`，调用点自己按 0 处理）。 */
export type GraphKindCounts = Partial<Record<GNode['kind'], number>>

/**
 * One client-side pair source (common group or common member). Candidate counts
 * use every retained member; considered counts are the pair checks the bounded
 * fallback actually performed. This keeps a capped fallback auditable instead
 * of presenting a partial graph as complete.
 */
export interface GraphPairSourceCoverage {
  sources: number
  truncatedSources: number
  candidatePairs: number
  consideredPairs: number
  skippedPairs: number
}

/**
 * Machine-readable bounds for relations the client derives when an older or
 * incomplete backend snapshot has no authoritative edge for the pair.
 */
export interface GraphClientDerivationCoverage {
  pairMemberLimit: number
  pairWorkBudget: number
  pairWorkUsed: number
  pairWorkExhausted: boolean
  commonGroup: GraphPairSourceCoverage
  commonMember: GraphPairSourceCoverage
  commonGeneratedPairs: number
  commonBelowThresholdPairs: number
  commonEmittedEdges: number
  commonMergedEdges: number
  commonSuppressedByAuthoritative: number
  commonDroppedByEdgeBudget: number
  intimacyGeneratedEdges: number
  intimacyEmittedEdges: number
  intimacyMergedEdges: number
  intimacySuppressedByAuthoritative: number
  intimacyDroppedByEdgeBudget: number
  truncated: boolean
}

export interface GraphBuildCoverage {
  candidateNodes: number
  retainedNodes: number
  droppedNodes: number
  droppedEdges: number
  droppedEdgeEndpoints: number
  /** Client-side fallback derivation bounds and authoritative suppression. */
  derived?: GraphClientDerivationCoverage
  /** Backend limits (pair budget, reply/@ window) retained for the UI audit line. */
  server?: GraphCoverage
}

/**
 * 一次遍历数出各类节点的个数（审计 P3-14）。
 *
 * 统计条原先在**每次渲染**里跑 7 遍 `nodes.filter(...).length` —— 每遍都新建一个数组，
 * 而渲染由选中、面板开合、悬停这些与计数无关的动作触发。节点上限是几百到上千的量，
 * 于是"动一下鼠标就分配七份临时数组"。收成一次 `for` 之后口径也只有一份：
 * 「笔记数」这种数字在两处显示时必须同源，散着的 filter 串正是它们悄悄分叉的地方。
 */
export function countByKind(nodes: readonly Pick<GNode, 'kind'>[]): GraphKindCounts {
  const out: Record<string, number> = {}
  for (const n of nodes) out[n.kind] = (out[n.kind] ?? 0) + 1
  return out
}

/** 实体类别 → 中文。详情与气泡里要说「模型推断的人名」，而不是裸的 `person`。 */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  person: '人名', org: '机构', product: '产品', place: '地名', topic: '主题词',
}

/** 「我」节点 id(与 host 一致) */
export const SELF_ID = 'self'

/**
 * 社区色盘（10 色）：微信灰阶为主 + 微信绿/灰蓝少量强调。
 *
 * 为什么不再用霓虹盘：图谱节点属于「内容」，颜色只承担「区分圈子」这一件事；
 * 旧盘是蓝/紫/粉高饱和色，整张图看起来像霓虹灯。现在 8 档中性灰 + 2 个品牌色，
 * 相邻档刻意留出可辨识的明度差。未分组（-1）仍回落到中性灰 `#9aa0a6`。
 */
export const COMMUNITY_COLORS = [
  '#07c160', '#576b95', '#9aa0a6', '#7f8794', '#b2b6bd',
  '#6b7280', '#8c939d', '#a5abb3', '#767e8a', '#98a0aa',
]

/** 社区色:未分组(-1)→ 中性灰 */
export function communityColor(community: number): string {
  if (community < 0) return '#9aa0a6'
  const c = COMMUNITY_COLORS[community % COMMUNITY_COLORS.length]
  return c ?? '#9aa0a6'
}

/** 关系类型 → 中文。未知类型不伪装成「共同群」，详情会展示后端原值。 */
export const EDGE_KIND_LABEL: Record<GEdgeKind, string> = {
  intimacy: '亲密度',
  social: '社交互动',
  common: '共同群 / 共同成员',
  wiki: '笔记链接',
  source: '内容来源',
  class: '同备注编号',
  initial: '首字相同',
  contain: '文件包含章节',
  mention: '笔记标题被提及',
  suggest: '模型推断实体',
  custom: '其他关系',
}

/** 关系类型的中文名；运行期收到未知字符串时回退「其他关系」。 */
export function edgeKindLabel(kind: GEdgeKind): string {
  return EDGE_KIND_LABEL[kind] ?? EDGE_KIND_LABEL.custom
}

/**
 * 关系的可读名称。
 * @param relation - 聚合关系。
 * @returns 后端标签优先，否则使用内置中文类型名。
 */
export function edgeRelationLabel(relation: Pick<GEdgeRelation, 'kind' | 'label' | 'rawKind'>): string {
  const own = relation.label?.trim()
  if (own) return own
  const rawLabel = relation.rawKind ? BACKEND_EDGE_TYPE_LABEL[relation.rawKind] : undefined
  if (rawLabel) return rawLabel
  if (relation.kind === 'custom' && relation.rawKind) return relation.rawKind
  return EDGE_KIND_LABEL[relation.kind] ?? EDGE_KIND_LABEL.custom
}

/**
 * 视觉边的主方向符号。
 * @param edge - 聚合边。
 * @returns `↔` 双向、`⇄` 双向但由两条有向关系组成、`→` 单向。
 */
export function edgeDirectionSymbol(edge: Pick<GEdge, 'bidirectional' | 'relations'>): '↔' | '⇄' | '→' {
  const relations = edge.relations ?? []
  const hasUndirected = relations.some(r => r.bidirectional)
  if (hasUndirected) return '↔'
  if (edge.bidirectional) return '⇄'
  return '→'
}

/**
 * 展开一条视觉边里的全部语义，供详情 tooltip / 无障碍文本使用。
 * @param edge - 聚合边。
 * @param labelOf - 节点 id → 可读名称。
 * @returns 每种关系一行，含方向、权重、合并记录数与证据摘要。
 */
export function edgeRelationLines(
  edge: Pick<GEdge, 'relations'>,
  labelOf: (id: string) => string,
): string[] {
  if (!edge.relations || edge.relations.length === 0) return []
  return edge.relations.map((r) => {
    const arrow = r.bidirectional ? '↔' : '→'
    const count = r.count > 1 ? ` · ${r.count} 条记录` : ''
    const evidence = r.evidence && r.evidence.length > 0
      ? ` · 证据：${r.evidence.join('、')}${(r.evidenceCount ?? r.evidence.length) > r.evidence.length ? ` 等 ${r.evidenceCount ?? r.evidence.length} 项` : ''}`
      : ''
    return `${edgeRelationLabel(r)} · ${labelOf(r.source)} ${arrow} ${labelOf(r.target)} · 权重 ${r.weight}${count}${evidence}`
  })
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

/**
 * 「总人数」口径：当前模式 + 过滤条件下**真正可能进图**的节点（不含群与「我」）。
 *
 * 必须与 `buildGraph` 的筛选完全一致（同一份实现），否则「节点上限默认 = 30%」
 * 会按「通讯录全量」算（3002）而不是「当前过滤下能显示的人」（如仅好友时 289），
 * 默认值恒大于可用节点数 ⇒ 等于没限制。默认值取它的 30%，见 `defaultNodeLimit`。
 */
export function rawCandidateNodes<T extends { kind: string; is_friend?: boolean }>(
  env: { nodes: ReadonlyArray<T> } | null | undefined,
  s: Pick<GraphSettings, 'mode' | 'friendsOnly'>,
): T[] {
  if (!env) return []
  return env.nodes.filter((n) => {
    if (s.mode === 'all') {
      // The mixed network is the only mode that can display real
      // person->group facts (owner, membership, invite, group activity).
      if (n.kind === 'self') return false
      if (n.kind === 'group') return true
      if (s.friendsOnly) return n.kind !== 'official' && n.is_friend === true
      return true
    }
    if (s.mode === 'people') {
      // 「仅显示好友」:排除群、公众号与未标记好友的联系人
      if (n.kind === 'group' || n.kind === 'self') return false
      if (s.friendsOnly) return n.kind !== 'official' && n.is_friend === true
      return true
    }
    return n.kind === 'group'
  })
}

/** 「总人数」= `rawCandidateNodes` 的长度（群模式则是群数）。 */
export function eligibleCandidateCount(
  env: { nodes: ReadonlyArray<{ kind: string; is_friend?: boolean }> } | null | undefined,
  s: Pick<GraphSettings, 'mode' | 'friendsOnly'>,
): number {
  return rawCandidateNodes(env, s).length
}

/**
 * 默认「节点上限」：总人数 × 30%（四舍五入，至少 1 个）。
 *
 * 产品要求（2026-10-18）：初始只显示三成的人，先看清最密的核心圈，再按需拖大；
 * 之前是 `min(250, 全部)`，小图等于全量、大图恒为 250。30% 之下常见规模
 * （仅好友 289 人 → 87 个）力导向与头像加载都轻；超过头像预算 320 的部分
 * 按既有的 `avatarBudget` 降级为圆盘，不改变节点数。
 */
export function defaultNodeLimit(totalPeople: number): number {
  return Math.max(1, Math.round(Math.max(0, totalPeople) * 0.3))
}

interface RawGraphEdgeInput {
  source: string
  target: string
  weight: number
  /** 后端新增的带类型观测边字段；旧快照缺省时仍按无类型观测边处理。 */
  kind?: string
  type?: string
  relation?: string
  label?: string
  relation_label?: string
  bidirectional?: boolean
  directed?: boolean
  direction?: string
  strength?: number
  dist?: number
  evidence?: string | string[]
  evidences?: string[]
  evidence_details?: Array<{ source?: string; ref?: string; count?: number }>
  evidence_count?: number
  count?: number
}

interface GraphBuildInput {
  nodes: Array<{
    id: string
    label: string
    kind: string
    enterpriseName?: string
    is_friend?: boolean
    msg_count?: number
    group_count?: number
    member_count?: number
    shared_count?: number
    membership_status?: 'known' | 'unknown'
    members_total?: number
    members_returned?: number
    members_truncated?: boolean
    group_codes?: string[]
    remark_group?: string
    shared_members?: Array<{ username: string; name: string; enterpriseName?: string; is_friend: boolean; msg_count: number }>
  }>
  edges: RawGraphEdgeInput[]
  group_names?: Record<string, string>
  coverage?: GraphCoverage
}

interface RelationDraft {
  kind: GEdgeKind
  rawKind?: string
  label?: string
  source: string
  target: string
  bidirectional: boolean
  weight: number
  origin: GEdgeRelation['origin']
  evidence?: readonly string[]
  evidenceCount?: number
  strength?: number
  dist?: number
  recordCount?: number
}

interface RelationRecord extends GEdgeRelation {
  strength?: number
  dist?: number
}

interface PairBucket {
  first: string
  second: string
  relations: Map<string, RelationRecord>
}

interface RelationAddResult {
  pairAdded: boolean
  relationAdded: boolean
  suppressedByAuthoritative: boolean
}

const KNOWN_EDGE_KINDS = new Set<GEdgeKind>([
  'intimacy', 'social', 'common', 'wiki', 'source', 'class', 'initial', 'contain', 'mention', 'suggest', 'custom',
])

const EDGE_KIND_ALIASES: Record<string, GEdgeKind> = {
  intimacy: 'intimacy',
  message: 'intimacy',
  chat: 'intimacy',
  direct_conversation: 'intimacy',
  common: 'common',
  common_group: 'common',
  group_conversation: 'common',
  group_membership: 'common',
  group_activity: 'common',
  shared_group: 'common',
  same_group: 'common',
  co_group: 'common',
  group: 'common',
  member: 'common',
  shared_member: 'common',
  common_member: 'common',
  group_owner: 'common',
  group_admin: 'common',
  friend: 'social',
  friend_request: 'social',
  invite: 'social',
  invitation: 'social',
  reply: 'social',
  quote_reply: 'social',
  mention_user: 'social',
  mention_member: 'social',
  at_user: 'social',
  call: 'social',
  moment_like: 'social',
  moment_comment: 'social',
  moment_reply: 'social',
  transfer: 'social',
  redpacket: 'social',
  wiki: 'wiki',
  link: 'wiki',
  source: 'source',
  provenance: 'source',
  class: 'class',
  school: 'class',
  batch: 'class',
  remark_class: 'class',
  initial: 'initial',
  first_char: 'initial',
  contain: 'contain',
  section: 'contain',
  mention: 'mention',
  suggest: 'suggest',
  entity: 'suggest',
}

/** 后端 GraphEdge.type → 中文关系名。未知扩展类型仍由 rawKind 原样保留。 */
const BACKEND_EDGE_TYPE_LABEL: Record<string, string> = {
  friend: '好友',
  friend_request: '好友申请',
  direct_conversation: '单聊消息',
  group_conversation: '群聊消息',
  group_membership: '群成员',
  group_activity: '群内发言',
  group_owner: '群主',
  group_admin: '群管理员',
  common_group: '共同群',
  common_member: '共同成员',
  invite: '邀请入群',
  invitation: '邀请入群',
  reply: '回复',
  quote_reply: '引用回复',
  mention_user: '@提及',
  mention_member: '@群成员',
  at_user: '@提及',
  call: '通话',
  moment_like: '朋友圈点赞',
  moment_comment: '朋友圈评论',
  moment_reply: '朋友圈回复',
  transfer: '转账',
  redpacket: '红包',
}

const DIRECTED_EDGE_KINDS = new Set<GEdgeKind>(['wiki', 'source'])
/**
 * 后端动作型关系：即使调用方漏传 direction，也不能按无向关系画成双向。
 * GraphEdge 正常总会带 direction；这里是旧缓存/跨版本数据的兼容兜底。
 */
const DIRECTED_RAW_TYPES = new Set([
  'group_conversation', 'group_membership', 'group_activity', 'group_owner', 'group_admin', 'friend_request',
  'invite', 'invitation', 'reply', 'quote_reply', 'mention_user', 'mention_member', 'at_user',
  'call', 'moment_like', 'moment_comment', 'moment_reply', 'transfer', 'redpacket',
])
const MAX_EDGE_EVIDENCE = 12
const OBSERVED_EDGE_KINDS = new Set<GEdgeKind>(['intimacy', 'social', 'common', 'wiki', 'source', 'contain'])
/** 「共同群阈值」只约束共同群/共同成员计数，不误伤群成员、群聊消息等同为 common 视觉类型的事实边。 */
const COMMON_THRESHOLD_TYPES = new Set([
  '', 'common', 'common_group', 'common_member', 'shared_group', 'same_group',
  'co_group', 'group', 'member', 'shared_member',
])
/**
 * 派生关系只是后端缺失时的兼容补位。若同一 pair 已有等价后端语义，
 * 不再新增一条看起来像“第二种关系”的合成关系；后端的 rawKind/证据继续作为唯一明细。
 */
const DERIVED_BACKEND_EQUIVALENTS: Partial<Record<GEdgeKind, ReadonlySet<string>>> = {
  intimacy: new Set(['intimacy', 'direct_conversation', 'message', 'chat']),
  common: new Set([
    'common', 'common_group', 'common_member', 'shared_group', 'same_group', 'co_group',
    'group', 'member', 'shared_member',
  ]),
}
const CLIENT_COMMON_PAIR_MEMBER_LIMIT = 80
const CLIENT_COMMON_PAIR_WORK_BUDGET = 120_000
const RELATION_KIND_RANK: Record<GEdgeKind, number> = {
  intimacy: 0,
  social: 1,
  common: 2,
  wiki: 3,
  contain: 4,
  source: 5,
  class: 6,
  mention: 7,
  suggest: 8,
  initial: 9,
  custom: 10,
}

/** 稳定的无序点对键：用 JSON 编码，避免 username 含 `|` 时两组端点拼成同一个键。 */
function pairKey(a: string, b: string): string {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a])
}

function combinationsOfTwo(count: number): number {
  const safe = Math.max(0, Math.floor(count))
  return safe * (safe - 1) / 2
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function rawEdgeTypeKey(raw: RawGraphEdgeInput): string {
  return (raw.kind ?? raw.type ?? raw.relation ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function normalizeRawEdgeKind(raw: RawGraphEdgeInput): Pick<RelationRecord, 'kind' | 'rawKind' | 'label'> {
  const rawKind = (raw.kind ?? raw.type ?? raw.relation ?? '').trim()
  const key = rawEdgeTypeKey(raw)
  const mapped = !key
    ? 'common'
    : EDGE_KIND_ALIASES[key] ?? (KNOWN_EDGE_KINDS.has(key as GEdgeKind) ? key as GEdgeKind : 'custom')
  const label = (raw.label ?? raw.relation_label ?? '').trim()
  return {
    kind: mapped,
    // common_group / common_member 等后端类型会落到同一视觉分类，但仍是不同语义。
    // rawKind 必须参与关系去重键，否则同一点对的它们会被静默合并。
    ...(key && key !== mapped ? { rawKind: key } : {}),
    ...(label ? { label } : {}),
  }
}

function normalizeDirection(raw: RawGraphEdgeInput, kind: GEdgeKind): {
  source: string
  target: string
  bidirectional: boolean
} {
  const hint = (raw.direction ?? '').trim().toLowerCase()
  const rawType = rawEdgeTypeKey(raw)
  const source = raw.source
  let target = raw.target
  let bidirectional = typeof raw.bidirectional === 'boolean'
    ? raw.bidirectional
    : raw.directed === true
      ? false
      : raw.directed === false
        ? true
        : !DIRECTED_EDGE_KINDS.has(kind) && !DIRECTED_RAW_TYPES.has(rawType)
  if (hint === 'both' || hint === 'undirected' || hint === 'bidirectional') bidirectional = true
  if (hint === 'reverse' || hint === 'in' || hint === 'incoming') {
    bidirectional = false
    target = source
    return { source: raw.target, target, bidirectional }
  }
  if (hint === 'forward' || hint === 'out' || hint === 'outgoing' || hint === 'directed') bidirectional = false
  return { source, target, bidirectional }
}

function relationEvidence(raw: RawGraphEdgeInput): { values: string[]; count: number } {
  const details = (raw.evidence_details ?? [])
    .map((item) => {
      const source = (item.source ?? '').trim()
      if (!source) return ''
      const ref = (item.ref ?? '').trim()
      const count = finiteNumber(item.count, 0)
      return source + (ref ? ':' + ref : '') + (count > 1 ? '#' + String(count) : '')
    })
    .filter(Boolean)
  const candidates = [
    ...(typeof raw.evidence === 'string' ? [raw.evidence] : raw.evidence ?? []),
    ...(raw.evidences ?? []),
    ...details,
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    if (out.length < MAX_EDGE_EVIDENCE) out.push(text)
  }
  const detailCount = (raw.evidence_details ?? []).reduce(
    (sum, item) => sum + Math.max(1, Math.round(finiteNumber(item.count, 1))),
    0,
  )
  return { values: out, count: Math.max(out.length, detailCount) }
}

/** GraphSnapshot → 筛选后的图(people/groups 两模式;社区检测;亲密度拉力)。 */
export function buildGraph(env: GraphBuildInput | null, s: GraphSettings): BuiltGraph {
  if (!env) return { nodes: [], edges: [], communityCount: 0, kindCounts: {} }
  /**
   * 稳定 id 是边能落到正确节点的前提。后端正常不会重复，但缓存/合并快照可能重复；
   * 这里保留首条，避免 React key、布局表和边端点各自指向不同副本。
   */
  const selfNode = env.nodes.find(n => n.kind === 'self' && n.id === SELF_ID)
  const seenNodeIds = new Set<string>()
  const uniqueNodes: GraphBuildInput['nodes'] = []
  if (selfNode) {
    uniqueNodes.push(selfNode)
    seenNodeIds.add(selfNode.id)
  }
  for (const node of env.nodes) {
    if (!node.id || seenNodeIds.has(node.id)) continue
    seenNodeIds.add(node.id)
    uniqueNodes.push(node)
  }
  const normalizedEnv = { ...env, nodes: uniqueNodes }
  // 筛选口径与「默认节点上限 = 30%」共用 rawCandidateNodes（两处各写一份必然漂移）。
  const rawNodes = rawCandidateNodes(normalizedEnv, s)
  // 排序:好友优先(内部按共同群数),其后群友;再整体截前 nodeLimit(参考实现语义)
  const weightOf = (n: {
    msg_count?: number
    shared_count?: number
    group_count?: number
  }): number => Math.max(
    n.msg_count ?? 0,
    n.shared_count ?? 0,
    n.group_count ?? 0,
    1,
  )
  const rankNode = (a: (typeof rawNodes)[number], b: (typeof rawNodes)[number]): number => {
    const fa = s.mode === 'people' ? Number(a.is_friend === true) : 0
    const fb = s.mode === 'people' ? Number(b.is_friend === true) : 0
    if (fa !== fb) return fb - fa
    return weightOf(b) - weightOf(a) || a.id.localeCompare(b.id)
  }
  const rawById = new Map(rawNodes.map(node => [node.id, node]))
  const priorityIds = new Set<string>()
  // Backend edges are authoritative facts. Retain their endpoints before the
  // ordinary density ranking so a small node limit cannot silently erase a
  // group owner/member/reply edge.
  for (const raw of env.edges ?? []) {
    if (typeof raw.source !== 'string' || typeof raw.target !== 'string') continue
    if (rawById.has(raw.source)) priorityIds.add(raw.source)
    if (rawById.has(raw.target)) priorityIds.add(raw.target)
  }
  const priorityNodes = [...priorityIds]
    .map(id => rawById.get(id))
    .filter((node): node is (typeof rawNodes)[number] => node !== undefined)
    .sort(rankNode)
  const selected = new Map<string, (typeof rawNodes)[number]>()
  for (const node of [...priorityNodes, ...rawNodes.slice().sort(rankNode)]) {
    if (selected.size >= Math.max(0, s.nodeLimit)) break
    selected.set(node.id, node)
  }
  const top = [...selected.values()]
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
      ...(n.enterpriseName ? { enterpriseName: n.enterpriseName } : {}),
      ...(n.kind === 'official' ? { isOfficial: true } : {}),
      weight: n.kind === 'group'
        ? Math.max(1, weightOf(n))
        : personWeight(n.is_friend === true, n.msg_count ?? 0),
      // 基础半径(不乘 nodeScale):节点大小作为外观参数,由画布侧统一应用
      radius: n.kind === 'group'
        ? radiusBySqrt(n.shared_count ?? 0, 8, 9, 18)
        : radiusByIntimacy(personWeight(n.is_friend === true, n.msg_count ?? 0)),
      community: -1,
      x: 0, y: 0, vx: 0, vy: 0, fx: null as number | null, fy: null as number | null,
      ...(n.msg_count !== undefined ? { intimacy: n.msg_count } : {}),
      ...(n.is_friend !== undefined ? { isFriend: n.is_friend } : {}),
      ...(n.shared_count !== undefined || n.member_count !== undefined ? { sharedCount: n.shared_count ?? n.member_count } : {}),
      ...(n.membership_status ? { membershipStatus: n.membership_status } : {}),
      ...(n.members_total !== undefined ? { membersTotal: n.members_total } : {}),
      ...(n.members_truncated !== undefined ? { membersTruncated: n.members_truncated } : {}),
      ...(n.group_codes && n.group_codes.length > 0 ? { groupCodes: n.group_codes } : {}),
      ...(n.remark_group ? { remarkGroup: n.remark_group } : {}),
    })),
  ]
  const visibleIds = new Set(nodes.map(n => n.id))
  const graphCoverage: GraphBuildCoverage = {
    candidateNodes: rawNodes.length,
    retainedNodes: top.length,
    droppedNodes: Math.max(0, rawNodes.length - top.length),
    droppedEdges: 0,
    droppedEdgeEndpoints: 0,
    derived: {
      pairMemberLimit: CLIENT_COMMON_PAIR_MEMBER_LIMIT,
      pairWorkBudget: CLIENT_COMMON_PAIR_WORK_BUDGET,
      pairWorkUsed: 0,
      pairWorkExhausted: false,
      commonGroup: {
        sources: 0,
        truncatedSources: 0,
        candidatePairs: 0,
        consideredPairs: 0,
        skippedPairs: 0,
      },
      commonMember: {
        sources: 0,
        truncatedSources: 0,
        candidatePairs: 0,
        consideredPairs: 0,
        skippedPairs: 0,
      },
      commonGeneratedPairs: 0,
      commonBelowThresholdPairs: 0,
      commonEmittedEdges: 0,
      commonMergedEdges: 0,
      commonSuppressedByAuthoritative: 0,
      commonDroppedByEdgeBudget: 0,
      intimacyGeneratedEdges: 0,
      intimacyEmittedEdges: 0,
      intimacyMergedEdges: 0,
      intimacySuppressedByAuthoritative: 0,
      intimacyDroppedByEdgeBudget: 0,
      truncated: false,
    },
  }
  const derivedCoverage = graphCoverage.derived!
  /**
   * 同一节点对只保留一条视觉边，但关系语义全部进入 `relations`。
   * 这同时解决旧实现的两个问题：
   *   · 后端带类型边被完全忽略；
   *   · `paired` 去重会让同群 + 同班 + 同首字的语义只剩最先插入的一种。
   */
  const pairBuckets = new Map<string, PairBucket>()
  const relationIdentity = (r: RelationDraft): string => JSON.stringify([
    r.kind,
    r.rawKind ?? '',
    r.label ?? '',
    r.source,
    r.target,
    r.bidirectional,
  ])

  const addRelation = (draft: RelationDraft): RelationAddResult => {
    if (!draft.source || !draft.target || draft.source === draft.target) {
      return { pairAdded: false, relationAdded: false, suppressedByAuthoritative: false }
    }
    if (!visibleIds.has(draft.source) || !visibleIds.has(draft.target)) {
      return { pairAdded: false, relationAdded: false, suppressedByAuthoritative: false }
    }
    const key = pairKey(draft.source, draft.target)
    let bucket = pairBuckets.get(key)
    const pairAdded = bucket === undefined
    if (!bucket) {
      bucket = {
        first: draft.source < draft.target ? draft.source : draft.target,
        second: draft.source < draft.target ? draft.target : draft.source,
        relations: new Map(),
      }
      pairBuckets.set(key, bucket)
    }

    if (draft.origin === 'derived') {
      const equivalents = DERIVED_BACKEND_EQUIVALENTS[draft.kind]
      if (equivalents) {
        for (const relation of bucket.relations.values()) {
          if (
            relation.origin === 'backend'
            && (relation.rawKind === undefined || equivalents.has(relation.rawKind))
          ) {
            return { pairAdded: false, relationAdded: false, suppressedByAuthoritative: true }
          }
        }
      }
    }

    // 无向关系反向重复上报要合并，但有向关系必须保留 A→B 与 B→A 两条语义。
    const identityDraft: RelationDraft = draft.bidirectional
      ? {
          ...draft,
          source: draft.source < draft.target ? draft.source : draft.target,
          target: draft.source < draft.target ? draft.target : draft.source,
        }
      : draft
    const ident = relationIdentity(identityDraft)
    const existing = bucket.relations.get(ident)
    const weight = Math.max(0, finiteNumber(draft.weight, 1))
    const recordCount = Math.max(1, Math.round(finiteNumber(draft.recordCount, 1)))
    const evidence = [...new Set(draft.evidence ?? [])].filter(Boolean).slice(0, MAX_EDGE_EVIDENCE)
    const evidenceCount = Math.max(
      evidence.length,
      draft.evidenceCount ?? 0,
    )
    if (!existing) {
      bucket.relations.set(ident, {
        kind: draft.kind,
        ...(draft.rawKind ? { rawKind: draft.rawKind } : {}),
        ...(draft.label ? { label: draft.label } : {}),
        source: draft.source,
        target: draft.target,
        bidirectional: draft.bidirectional,
        weight,
        count: recordCount,
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(evidenceCount > 0 ? { evidenceCount } : {}),
        origin: draft.origin,
        ...(draft.strength !== undefined ? { strength: draft.strength } : {}),
        ...(draft.dist !== undefined ? { dist: draft.dist } : {}),
      })
      return { pairAdded, relationAdded: true, suppressedByAuthoritative: false }
    }

    // 同一关系重复上报：权重可累加；后端观测覆盖客户端推导时以观测为准，避免双计。
    if (existing.origin === 'backend' && draft.origin === 'backend') {
      existing.weight += weight
    } else if (existing.origin !== 'backend' && draft.origin === 'backend') {
      existing.origin = 'backend'
      existing.weight = Math.max(existing.weight, weight)
    } else if (existing.origin !== draft.origin) {
      existing.weight = Math.max(existing.weight, weight)
    }
    existing.count += recordCount
    existing.evidenceCount = Math.max(
      existing.evidenceCount ?? existing.evidence?.length ?? 0,
      (existing.evidenceCount ?? 0) + evidenceCount,
    )
    if (evidence.length > 0) {
      const merged = [...(existing.evidence ?? [])]
      const seen = new Set(merged)
      for (const item of evidence) {
        if (seen.has(item) || merged.length >= MAX_EDGE_EVIDENCE) continue
        seen.add(item)
        merged.push(item)
      }
      if (merged.length > 0) existing.evidence = merged
    }
    if (draft.strength !== undefined) {
      existing.strength = Math.max(existing.strength ?? 0, draft.strength)
    }
    if (draft.dist !== undefined && existing.dist === undefined) existing.dist = draft.dist
    return { pairAdded: false, relationAdded: false, suppressedByAuthoritative: false }
  }

  // ① 后端观测边优先消费。旧实现完全忽略 env.edges；这里不依赖 group_codes 再猜一遍。
  const authoritativeCommonPairs = new Set<string>()
  const authoritativeIntimacyPairs = new Set<string>()
  for (const raw of env.edges ?? []) {
    if (!raw || typeof raw.source !== 'string' || typeof raw.target !== 'string') continue
    if (!visibleIds.has(raw.source) || !visibleIds.has(raw.target)) {
      graphCoverage.droppedEdgeEndpoints += 1
      continue
    }
    const info = normalizeRawEdgeKind(raw)
    const weight = Math.max(0, finiteNumber(raw.weight, 1))
    const rawType = rawEdgeTypeKey(raw)
    if (info.kind === 'common' && COMMON_THRESHOLD_TYPES.has(rawType) && weight < s.minCommon) continue
    if (info.kind === 'common' && (rawType === '' || DERIVED_BACKEND_EQUIVALENTS.common?.has(rawType))) {
      authoritativeCommonPairs.add(pairKey(raw.source, raw.target))
    }
    if (info.kind === 'intimacy' && (rawType === '' || DERIVED_BACKEND_EQUIVALENTS.intimacy?.has(rawType))) {
      authoritativeIntimacyPairs.add(pairKey(raw.source, raw.target))
    }
    const dir = normalizeDirection(raw, info.kind)
    const evidence = relationEvidence(raw)
    const evidenceTotal = Math.max(
      evidence.count,
      typeof raw.evidence === 'string' ? 1 : raw.evidence?.length ?? 0,
      raw.evidences?.length ?? 0,
      finiteNumber(raw.evidence_count, 0),
    )
    addRelation({
      ...info,
      ...dir,
      weight,
      origin: 'backend',
      ...(evidence.values.length > 0 ? { evidence: evidence.values } : {}),
      ...(evidenceTotal > 0 ? { evidenceCount: evidenceTotal } : {}),
      ...(raw.strength !== undefined ? { strength: finiteNumber(raw.strength, 0) } : {}),
      ...(raw.dist !== undefined ? { dist: finiteNumber(raw.dist, 0) } : {}),
      recordCount: Math.max(1, Math.round(finiteNumber(raw.count, 1))),
    })
  }

  // ② 客户端兼容推导：people=共同群数交集；groups=共同成员数交集。
  const byGroup = new Map<string, string[]>()
  const byMember = new Map<string, string[]>()
  for (const n of top) {
    if (s.mode === 'people' || s.mode === 'all') {
      for (const c of n.group_codes ?? []) {
        let arr = byGroup.get(c)
        if (!arr) { arr = []; byGroup.set(c, arr) }
        arr.push(n.id)
      }
    }
    if (s.mode === 'groups' || s.mode === 'all') {
      for (const m of n.shared_members ?? []) {
        let arr = byMember.get(m.username)
        if (!arr) { arr = []; byMember.set(m.username, arr) }
        arr.push(n.id)
      }
    }
  }
  /*
   * 每群/每成员仍保留前 80 人，避免大群全配对造成 O(G²) 卡顿；但人员上限和
   * 全局 pair-work 预算都写入 coverage。后端已有同义权威关系时不再生成客户端
   * 副本，既避免重复边，也让“权威数据覆盖了多少推导”可审计。
   */
  interface CommonPairAccumulator { first: string; second: string; weight: number; evidence: Set<string> }
  const commonPairs = new Map<string, CommonPairAccumulator>()
  const addDerivedPairs = (
    rawList: readonly string[],
    evidence: string,
    sourceCoverage: GraphPairSourceCoverage,
  ): void => {
    const list = [...new Set(rawList)]
    if (list.length < 2) return
    sourceCoverage.sources += 1
    sourceCoverage.candidatePairs += combinationsOfTwo(list.length)
    const members = list.length > CLIENT_COMMON_PAIR_MEMBER_LIMIT
      ? list.slice(0, CLIENT_COMMON_PAIR_MEMBER_LIMIT)
      : list
    let truncated = members.length < list.length
    pairLoop:
    for (let i = 0; i < members.length; i++) {
      const ai = members[i]
      if (!ai) continue
      for (let j = i + 1; j < members.length; j++) {
        const bj = members[j]
        if (!bj) continue
        if (derivedCoverage.pairWorkUsed >= CLIENT_COMMON_PAIR_WORK_BUDGET) {
          derivedCoverage.pairWorkExhausted = true
          truncated = true
          break pairLoop
        }
        derivedCoverage.pairWorkUsed += 1
        sourceCoverage.consideredPairs += 1
        const key = pairKey(ai, bj)
        if (authoritativeCommonPairs.has(key)) {
          derivedCoverage.commonSuppressedByAuthoritative += 1
          continue
        }
        const acc = commonPairs.get(key)
        if (acc) {
          acc.weight += 1
          acc.evidence.add(evidence)
        } else {
          commonPairs.set(key, {
            first: ai < bj ? ai : bj,
            second: ai < bj ? bj : ai,
            weight: 1,
            evidence: new Set([evidence]),
          })
        }
      }
    }
    if (truncated) sourceCoverage.truncatedSources += 1
  }
  for (const [groupId, list] of byGroup) {
    addDerivedPairs(list, env.group_names?.[groupId] || groupId, derivedCoverage.commonGroup)
  }
  if (s.mode === 'groups' || s.mode === 'all') {
    for (const [memberId, list] of byMember) addDerivedPairs(list, memberId, derivedCoverage.commonMember)
  }
  for (const sourceCoverage of [derivedCoverage.commonGroup, derivedCoverage.commonMember]) {
    sourceCoverage.skippedPairs = Math.max(0, sourceCoverage.candidatePairs - sourceCoverage.consideredPairs)
  }
  const derivedCommon = [...commonPairs.values()]
    .filter((pair) => pair.weight >= s.minCommon)
    .sort((a, b) => b.weight - a.weight || a.first.localeCompare(b.first) || a.second.localeCompare(b.second))
  derivedCoverage.commonGeneratedPairs = derivedCommon.length
  derivedCoverage.commonBelowThresholdPairs = Math.max(0, commonPairs.size - derivedCommon.length)
  derivedCoverage.truncated = derivedCoverage.pairWorkExhausted
    || derivedCoverage.commonGroup.truncatedSources > 0
    || derivedCoverage.commonMember.truncatedSources > 0

  /**
   * 推导层只占后端观测边之外的余量。观测边本身是权威数据，不因 6000 条显示上限被删；
  * 若后端一次返回超过上限，模型仍完整保留，画布可选择截断绘制。
  */
  const observedCap = Math.min(OBSERVED_EDGE_CAP, edgeDensityCap(nodes.length))
  const addObservedDerived = (draft: RelationDraft): RelationAddResult & { droppedByEdgeBudget: boolean } => {
    const key = pairKey(draft.source, draft.target)
    if (!pairBuckets.has(key) && pairBuckets.size >= observedCap) {
      graphCoverage.droppedEdges += 1
      return {
        pairAdded: false,
        relationAdded: false,
        suppressedByAuthoritative: false,
        droppedByEdgeBudget: true,
      }
    }
    return { ...addRelation(draft), droppedByEdgeBudget: false }
  }

  // ③ 「我」→ 每个节点的亲密度连线(消息量→距离/强度指数衰减,参照参考实现 intimacyPull)
  if (selfNode) {
    for (const n of top) {
      const isGroup = n.kind === 'group'
      const w = isGroup
        ? Math.max(1, weightOf(n))
        : personWeight(n.is_friend === true, n.msg_count ?? 0)
      const t = 1 - Math.exp(-w / (isGroup ? 60 : 600))
      derivedCoverage.intimacyGeneratedEdges += 1
      if (authoritativeIntimacyPairs.has(pairKey(SELF_ID, n.id))) {
        derivedCoverage.intimacySuppressedByAuthoritative += 1
        continue
      }
      const result = addObservedDerived({
        source: SELF_ID, target: n.id,
        weight: n.is_friend === true && !isGroup ? Math.max(1, n.group_count ?? 0) : Math.max(1, n.msg_count ?? 0),
        // 亲密度距离只随亲密度变化;「连线长度」由仿真侧统一应用
        dist: 340 - t * 260,
        strength: 0.02 + t * 0.16,
        kind: 'intimacy',
        bidirectional: true,
        origin: 'derived',
      })
      if (result.suppressedByAuthoritative) {
        derivedCoverage.intimacySuppressedByAuthoritative += 1
      } else if (result.droppedByEdgeBudget) {
        derivedCoverage.intimacyDroppedByEdgeBudget += 1
      } else if (result.relationAdded) {
        derivedCoverage.intimacyEmittedEdges += 1
      } else {
        derivedCoverage.intimacyMergedEdges += 1
      }
    }
  }
  for (const p of derivedCommon) {
    const result = addObservedDerived({
      source: p.first,
      target: p.second,
      weight: p.weight,
      dist: (s.mode === 'people' ? 200 : 220) / Math.sqrt(Math.max(p.weight, 1)),
      kind: 'common',
      bidirectional: true,
      origin: 'derived',
      evidence: [...p.evidence],
      evidenceCount: p.evidence.size,
    })
    if (result.suppressedByAuthoritative) {
      derivedCoverage.commonSuppressedByAuthoritative += 1
    } else if (result.droppedByEdgeBudget) {
      derivedCoverage.commonDroppedByEdgeBudget += 1
    } else if (result.relationAdded) {
      derivedCoverage.commonEmittedEdges += 1
    } else {
      derivedCoverage.commonMergedEdges += 1
    }
  }

  // ── 推断层（虚线）：同备注编号(class) 与 首字相同(initial) 共用同一套机制 ─────────
  // 两类都停在「锚点生成树 + 按余量截断」，而不是完全图。首字层实测：默认视图同首字组
  // 34 个、候选点对 1534 条，而**未被使用的余量只有 224 条**（见 graph-budget 的 edgeHeadroom）
  // —— 完全图根本画不下，硬画就会按分桶把「共同群」这类真实观测边挤掉。
  const degOf = new Map<string, number>()
  for (const bucket of pairBuckets.values()) {
    degOf.set(bucket.first, (degOf.get(bucket.first) ?? 0) + 1)
    degOf.set(bucket.second, (degOf.get(bucket.second) ?? 0) + 1)
  }
  /** 一对节点只占一个视觉槽位；不同推断关系的语义仍会合并进该槽位。 */
  const pairHasRelation = (key: string, kind: GEdgeKind): boolean => {
    const bucket = pairBuckets.get(key)
    if (!bucket) return false
    for (const relation of bucket.relations.values()) {
      if (relation.kind === kind) return true
    }
    return false
  }
  /** 已经有「首字边」的节点：只用于 `coverAll` 的兜底扫描。 */
  const initialCovered = new Set<string>()
  type InferredAddResult = 'added' | 'merged' | 'ignored'
  /**
   * 加一条推断关系（无向）。
   *
   * 返回 `added` 表示新增视觉点对，`merged` 表示该点对已有观测/其他关系但本次语义
   * 已成功并入，`ignored` 才是非法端点、自连、重复关系或额度已满。
   */
  const addInferred = (a: string, b: string, kind: 'class' | 'initial'): InferredAddResult => {
    if (!a || !b || a === b) return 'ignored'
    const key = pairKey(a, b)
    if (!pairBuckets.has(key) && pairBuckets.size >= edgeDensityCap(nodes.length)) return 'ignored'
    const result = addRelation({
      source: a,
      target: b,
      weight: 1,
      dist: 200,
      kind,
      bidirectional: true,
      origin: 'derived',
    })
    if (!result.relationAdded && !pairHasRelation(key, kind)) return 'ignored'
    if (kind === 'initial') {
      initialCovered.add(a)
      initialCovered.add(b)
    }
    return result.pairAdded ? 'added' : 'merged'
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
   * @returns 实际新增的**视觉边**条数；合并到已有点对的语义不占额度。
   */
  const addAnchorTree = (ids: string[], kind: 'class' | 'initial', coverAll = false): number => {
    // 锚点数 ≥1 且 ≤ n-1：保证「锚之间串起来 + 其余各挂一条」正好是 n-1 条
    const anchors = ids.slice(0, Math.min(CLASS_ANCHORS, Math.max(1, ids.length - 1)))
    const before = pairBuckets.size
    for (let i = 1; i < anchors.length; i++) addInferred(anchors[0] as string, anchors[i] as string, kind)
    const rest = ids.slice(anchors.length)
    rest.forEach((id, i) => {
      const preferred = anchors[i % anchors.length] as string
      if (addInferred(preferred, id, kind) !== 'ignored') return
      if (!coverAll) return
      // 首选锚点已连通 → 依次试其余锚点
      for (let k = 1; k < anchors.length; k++) {
        if (addInferred(anchors[(i + k) % anchors.length] as string, id, kind) !== 'ignored') return
      }
    })
    // coverAll 兜底扫描：**锚点链本身也可能整条被更强边占掉**（真机实测：不加这一步，
    // 34 个首字组里只有 22 个能靠首字边自己连通，剩下 12 组里有人「这层一条线都没有」）。
    // 逐个补齐，让组内每个成员至少有一条蓝虚线。
    if (coverAll) {
      for (const id of ids) {
        if (initialCovered.has(id)) continue
        for (const other of ids) {
          if (other !== id && addInferred(other, id, kind) !== 'ignored') break
        }
      }
    }
    return pairBuckets.size - before
  }

  // 同备注编号边(class)：同样按余量截断。真机全量视图 class 上限只有 77 条、远没到额度，
  // 但额度必须由公式给出，不能靠「实测它很小」来保证 —— 备注里带编号的人一多，它就会
  // 独自吃掉整个额度、把后面的首字层挤成 0。整组放不下就跳过**整组**（用 continue 而不是
  // break：后面还有小组合适放），这样「每个被处理的组恰好 n−1 条」这条硬约束不会被从中间截断。
  if (s.mode === 'people' && s.remarkClass) {
    let left = edgeHeadroom(nodes.length, pairBuckets.size)
    for (const ids of keyedGroups(n => n.remark_group)) {
      if (ids.length - 1 > left) continue
      left -= addAnchorTree(ids, 'class')
    }
  }

  // 首字连边(initial)：先问余量，再决定生成多少 —— 额度来自 graph-budget（与绘制层同源）。
  if (s.mode === 'people' && s.firstChar) {
    const groups = keyedGroups(n => firstCharKey(n.label))
    // 余量 = 密度上限 − 已经真正产出的视觉边（后端观测 + 推导观测 + 班级层）。
    const headroom = edgeHeadroom(nodes.length, pairBuckets.size)
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
            const key = pairKey(a, b)
            if (pairBuckets.has(key)) continue
            cand.push({ a, b, score: (degOf.get(a) ?? 0) + (degOf.get(b) ?? 0) })
          }
        }
      }
      cand.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
      for (const c of cand) {
        if (left <= 0) break
        if (addInferred(c.a, c.b, 'initial') === 'added') left--
      }
    }
  }

  const relationRank = (r: GEdgeRelation): number =>
    (r.origin === 'backend' ? 0 : 10) + RELATION_KIND_RANK[r.kind]
  const observedRelation = (r: GEdgeRelation): boolean =>
    r.origin === 'backend' || OBSERVED_EDGE_KINDS.has(r.kind)
  const edges: GEdge[] = [...pairBuckets.values()].map((bucket) => {
    const relations = [...bucket.relations.values()].sort((a, b) =>
      relationRank(a) - relationRank(b)
      || b.weight - a.weight
      || edgeRelationLabel(a).localeCompare(edgeRelationLabel(b))
      || a.source.localeCompare(b.source)
      || a.target.localeCompare(b.target))
    const primary = relations[0]
    if (!primary) {
      throw new Error('graph edge bucket without relation')
    }
    const directedPairs = new Set(
      relations.filter(r => !r.bidirectional).map(r => JSON.stringify([r.source, r.target])),
    )
    const hasBothDirections = relations.some(r =>
      !r.bidirectional && directedPairs.has(JSON.stringify([r.target, r.source])))
    const bidirectional = relations.some(r => r.bidirectional) || hasBothDirections
    const source = primary.source
    const target = primary.target
    const fallbackDist = primary.kind === 'intimacy'
      ? 340
      : (s.mode === 'people' ? 200 : 220) / Math.sqrt(Math.max(primary.weight, 1))
    return {
      source,
      target,
      weight: Math.max(0, primary.weight),
      dist: Math.max(1, primary.dist ?? fallbackDist),
      kind: primary.kind,
      ...(bidirectional ? { bidirectional: true } : {}),
      relations,
      relationCount: relations.length,
      ...(relations.some(r => r.origin === 'backend') ? { authoritative: true } : {}),
      ...(primary.strength !== undefined ? { strength: primary.strength } : {}),
    }
  })
  edges.sort((a, b) =>
    Number(b.authoritative === true) - Number(a.authoritative === true)
    || Number((b.relations ?? []).some(observedRelation)) - Number((a.relations ?? []).some(observedRelation))
    || RELATION_KIND_RANK[a.kind] - RELATION_KIND_RANK[b.kind]
    || b.weight - a.weight
    || a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target))

  // 社区检测跑在「共同群/共同成员/同班级」等无向结构边上；首字层刻意不参与，
  // 避免一个粗粒度首字把观测到的圈子结构带偏。
  const communityCount = detectCommunities(nodes, edges.filter(e => e.kind !== 'initial'))
  derivedCoverage.truncated = derivedCoverage.truncated
    || derivedCoverage.intimacyDroppedByEdgeBudget > 0
    || derivedCoverage.commonDroppedByEdgeBudget > 0
  return { nodes, edges, communityCount, kindCounts: countByKind(nodes), coverage: { ...graphCoverage, ...(normalizedEnv.coverage ? { server: normalizedEnv.coverage } : {}) } }
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
  return { nodes, edges, communityCount: graph.communityCount, kindCounts: countByKind(nodes) }
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

/**
 * 与指定节点相连的边（按权重降序，含对端节点解析）。
 *
 * 默认返回全部：详情面板过去只取前 12 条却把结果长度标成「相连关系 (12)」，
 * 大群/高连接节点看起来像少了关系。显示层用可滚动区承载，不再从数据层静默截断。
 */
export function connectedEdgesOf(
  graph: BuiltGraph,
  nodeId: string,
  limit = Number.POSITIVE_INFINITY,
): Array<{ edge: GEdge; other: GNode | undefined }> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const out = graph.edges
    .filter(e => e.source === nodeId || e.target === nodeId)
    .map(e => ({
      edge: e,
      other: byId.get(e.source === nodeId ? e.target : e.source),
    }))
    .sort((a, b) =>
      b.edge.weight - a.edge.weight
      || (b.edge.relationCount ?? 1) - (a.edge.relationCount ?? 1))
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out
}

/** 共同群名（详情展示，群名缺失时回退 code）；默认返回全部，避免详情只显示前 6 个却无提示。 */
export function sharedGroupNames(
  n: GNode,
  groupNames: Record<string, string> | undefined,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const out = (n.groupCodes ?? [])
    .map(c => groupNames?.[c] || c)
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out
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
  if (!knowledge) return { nodes: [], edges: [], communityCount: 0, kindCounts: {} }

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
    // mention 是笔记 ↔ 文件，suggest 是文件 ↔ 实体；两者都能从任一端互查，
    // 与 wiki 的单向引用不同，因此两端都画箭头。
    ...(e.kind === 'mention' || e.kind === 'suggest' ? { bidirectional: true } : {}),
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
  return { nodes: allNodes, edges: keptEdges, communityCount, kindCounts: countByKind(allNodes) }
}
