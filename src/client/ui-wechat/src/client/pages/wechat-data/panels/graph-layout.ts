/**
 * 图谱力导向布局（ForceAtlas2）+ 布局 Worker 调度。
 *
 * 调用方只需要 `runLayout` 一个入口，其余决定都在模块内部：指纹没变就直接复用坐标、
 * 小图在主线程同步收敛、大图丢进 Worker 并带 key 校验回包。阈值与档位只写在这里 ——
 * 否则「多少节点开始走 Worker」这类数字会在两处各存一份然后慢慢跑偏。
 *
 * 三条贯穿全文件的原因（各自在代码处展开）：
 *   ① 坐标必须可复现：同一张图 + 同一组力度 → 同一份坐标。初值不用 Math.random，
 *      而是由节点 id 哈希而来（详见 initialPosition）。
 *   ② 指纹（graphDataKey）是这份纯函数的入参摘要：变了才重算；它同时是 Worker
 *      回包的校验键（详见 workerWaiters）。
 *   ③ 力度参数只有 fa2Settings 一处：主线程与 Worker 都从这里取，两条路径不可能给出
 *      两种手感（详见 assignLayout）。
 */
import Graph from 'graphology'
import forceAtlas2, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2'
import { DEFAULT_GRAPH_SETTINGS, type BuiltGraph, type GNode, type GraphSettings } from './graph-model.ts'
import { nodeRadius } from './graph-canvas.ts'
// 作用域名（'social' / 'kb:<id>'）与 LRU 上限只有 `../kb-scope-keys.ts` 一处定义，
// 这里**不手写** 'kb:' 前缀 —— 拼错不会抛错，只会静默用另一个键，也就是静默串库。
import { DEFAULT_KB_ID, POSITION_SCOPES_MAX, SOCIAL_SCOPE, kbScope } from '../kb-scope-keys.ts'

/** 画布坐标。与旧 ECharts 画布共用同一份 localStorage 形状（{id: {x, y}}）。 */
export interface GridPos { x: number; y: number }

/**
 * ≥ 该节点数才走 Worker。
 * 200 以下的图在主线程同步跑只占几毫秒（用户感知不到），而 Worker 的启动 + 结构化克隆
 * 往返反而更贵 —— 所以这条线是「什么时候值得付通讯成本」的分界，不是技术限制。
 */
const WORKER_NODE_THRESHOLD = 200

/** 四叉树近似斥力的启用门槛：节点太少时 O(n²) 直接算更快，树本身也有开销。 */
const BARNES_HUT_MIN_NODES = 50

/** FA2 的基准刻度：所有滑块都在这个基准上做倍数（默认参数 = 基准，手感等同旧画布）。 */
const BASE_SCALING_RATIO = 100
const BASE_GRAVITY = 1
const BARNES_HUT_THETA = 0.5

/** 力度倍数的钳制窗口：滑块拉到极限也只到基准的 1/4 ~ 4 倍，避免极端值把布局推成噪点。 */
const FORCE_FACTOR_MIN = 0.25
const FORCE_FACTOR_MAX = 4

/**
 * 迭代次数分档（沿用参考实现 llm_wiki graph-view 的档位）。
 * 节点越多单轮越贵，总耗时靠迭代数压住；单调不增，spec 锁的是这条与各档边界。
 */
export function layoutIterations(nodeCount: number): number {
  if (nodeCount > 2500) return 28
  if (nodeCount > 1200) return 40
  if (nodeCount > 600) return 65
  if (nodeCount > 250) return 90
  return 140
}

/** 滑块值 → 相对默认设置的倍数（NaN/缺失按默认处理，免得把 NaN 喂进 FA2 直接抛错）。 */
function forceFactor(value: number, base: number): number {
  if (!Number.isFinite(value) || !(base > 0)) return 1
  return Math.min(FORCE_FACTOR_MAX, Math.max(FORCE_FACTOR_MIN, value / base))
}

/** 节点越多越要铺开（与旧 ECharts 版的 density 同口径：120 节点为 1 倍）。 */
function densityScale(nodeCount: number): number {
  return 1 + Math.log2(Math.max(1, nodeCount / 120))
}

/**
 * 力度滑块 → FA2 的数值档位。返回值只含数字，布尔开关由 assignLayout 补齐
 * （装不下布尔值，而签名必须是数字表）。
 *
 * 键**具名**而不是 `Record<string, number>`：后者在 `noUncheckedIndexedAccess` 下让每个消费方
 * 都把一定存在的键读成 `number | undefined`，于是数值比较只能靠兜底糊 —— 而这里兜什么都是假的，
 * 五个键在下面的字面量里逐个算出来，少一个就是编译不过。
 *
 * FA2 的物理量（见 graphology-layout-forceatlas2/iterate.js）：
 *   斥力 ∝ scalingRatio；强引力模式下引力 = mass × gravity；边长 ≈ √(scalingRatio × m₁m₂ / 边权影响)。
 * 所以：斥力/间距/圈子分离/连线长度四档都乘进缩放比（越大越开），
 * 而「吸引力」反向除 —— 拉得越紧，连线越短、边长越短。
 */
// 用 type 而不是 interface：只有对象字面量类型能隐式满足 `Record<string, number>` 的索引签名，
// 换成 interface 会在下面喂给布局器的那一处报 TS2322（而那个接收方签名不该被放宽）。
export type Fa2Params = {
  scalingRatio: number
  gravity: number
  edgeWeightInfluence: number
  slowDown: number
  barnesHutTheta: number
}

export function fa2Settings(settings: GraphSettings, nodeCount: number): Fa2Params {
  const d = DEFAULT_GRAPH_SETTINGS
  const repulsionK = forceFactor(settings.forceRepulsion, d.forceRepulsion)
  const gapK = forceFactor(settings.nodeGap, d.nodeGap)
  const communityK = forceFactor(settings.communitySeparation, d.communitySeparation)
  const lengthK = forceFactor(settings.forceEdgeLength, d.forceEdgeLength)
  const attractionK = forceFactor(settings.forceAttraction, d.forceAttraction)
  const centripetalK = forceFactor(settings.forceCentripetal, d.forceCentripetal)
  return {
    scalingRatio:
      (BASE_SCALING_RATIO * densityScale(nodeCount) * repulsionK * gapK * communityK * lengthK) / attractionK,
    gravity: BASE_GRAVITY * centripetalK,
    // 边权影响的指数：本模块自己归一化边权（1~4），这里只用吸引力滑块调「强边拉多紧」
    edgeWeightInfluence: attractionK,
    // 节点越多越需要压住步长，否则大图来回震荡、迭代完还在抖
    slowDown: 1 + Math.log(Math.max(2, nodeCount)),
    barnesHutTheta: BARNES_HUT_THETA,
  }
}

/** 参与的力度参数（也是指纹里「参数部分」的白名单）。 */
const FORCE_KEYS = [
  'forceCentripetal',
  'forceRepulsion',
  'forceAttraction',
  'forceEdgeLength',
  'nodeGap',
  'communitySeparation',
] as const

/** FNV-1a 32 位哈希：只做摘要，不做安全边界 —— 碰撞的代价是「复用了上一次的坐标」。 */
function hashParts(parts: readonly string[]): string {
  let hash = 2166136261
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    // 逐段收尾：否则 ["ab","c"] 与 ["a","bc"] 会摘出同一个值
    hash ^= 0xff
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * 布局输入指纹。为什么要它：
 *   ① 复用：面板重渲染、切走再切回来、只改外观参数，都不该重新收敛一遍；
 *   ② 校验：Worker 的结果回来时必须能证明它属于当前这张图（见 workerWaiters 的 key 比对）。
 * 只放「会改变坐标」的量 —— 节点 id 集合、边（端点 + 权重）集合、六个力度滑块；
 * 数组顺序不进指纹（上游换个排序不该触发全图重排），
 * 外观与策略参数（节点缩放 / 标签 / 模糊 / 锁定 / 模式 …）同样不进（改它们不该重排）。
 */
export function graphDataKey(graph: BuiltGraph, settings: GraphSettings): string {
  const nodeIds = graph.nodes.map(n => n.id).sort()
  const edges = graph.edges
    .map(e => `${e.source}|${e.target}|${Math.round(e.weight * 1000)}`)
    .sort()
  const forces = FORCE_KEYS.map(k => Number(settings[k]).toFixed(3)).join('|')
  // 长度同时进指纹：哈希只有 32 位，带上规模才是「几乎不可能撞」的组合
  return `n${nodeIds.length}:${hashParts(nodeIds)}:e${edges.length}:${hashParts(edges)}:f${forces}`
}

/**
 * 坐标持久化的 localStorage 键与数据形状。
 *
 * v2（当前）：`Record<scope, Record<nodeId, {x,y}>>`，外加一个 `__lru` 字段记录最近写入顺序
 * —— **一个作用域一份布局**。作用域是 `'social'` 或 `'kb:<id>'`（拼法只在
 * `../kb-scope-keys.ts`，这里不手写）。
 *
 * 为什么必须分作用域：节点 id（`note:7` / `kb:项目组`）**不带库前缀**（刻意的，见设计稿 §4.4），
 * 于是两库之间 id 是撞的 —— 共用一张扁平表时，甲库调好的形状会被当成乙库的初值，
 * 切一次库互相污染一次，而画面上只表现为「形状有点像上一个库」。
 */
const POSITION_KEY = 'dsh-graph-layout-v2'

/**
 * v1 键（旧形状：扁平 `Record<nodeId, {x,y}>`，社交图谱与知识图谱共用一张表）。
 *
 * **只读**，且只在 v2 里没有该作用域时读（见 `loadSavedPositions`）。保留它的理由：
 * 那是用户上一次调好的形状，删掉等于让老用户的所有布局重来一遍；而回退是只读的，
 * 不占额外空间。不把它摊进每个作用域的理由见 `loadSavedPositions`。
 */
const POSITION_KEY_V1 = 'dsh-graph-layout-v1'

/** v2 文件里记录 LRU 顺序的保留字段（作用域名不可能取这个名字：要么 'social'，要么 'kb:<id>'）。 */
const LRU_FIELD = '__lru'

/** 作用域 → 坐标表。 */
type ScopeTables = Record<string, Record<string, GridPos>>

/**
 * 一张坐标表：丢掉认不出的条目。
 * 只认得下有限数 —— 坏掉的坐标会把整张图带进 NaN，宁可少一条。
 */
function sanitizeTable(raw: unknown): Record<string, GridPos> {
  const out: Record<string, GridPos> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const pos = value as Partial<GridPos> | null
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) out[id] = { x: pos.x as number, y: pos.y as number }
  }
  return out
}

/** 读一张扁平表（v1 的形状）。任何异常都当成「没有历史布局」。 */
function readFlat(key: string): Record<string, GridPos> {
  try {
    const raw = localStorage.getItem(key)
    return raw ? sanitizeTable(JSON.parse(raw)) : {}
  } catch {
    /* localStorage 不可用 / 值被写坏：布局只是增强，没有它照样能画 */
    return {}
  }
}

/** 读 v2 文件：坐标表 + LRU 顺序（`__lru` 里没列到的键按「最久未写」处理）。 */
function readV2(): { tables: ScopeTables; order: string[] } {
  const tables: ScopeTables = {}
  let order: string[] = []
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return { tables, order }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { tables, order }
    const lru = parsed[LRU_FIELD]
    if (Array.isArray(lru)) order = lru.filter((s): s is string => typeof s === 'string')
    for (const [scope, value] of Object.entries(parsed)) {
      if (scope === LRU_FIELD) continue
      // 空表也算「有」：`{scope: {}}` 是「这个作用域没有布局」的合法表达。
      // 按「非空才算存在」处理的话，空表会在下次读取时**回退到 v1** —— 等于把别人的形状认回来。
      tables[scope] = sanitizeTable(value)
    }
  } catch {
    /* 读不到就当成「没有历史布局」 */
  }
  return { tables, order }
}

/**
 * 读某个作用域上次落盘的布局。
 *
 * 顺序：v2 里命中该作用域 → 就是它；否则**只读回退**到 v1 的扁平表，且**仅限**
 * `'social'` 与默认库 —— v1 时代只存在过这两个作用域（知识库那时只有一个，社交图谱只有一张），
 * 别的库去读 v1 等于把别人的形状认成自己的。回退**不写入** v2：
 * 下一次落盘（`savePositions`）会自然把它升级成 v2 里的一条。
 *
 * 为什么不把 v1 一次性摊进每个作用域：v1 里混着社交与知识**两套**坐标（靠节点 id 不重叠
 * 才没打架），按库复制就是 6000 条 × N 个库，直接撞 localStorage 配额；而回退读只在首次生效，
 * 代价为零。
 * @param scope - 作用域名（`'social'` 或 `'kb:<id>'`）。
 * @returns 该作用域的坐标（没有就是空表）。
 */
export function loadSavedPositions(scope: string): Map<string, GridPos> {
  const { tables } = readV2()
  const hit = tables[scope]
  const fallback = scope === SOCIAL_SCOPE || scope === kbScope(DEFAULT_KB_ID)
  const table = hit ?? (fallback ? readFlat(POSITION_KEY_V1) : {})
  const out = new Map<string, GridPos>()
  for (const [id, pos] of Object.entries(table)) out.set(id, { x: pos.x, y: pos.y })
  return out
}

/**
 * 落盘某个作用域的布局：`v2[scope] = pos`，并把该作用域移到 LRU 首位。
 *
 * 上限 `POSITION_SCOPES_MAX`：总占用是「单图上限 × 作用域数」，而渲染进程的 localStorage 里
 * 还住着消息缓存 —— 真机实测过它会被占满、`setItem` 抛 `QuotaExceededError`。
 * 超出按「最久未写」淘汰：代价只是那个库下次进入重新布局（笔记在主库，不在 localStorage）。
 * 顺序写进文件里（`__lru`）而不是靠对象键序：本文件的读-改-写要跨会话保持「谁最新」，
 * 而键序是隐式的、且会被「先写哪个字段」这种无关改动带偏。
 *
 * 失败（配额满 / 隐私模式）不抛：这只影响「下次进入是否原地恢复」。
 * 但**不能连日志都不留**：静默吞掉的表现是「布局怎么调都恢复不了」——
 * 用户和排查者都拿不到任何线索（调用方 `GraphCanvas` 那边看起来一切正常）。
 * 因此这里保留降级语义，但把失败打出来，并且**只打第一次**避免刷屏。
 * @param scope - 作用域名。
 * @param pos - 该作用域的坐标（画布已取整、已按条数封顶）。
 */
let quotaWarned = false
export function savePositions(scope: string, pos: ReadonlyMap<string, GridPos>): void {
  const { tables, order } = readV2()
  tables[scope] = sanitizeTable(Object.fromEntries(pos))
  // 本次写的排首位；文件里记过顺序的按记录先后；旧文件没记过 LRU 的接在后面（当最久未写）。
  const known = order.filter(s => s !== scope && s in tables)
  const rest = Object.keys(tables).filter(s => s !== scope && !known.includes(s))
  const kept = [scope, ...known, ...rest].slice(0, Math.max(1, POSITION_SCOPES_MAX))
  // 重建整个文件：被淘汰的作用域在这里真正消失（读-改-写，而不是往旧 JSON 上打补丁）
  const next: Record<string, unknown> = { [LRU_FIELD]: kept }
  for (const s of kept) next[s] = tables[s]
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(next))
  } catch (error) {
    if (!quotaWarned) {
      quotaWarned = true
      console.warn('[graph] 布局坐标无法写入 localStorage（下次进入不会原地恢复）:', error instanceof Error ? error.message : error)
    }
  }
}

/** 坐标初值的半径区间：与旧画布的坐标量级同档（几百像素），避免画布 fit 时精度被榨干。 */
const INIT_RADIUS_MIN = 60
const INIT_RADIUS_SPREAD = 240

/** id + 盐 → [0,1) 的确定性伪随机（同一 id 在任何机器、任何会话得到同一个值）。 */
function hashUnit(text: string, salt: number): number {
  let hash = 2166136261 ^ salt
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967296
}

/**
 * 单个节点的初值坐标。为什么必须是确定性的：
 *   力导向是「迭代收敛」，初值不同会收敛到不同的局部形状（整体旋转/翻转/松散度），
 *   用户会看到「同一个图谱每次打开都长不一样」；而且「同一份输入 → 同一份坐标」
 *   是把布局写成回归用例的前提（spec 直接断言两次坐标逐位相等）。
 * 为什么用 id 哈希而不是数组下标：与上游的排序/筛选顺序解耦 —— 换个排序不该换来一套初值，
 * 这也让「数组顺序不进指纹」这条成立（否则指纹说没变、初值却变了）。
 */
function initialPosition(id: string): GridPos {
  const angle = hashUnit(id, 0) * Math.PI * 2
  const radius = INIT_RADIUS_MIN + hashUnit(id, 1) * INIT_RADIUS_SPREAD
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/** 初值：历史坐标优先（用户上次调好的形状），缺哪条就用哪条的确定性初值补齐。 */
function initialPositions(nodes: readonly GNode[], saved?: Map<string, GridPos>): Map<string, GridPos> {
  const out = new Map<string, GridPos>()
  for (const node of nodes) {
    const hit = saved?.get(node.id)
    out.set(
      node.id,
      hit && Number.isFinite(hit.x) && Number.isFinite(hit.y) ? { x: hit.x, y: hit.y } : initialPosition(node.id),
    )
  }
  return out
}

/**
 * 边权归一化。上游权重是「消息量 / 共同群数」量级（1 ~ 数千），原样喂给 FA2 会让
 * 「我」的枢纽边把其余节点全吸成一条线；压到 1 ~ 4 之后强弱只体现为「拉得更紧一点」。
 */
function layoutWeight(weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  return Math.min(4, 1 + Math.log2(1 + w) / 3)
}

/** 单独展示区的列数上限（超过就换行，免得排成一条看不到头的长队）。 */
const ISOLATED_MAX_COLS = 12
/** 相邻槽位在「相切」之上再留的空隙（px）。 */
const ISOLATED_GUTTER = 6
/** 单独展示区与主簇之间的空档（按槽距的倍数）——够看出「这是另一区」，又不至于把画面撑开。 */
const ISOLATED_STRIP_GAP = 1.6

/**
 * 「一条边都没有」的节点 → 排在主簇下方的**单独展示区**（确定性网格，不参与力导向）。
 *
 * 为什么要单独安置，而不是让它们留在力导向里：
 *   力导向对无边节点的作用是**纯斥力 + 向心力**，两者的平衡点由缩放比与节点数决定 ——
 *   它们会被甩到离主簇很远的地方，彼此之间又没有任何约束，于是散成一片稀疏的点。
 *   代价是双重的：① 画面出现「一大片空白」；② `fitCamera` 按包围盒取景，**几个散点就能把
 *   整个取景框撑大**，主簇被缩成中间一小团（这才是「不紧凑」的主要来源）。
 *
 * 放进网格区之后：
 *   - 主簇只由**有结构的节点**决定形状，包围盒不再被无意义的散点撑大；
 *   - 无边节点仍然全部可见、可点、可选中（它们只是没有线，不是不该出现）；
 *   - 位置只由「节点半径 + nodeGap + 主簇包围盒」决定，**与六个力度滑杆无关** ——
 *     调力度不会让它们重新到处乱跑（「除外/单独展示的节点不受紧凑布局影响」）；
 *   - 槽距按最大半径算，所以彼此**不可能重叠**。
 *
 * 为什么用「网格区」而不是「环绕主簇的环」：环的半径得取主簇最远点，真实数据里最远点常常
 * 是 p50 的两倍多（好友网络 832 vs 357），环会被推到很远、自己造出一圈新的空白；
 * 网格区贴着主簇下沿铺开，包围盒只增加「槽距 × 行数」。
 * @param isolated - 无边节点（按图的节点顺序，决定网格里的先后）。
 * @param radiusOf - 取渲染半径（与画布同一口径）。
 * @param placed - 已经定好位的主簇坐标（用它算包围盒；空表表示主簇为空）。
 * @param nodeGap - 节点间距滑杆（间距是「疏密」参数，跟着它放大是正确的；力度滑杆不影响这里）。
 * @returns 这些节点的坐标。
 */
export function isolatedStripPositions(
  isolated: readonly GNode[],
  radiusOf: (node: GNode) => number,
  placed: ReadonlyMap<string, GridPos>,
  nodeGap: number,
): Map<string, GridPos> {
  const out = new Map<string, GridPos>()
  if (isolated.length === 0) return out
  let maxR = 1
  for (const n of isolated) maxR = Math.max(maxR, radiusOf(n))
  const pitch = maxR * 2 * Math.max(1, nodeGap) + ISOLATED_GUTTER

  let minX = 0
  let maxY = 0
  let hasBounds = false
  let cx = 0
  for (const p of placed.values()) {
    if (!hasBounds) {
      minX = p.x
      maxY = p.y
      cx = p.x
      hasBounds = true
    } else {
      if (p.x < minX) minX = p.x
      if (p.y > maxY) maxY = p.y
      cx += p.x
    }
  }
  if (hasBounds) cx /= Math.max(1, placed.size)
  const cols = Math.max(1, Math.min(ISOLATED_MAX_COLS, Math.ceil(Math.sqrt(isolated.length))))
  const startY = (hasBounds ? maxY : 0) + pitch * ISOLATED_STRIP_GAP
  // 横向以主簇中心对齐：整块看起来是「主图的附属条」，而不是贴到左边去的一块
  const startX = (hasBounds ? cx : 0) - ((cols - 1) * pitch) / 2
  isolated.forEach((node, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.set(node.id, { x: startX + col * pitch, y: startY + row * pitch })
  })
  return out
}

/** 每个节点的度数（只数一次，供「有结构 / 无结构」分组复用）。 */
function degreeOf(graph: BuiltGraph): Map<string, number> {
  const deg = new Map<string, number>()
  for (const n of graph.nodes) deg.set(n.id, 0)
  for (const e of graph.edges) {
    if (deg.has(e.source)) deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    if (deg.has(e.target)) deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  return deg
}

/** 布局任务：只带坐标与边表（结构化克隆友好，不向 Worker 传整张图与节点详情）。 */
export interface LayoutTask {
  /** 指纹原样带回：主线程靠它认领回包、丢掉过期结果。 */
  key: string
  nodes: Array<{ id: string; x: number; y: number }>
  edges: Array<{ source: string; target: string; weight: number }>
  iterations: number
  params: Record<string, number>
}

export interface LayoutPoint { id: string; x: number; y: number }

/** Worker 回包：要么带坐标，要么带失败原因（把单次失败局限在这一条请求上，不必杀掉 Worker）。 */
export interface LayoutTaskResult { key: string; points?: LayoutPoint[]; error?: string }

/**
 * 真正跑 FA2（同步、阻塞当前线程）。主线程小图与 Worker 大图都调这一个函数 ——
 * 参数、去重规则、布尔开关只有一份，两条路径不可能给出两种手感。
 * 供 graph-layout-worker.ts 复用，调用方不需要直接用它。
 */
export function assignLayout(task: LayoutTask): LayoutPoint[] {
  const out: LayoutPoint[] = []
  if (task.nodes.length === 0) return out
  const graph = new Graph()
  for (const n of task.nodes) graph.addNode(n.id, { x: n.x, y: n.y })
  for (const e of task.edges) {
    if (e.source === e.target) continue
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    // 互惠关系在 FA2 里就是同一根弹簧：两端各存一条会把权重翻倍，只保留一条
    const forward = `${e.source}|${e.target}`
    if (graph.hasEdge(forward) || graph.hasEdge(`${e.target}|${e.source}`)) continue
    graph.addEdgeWithKey(forward, e.source, e.target, { weight: e.weight })
  }
  // 布尔开关只能在这里补（fa2Settings 的签名是数字表）；用 Object.assign 而不是对象字面量，
  // 是因为数字索引签名与 ForceAtlas2Settings 的布尔字段在字面量里互不兼容。
  const settings: ForceAtlas2Settings = {}
  Object.assign(settings, task.params, {
    // 强引力：离群点被拉回，不会飞成一条线
    strongGravityMode: true,
    // 大图用四叉树近似斥力，把每轮的 O(n²) 压成 O(n log n)
    barnesHutOptimize: task.nodes.length > BARNES_HUT_MIN_NODES,
    // 间距靠缩放比来表达，不用 adjustSizes —— 那要求把每个节点的半径也搬进任务里，
    // 而半径只是外观参数，不该参与布局。
    adjustSizes: false,
  })
  forceAtlas2.assign(graph, { iterations: task.iterations, settings })
  graph.forEachNode((id, attrs) => { out.push({ id, x: attrs.x, y: attrs.y }) })
  return out
}

/* ── Worker 调度 ──────────────────────────────────────────────────────
 * 大图必须离开主线程：FA2 是「迭代 × n log n」，500 节点 90 轮会把主线程钉住几百毫秒，
 * 拖动与缩放全部掉帧。通讯只传坐标与边表（见 LayoutTask）。
 */

/** 在飞的 Worker 请求：按指纹登记，回包时用它认领；对不上就是过期结果，直接丢。 */
const workerWaiters = new Map<string, { resolve: (points: LayoutPoint[]) => void; reject: (error: unknown) => void }>()
/** 同一指纹的并发调用共享同一次计算（拖滑块会连发好几个相同指纹的请求）。 */
const pendingLayouts = new Map<string, Promise<LayoutOutcome>>()
/** dispose 的失败信号：这不是「Worker 挂了」，卸载路径上不该再退回主线程重算。 */
const ABORTED = Symbol('graph-layout-aborted')
let layoutWorker: Worker | null = null

function spawnWorker(): Worker | null {
  // node / SSR（以及 Worker 自己）里没有 Worker 构造器 —— 直接走主线程
  if (typeof Worker === 'undefined') return null
  // 非 http(s) 源（本应用的真实情况：main.js 用 loadFile 加载，页面是 file:// 源）里
  // Chrome 拒绝构造 Worker，并在控制台留下一条错误。既然结果必然是回退，就**不要发起尝试** ——
  // 否则每次打开面板都会多一条无意义的控制台报错，排查真问题时会被它干扰。
  // 走开发服务器（http://localhost）时这条判断放行，Worker 路径照常生效。
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null
  try {
    return new Worker(new URL('./graph-layout-worker.ts', import.meta.url), { type: 'module' })
  } catch {
    // 起不来就静默回退主线程，布局照样有（打包路径、受限协议、Worker 被禁用等）
    return null
  }
}

/** Worker 出任何错：让在飞的请求立刻收到失败（调用方随即回退主线程），并丢掉实例下次重建。 */
function failWorker(error: unknown): void {
  for (const [, waiter] of workerWaiters) waiter.reject(error)
  workerWaiters.clear()
  layoutWorker?.terminate()
  layoutWorker = null
}

function ensureWorker(): Worker | null {
  if (layoutWorker) return layoutWorker
  const worker = spawnWorker()
  if (!worker) return null
  worker.onmessage = (event: MessageEvent<LayoutTaskResult>) => {
    const message = event.data
    const waiter = message ? workerWaiters.get(message.key) : undefined
    // 认不出指纹 = 上一张图 / 上一组力度留下的回包（改参数连发时很常见）→ 丢弃
    if (!waiter) return
    workerWaiters.delete(message.key)
    if (message.error !== undefined) waiter.reject(new Error(message.error))
    else waiter.resolve(message.points ?? [])
  }
  worker.onerror = () => { failWorker(new Error('graph layout worker failed')) }
  worker.onmessageerror = () => { failWorker(new Error('graph layout worker message error')) }
  layoutWorker = worker
  return worker
}

function runInWorker(task: LayoutTask): Promise<LayoutPoint[]> {
  const worker = ensureWorker()
  if (!worker) return Promise.reject(new Error('graph layout worker unavailable'))
  return new Promise<LayoutPoint[]>((resolve, reject) => {
    workerWaiters.set(task.key, { resolve, reject })
    try {
      worker.postMessage(task)
    } catch (error) {
      // 结构化克隆失败之类：撤回登记，交给调用方回退
      workerWaiters.delete(task.key)
      reject(error)
    }
  })
}

/**
 * 卸载时回收 Worker。在飞的布局以「取消」收场：既不退回主线程重算（那正是 Worker 要避免的
 * 阻塞），也不会把 Promise 永远悬着 —— 调用方拿到的是一份初值坐标。
 */
export function disposeLayoutWorker(): void {
  layoutWorker?.terminate()
  layoutWorker = null
  for (const [, waiter] of workerWaiters) waiter.reject(ABORTED)
  workerWaiters.clear()
}

/** 结果的来源：命中缓存 / Worker 算的 / 主线程算的（供调用方打点，不影响它怎么用坐标）。 */
export interface LayoutResult {
  positions: Map<string, GridPos>
  engine: 'cache' | 'worker' | 'main'
  elapsedMs: number
}

interface LayoutOutcome {
  result: LayoutResult
  /** 是否真的收敛过：被 dispose 取消的那次给的是初值，绝不能登记成缓存。 */
  converged: boolean
}

/** 计时。performance 缺失时退回 Date（精度差一档，不影响这个用途）。 */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** 每个调用方拿独立副本：画布会直接改这些坐标（拖拽），不能把缓存改坏。 */
function copyOf(positions: Map<string, GridPos>): Map<string, GridPos> {
  const out = new Map<string, GridPos>()
  for (const [id, pos] of positions) out.set(id, { x: pos.x, y: pos.y })
  return out
}

function toPositions(points: readonly LayoutPoint[]): Map<string, GridPos> {
  const out = new Map<string, GridPos>()
  for (const point of points) out.set(point.id, { x: point.x, y: point.y })
  return out
}

async function computeLayout(
  input: { graph: BuiltGraph; settings: GraphSettings; saved?: Map<string, GridPos> },
  key: string,
): Promise<LayoutOutcome> {
  const startedAt = nowMs()
  const all = input.graph.nodes
  if (all.length === 0) {
    // 空图没有可收敛的东西；仍然登记缓存，免得空态里反复走进来
    return { result: { positions: new Map(), engine: 'main', elapsedMs: nowMs() - startedAt }, converged: true }
  }
  // 无边节点不参与力导向（原因见 isolatedStripPositions）：它们没有弹簧可收敛，
  // 留在仿真里只会被斥力甩远，白占包围盒。
  const deg = degreeOf(input.graph)
  const linked = all.filter(n => (deg.get(n.id) ?? 0) > 0)
  const isolated = all.filter(n => (deg.get(n.id) ?? 0) === 0)
  const init = initialPositions(linked, input.saved)
  const task: LayoutTask = {
    key,
    nodes: linked.map((n) => {
      const pos = init.get(n.id)
      return { id: n.id, x: pos?.x ?? 0, y: pos?.y ?? 0 }
    }),
    edges: input.graph.edges.map(e => ({ source: e.source, target: e.target, weight: layoutWeight(e.weight) })),
    iterations: layoutIterations(linked.length),
    params: fa2Settings(input.settings, linked.length),
  }
  const radiusOf = (n: GNode): number => nodeRadius(n, input.settings, all.length)
  /** 主簇坐标 + 单独展示区，合成完整坐标表。 */
  const withIsolated = (core: ReadonlyMap<string, GridPos>): Map<string, GridPos> => {
    const out = new Map<string, GridPos>(core)
    if (isolated.length === 0) return out
    for (const [id, p] of isolatedStripPositions(isolated, radiusOf, core, input.settings.nodeGap)) out.set(id, p)
    return out
  }
  if (linked.length >= WORKER_NODE_THRESHOLD) {
    try {
      const points = await runInWorker(task)
      return {
        result: { positions: withIsolated(toPositions(points)), engine: 'worker', elapsedMs: nowMs() - startedAt },
        converged: true,
      }
    } catch (error) {
      if (error === ABORTED) {
        // 取消也要带上单独展示区：否则这些节点没有坐标，画布既画不出也点不中
        return {
          result: { positions: withIsolated(init), engine: 'main', elapsedMs: nowMs() - startedAt },
          converged: false,
        }
      }
      // Worker 起不来 / 脚本加载失败（打包路径、受限协议）→ 主线程兜底：慢，总好过没有布局
    }
  }
  return {
    result: { positions: withIsolated(linked.length > 0 ? toPositions(assignLayout(task)) : new Map()), engine: 'main', elapsedMs: nowMs() - startedAt },
    converged: true,
  }
}

/**
 * 计算（或复用）一张图的布局坐标。
 * @param input.graph - 已构建的图；只有 id / 坐标 / 边表进 Worker，节点详情留在主线程。
 * @param input.settings - 图谱设置；只有六个力度参数参与布局，其余参数只影响外观。
 * @param input.saved - 历史坐标：有就用它当收敛初值，没有就用确定性初值。
 * @param input.fresh - 忽略 `saved` 与缓存、从确定性初值重算（面板的「重新布局」）。
 *   为什么需要它：本布局是确定性的，而 `saved` 就是上一次的结果 —— 不做这一步的话
 *   「重新布局」只会把当前坐标当热启动再收敛一次，收敛到同一个极小值，**画面上什么都不会变**，
 *   成了一个按下去没反应的按钮。忽略 `saved` 才得到「另一套排布」；而因为它确定性，
 *   同一个图连按两次结果一致（不是随机抖动）。
 * @returns 坐标 + 来源（cache / worker / main）+ 耗时。
 *
 * 缓存只留最后一张图（单条）。既省内存，也保证「换走再换回来」必然重算 —— 那条重算路径
 * 正是确定性初值的观测点（spec 用它断言两次坐标逐位相等）。
 */
export async function runLayout(input: {
  graph: BuiltGraph
  settings: GraphSettings
  saved?: Map<string, GridPos>
  fresh?: boolean
}): Promise<LayoutResult> {
  const startedAt = nowMs()
  const key = graphDataKey(input.graph, input.settings)
  if (!input.fresh && cachedPositions && cachedKey === key) {
    return { positions: copyOf(cachedPositions), engine: 'cache', elapsedMs: nowMs() - startedAt }
  }
  // fresh 请求不参与「同指纹共享」：它要的正是与缓存/在飞结果不同的那一次计算
  if (!input.fresh) {
    const shared = pendingLayouts.get(key)
    if (shared) {
      const outcome = await shared
      return {
        ...outcome.result,
        positions: copyOf(outcome.result.positions),
        elapsedMs: nowMs() - startedAt,
      }
    }
  }
  const pending = computeLayout(input.fresh === true ? { ...input, saved: undefined } : input, key)
  pendingLayouts.set(key, pending)
  try {
    const outcome = await pending
    if (outcome.converged) {
      cachedKey = key
      cachedPositions = outcome.result.positions
    }
    return { ...outcome.result, positions: copyOf(outcome.result.positions) }
  } finally {
    pendingLayouts.delete(key)
  }
}

let cachedKey = ''
let cachedPositions: Map<string, GridPos> | null = null
