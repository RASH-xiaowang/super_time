/**
 * `graph-canvas.ts` 的「几何与布局：连边挑选、标签候选、揭示计划、中位数/间距、碰撞松弛」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module graph-canvas-geometry
 */

import { DEFAULT_GRAPH_SETTINGS, communityColor, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { edgeBudget } from './graph-budget.ts'
import { Camera, Point, ViewSize } from './graph-canvas-theme.ts'

/**
 * 连通性骨架：每个「有边的节点」保留它最强的那一条关联边。
 *
 * 为什么必须有这一层：预算原本只按 kind 分桶，桶内按权重降序截断 —— 于是**度数低的节点会成片
 * 失去唯一的连线**。真机实测（251 节点的好友网络，998 条边）：预算 226，250 条「我→对方」的
 * 辐条被截到 113 条，剩下 **137 个节点在画面上没有任何连线** —— 它们在全量边里度数 ≥ 1，
 * 只是那条边没被画出来。用户看到的就是「部分节点缺少连线」。
 *
 * 骨架是结构而不是装饰：删掉一条「我→对方」的辐条，等于把一个真实存在的人画成了局外人。
 * 因此骨架不参与预算竞争（见 edgeBudget 的 backbone 参数），预算只约束骨架之外的边。
 *
 * 为什么选「每个节点一条最强边」而不是「保留全部亲密度边」：后者只对社交图谱这一种模式成立，
 * 知识图谱的 [[链接]]、群组网络的共同成员边没有「辐条」可依；而「每个节点至少一条」是任何图上
 * 都成立的连通性下界，且条数天然 ≤ 节点数（不会把预算顶穿）。
 * @param edges - 全量边。
 * @returns 要保留的边下标集合（每个有边的节点各贡献一条）。
 */
export function connectivityBackbone(edges: readonly GEdge[]): Set<number> {
  const best = new Map<string, { idx: number; weight: number }>()
  edges.forEach((e, i) => {
    for (const id of [e.source, e.target]) {
      const cur = best.get(id)
      if (!cur || e.weight > cur.weight) best.set(id, { idx: i, weight: e.weight })
    }
  })
  const out = new Set<number>()
  for (const v of best.values()) out.add(v.idx)
  return out
}

/**
 * 从全量边里挑出这一帧要画的边（**不能**直接 `edges.slice(0, budget)`）。
 *
 * `buildGraph` 返回的边是「亲密度边在前、共同群边在后」，而亲密度边是「我 → 每个节点」
 * 各一条（好友网络 250 条）。当它自己就超过预算（251 节点的预算是 226）时，前缀切片会把
 * 预算**全部吃在辐条上**，好友↔好友的互惠边一条都画不出来 —— 这不是「看起来像」，是真机
 * 按描边色数出来的：好友网络 226 条线全是亲密度边、共同群边 0 条；群组网络因为亲密度边只
 * 有 60 条，反而剩 120 条给互惠边，于是两个模式看起来完全不同（用户正是这么发现的）。
 *
 * 改前的 ECharts 版也是同样的 `slice(0, maxLinks)` + 同样的 buildGraph 排序，所以这是
 * 一直在的缺陷，不是这次重写引入的。
 *
 * 分三层：
 *   ① **骨架**（`connectivityBackbone`）无条件保留 —— 保证不会出现「有边却没画」的孤点；
 *   ② 剩下的边按 kind 分桶、每桶先按权重取保底份额（桶数均分）；
 *   ③ 剩余预算按桶大小回填。
 * ②③ 保证「我↔对方」与「对方↔对方」两类边都能出现，且各自只保留权重最高的那部分。
 * @param edges - 全量边（按 buildGraph 的顺序）。
 * @param nodes - **渲染中的节点**（决定预算，也是「谁不能成为孤点」的权威口径）。
 *   刻意收节点表而不是个数：只出现在边表里的 id 不会被画出来，为它们保底纯属浪费预算。
 * @returns 实际要画的边（保持输入顺序，绘制顺序稳定）。
 */
export function selectEdges(edges: readonly GEdge[], nodes: readonly GNode[]): GEdge[] {
  const backbone = connectivityBackbone(edges)
  const budget = edgeBudget(nodes.length, edges.length, backbone.size)
  if (edges.length <= budget) return [...edges]
  const byKind = new Map<GEdge['kind'], number[]>()
  edges.forEach((e, i) => {
    // 骨架已占的位不再进桶：否则会被「桶内按权重降序」再挑一次，白占一份份额
    if (backbone.has(i)) return
    const arr = byKind.get(e.kind)
    if (arr) arr.push(i)
    else byKind.set(e.kind, [i])
  })
  // 各桶按权重降序：桶内取前 share 条就是该类里最强的那些边
  for (const arr of byKind.values()) arr.sort((a, b) => (edges[b]?.weight ?? 0) - (edges[a]?.weight ?? 0))
  const kinds = [...byKind.keys()]
  const chosen = new Set<number>(backbone)
  if (kinds.length === 0) return edges.filter((_, i) => chosen.has(i))
  const share = Math.max(1, Math.floor(Math.max(0, budget - chosen.size) / kinds.length))
  for (const k of kinds) {
    const arr = byKind.get(k)
    if (!arr) continue
    for (let i = 0; i < Math.min(share, arr.length); i++) chosen.add(arr[i] as number)
  }
  // 保底没用完的份额回填：桶大的优先（亲密度边通常最多，它会吃掉剩余预算）
  let left = budget - chosen.size
  if (left > 0) {
    const order = kinds.sort((a, b) => (byKind.get(b)?.length ?? 0) - (byKind.get(a)?.length ?? 0))
    for (const k of order) {
      if (left <= 0) break
      const arr = byKind.get(k)
      if (!arr) continue
      for (const i of arr) {
        if (left <= 0) break
        if (!chosen.has(i)) { chosen.add(i); left-- }
      }
    }
  }
  return edges.filter((_, i) => chosen.has(i))
}

/**
 * 标签候选数上限（`showLabels` 打开时）。
 *
 * 真正画得下多少由后面的贪心避重叠自然收敛，这里只需要一个防 O(n²) 的上界：
 * 用户要「全部标签」时若按小上限截断，会在节点多的图上出现**开关按下去没多画几个**的情况
 * （真机实测：260 节点的人脉图，关掉开关时的候选集本就接近上限，截断后就只多画了几个）。
 */
export const MAX_LABELS = 600

/** 标签可见的最小缩放：再小字就糊成一团噪点，不如不画。 */
export const LABEL_MIN_ZOOM = 0.32

/**
 * 标签候选：按优先级排序 —— 悬停/选中/固定的排最前（它们可能权重很低但正是用户当下在看的），
 * 其余按权重降序。
 *
 * 规则：**开关即权威** —— `showLabels` 关闭时一个自动标签都不画，打开时全部参与（受上限截断）。
 * 例外只有三类**交互必需**的：悬停、选中、固定（「我正看着它/我标记过它」，与开关无关）。
 *
 * 这里曾经多一条「枢纽常显」（权重 ≥ 最大值 15% 的节点无条件带标签），来自 graphify 的静态导出
 * 约定 —— 那张图没法悬停，所以只能把重要节点的名字印上去。但交互画布上悬停就能看到名字，
 * 于是表现为「关掉「全部标签」后还有四十来个节点带标签」，与开关的字面语义直接冲突。
 * （改前的 ECharts 版也有类似的一条：权重前 12 名 + 「我」常显。所以这个歧义是老问题，
 *   只是我把门槛从「前 12 名」换成了「15%」，把常显数量从 13 个放大到四十来个。）
 *
 * 为什么抽成函数：屏幕绘制与 SVG 导出必须挑**同一批**标签，否则导出的图与所见不一致。
 * @param nodes - 节点。
 * @param settings - 设置（取 `showLabels`）。
 * @param view - 悬停/选中/固定。
 * @returns 有序的候选节点。
 */
export function labelCandidates(
  nodes: readonly GNode[],
  settings: GraphSettings,
  view: { hoverNodeId: string | null; selectedId: string | null; pinnedIds: ReadonlySet<string> },
): GNode[] {
  const priority: GNode[] = []
  const rest: GNode[] = []
  for (const n of nodes) {
    if (n.id === view.hoverNodeId || n.id === view.selectedId || view.pinnedIds.has(n.id)) {
      priority.push(n)
      continue
    }
    if (settings.showLabels) rest.push(n)
  }
  rest.sort((a, b) => b.weight - a.weight)
  return [...priority, ...rest.slice(0, Math.max(0, MAX_LABELS - priority.length))]
}

/** 无 `measureText` 时（SVG 导出）估算文本宽度：中日韩按满宽、其余按 0.55 宽。 */
export function estimateTextWidth(text: string, sizePx: number): number {
  let units = 0
  for (const ch of text) units += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55
  return units * sizePx
}

/** 头像资源：原始 data URL（SVG 导出用）+ 已裁圆的 sprite（画布用，避免逐帧 clip）。 */
export interface AvatarAsset {
  url: string
  sprite: HTMLCanvasElement | null
}

/** 头像 sprite 的像素直径：128 足够 2× 缩放下不糊，又不至于占内存。 */
export const SPRITE_SIZE = 128

/**
 * 把一张头像位图裁成圆形 sprite（画布绘制用）。
 *
 * 为什么要预裁：`ctx.clip()` 是逐次绘制都要重建路径的有状态操作，250 个节点每帧 250 次
 * save/clip/restore 是可观开销；预裁一次成圆形位图后，逐帧只是一次 `drawImage`。
 * @param img - 已解码的头像。
 * @returns 圆形 sprite；拿不到 2d 上下文时返回 `null`。
 */
export function circleSprite(img: HTMLImageElement): HTMLCanvasElement | null {
  const size = SPRITE_SIZE
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.clip()
  // cover 裁剪：短边铺满，长边居中切掉，头像不变形
  const scale = Math.max(size / (img.naturalWidth || size), size / (img.naturalHeight || size))
  const w = (img.naturalWidth || size) * scale
  const h = (img.naturalHeight || size) * scale
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
  return c
}

/**
 * 解码一张头像并裁圆，结果缓存到 `assets` 里。
 *
 * 远端 URL（后端批量接口的第三级兜底）必须带 `crossOrigin='anonymous'` 请求：
 * 只有拿到 CORS 头，画进 canvas 才不会把它标记为 tainted —— 否则 PNG 导出在
 * `toDataURL()` 处抛 SecurityError（整张图导不出来）。拿不到 CORS 头时浏览器直接
 * `onerror`，退回「社区色 + 首字」，不会出现半张坏图。wx.qlogo.cn 实测带 CORS 头。
 * @param username - 头像主人（缓存键）。
 * @param url - data URL 或 https URL。
 * @param assets - 资源表（就地写入）。
 * @returns 解码完成的 Promise（失败时写入无 sprite 的记录，避免反复重试）。
 */
export function decodeAvatar(username: string, url: string, assets: Map<string, AvatarAsset>): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image()
    if (!url.startsWith('data:')) image.crossOrigin = 'anonymous'
    image.onload = () => {
      assets.set(username, { url, sprite: circleSprite(image) })
      resolve()
    }
    image.onerror = () => {
      assets.set(username, { url: '', sprite: null })
      resolve()
    }
    image.src = url
  })
}

/** 出现动画的时序参数（ms）。 */
export interface RevealTiming {
  /** 相邻「跳」之间的间隔：图结构上距起点更远的一层整体后移。 */
  layerMs: number
  /** 同层内相邻节点的错开量 —— 「一个个衍生」的观感就来自它。 */
  staggerMs: number
  /** 单个节点从透明到完全显现的时长。 */
  fadeMs: number
}

/**
 * 默认时序：250 个节点约 7 秒放完。
 *
 * stagger 为什么取 26ms：再小（<20ms）同时淡入的节点超过一打，看上去是一「片」一起亮，
 * 失去「一个个」的感觉；再大（>40ms）250 个节点要 10 秒以上，用户会以为按钮没反应。
 * fade 取 240ms 略大于 stagger，保证任何时刻都有一小簇在渐变，而不是硬切换。
 */
export const DEFAULT_REVEAL: RevealTiming = { layerMs: 260, staggerMs: 26, fadeMs: 240 }

/**
 * 出现动画里节点的起始半径比例（0.35 → 1）。
 *
 * 不能取 0：从「一个点」长出来看不出是头像；也不能取 0.7 以上，那样只有淡入没有「生长」。
 */
export const REVEAL_MIN_SCALE = 0.35

/** 出现动画的时间表。 */
export interface RevealPlan {
  /** 节点 id → 开始淡入的时刻（相对动画起点，ms）。 */
  delayOf: ReadonlyMap<string, number>
  /** 出现顺序（BFS 层序；层内按到起点的几何距离升序）。 */
  order: readonly string[]
  /** 从第一个节点出现到最后一个节点完全显现的总时长（ms）。 */
  totalMs: number
  timing: RevealTiming
}

/**
 * 排一张「由一个节点衍生出全部节点」的时间表。
 *
 * 顺序的取法：
 *   ① **层用 BFS** —— 先出现与起点直接相连的，再出现二跳、三跳的，这是「衍生」的结构依据；
 *   ② **层内按到起点的几何距离升序** —— 同层节点在图上本来是环形摊开的，按距离排会让画面
 *      一圈圈向外扩散，比按权重排更像「从一个点长出来」；
 *   ③ **连不通的孤岛**接在最后一层之后 —— 否则它们永远轮不到，动画放完图还是不完整的。
 *
 * 为什么把时间表单独做成纯函数：paint 每帧都要读一次「现在多亮」，而「什么时候该亮」
 * 是可以在没有 DOM 的环境里锁住的行为（见 graph-canvas.spec.ts）。
 * @param nodes - 图节点。
 * @param edges - 图边。
 * @param startId - 起始节点 id（不存在时退回权重最高的节点，知识图谱里没有「我」）。
 * @param positions - 节点坐标（算同层内的距离顺序用；缺省则回退按权重降序）。
 * @param timing - 时序参数。
 * @returns 时间表；空图返回 `totalMs: 0` 的空表（调用方据此跳过动画）。
 */
export function buildRevealPlan(
  nodes: readonly GNode[],
  edges: readonly GEdge[],
  startId: string,
  positions?: ReadonlyMap<string, Point>,
  timing: RevealTiming = DEFAULT_REVEAL,
): RevealPlan {
  const delayOf = new Map<string, number>()
  const order: string[] = []
  if (nodes.length === 0) return { delayOf, order, totalMs: 0, timing }

  const byId = new Map(nodes.map(n => [n.id, n]))
  const start = byId.has(startId)
    ? startId
    : [...nodes].sort((a, b) => b.weight - a.weight)[0]?.id ?? ''
  if (!start) return { delayOf, order, totalMs: 0, timing }

  // 无向邻接表：图上的关系是互惠的，出现顺序不该区分方向
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    if (e.source === e.target) continue
    adj.get(e.source)?.push(e.target)
    adj.get(e.target)?.push(e.source)
  }

  const origin = positions?.get(start) ?? { x: 0, y: 0 }
  /** 到起点的几何距离；拿不到坐标时返回 0（同层内退化成按权重排）。 */
  const distTo = (id: string): number => {
    const p = positions?.get(id)
    return p ? Math.hypot(p.x - origin.x, p.y - origin.y) : 0
  }
  const byOrder = (a: string, b: string): number =>
    distTo(a) - distTo(b)
    || (byId.get(b)?.weight ?? 0) - (byId.get(a)?.weight ?? 0)
    || a.localeCompare(b)

  let elapsed = 0
  let maxEnd = 0
  const assign = (ids: readonly string[]): void => {
    ids.forEach((id, i) => {
      const delay = elapsed + i * timing.staggerMs
      delayOf.set(id, delay)
      order.push(id)
      if (delay + timing.fadeMs > maxEnd) maxEnd = delay + timing.fadeMs
    })
    elapsed += ids.length * timing.staggerMs + timing.layerMs
  }

  const seen = new Set<string>([start])
  assign([start])
  let frontier: string[] = [start]
  while (frontier.length > 0) {
    const layer: string[] = []
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb)) continue
        seen.add(nb)
        layer.push(nb)
      }
    }
    if (layer.length === 0) break
    layer.sort(byOrder)
    assign(layer)
    frontier = layer
  }
  const orphans = nodes.filter(n => !seen.has(n.id)).map(n => n.id).sort(byOrder)
  if (orphans.length > 0) assign(orphans)

  return { delayOf, order, totalMs: maxEnd, timing }
}

/**
 * 某节点在 `elapsedMs` 时刻的显现进度（0 = 还没出现，1 = 完全显现）。
 *
 * 缓动用 easeOutCubic：起手快、收尾稳，节点的「生长」不会在末尾拖出一条犹豫的尾巴。
 * @param plan - 时间表。
 * @param id - 节点 id。
 * @param elapsedMs - 距动画起点的毫秒数。
 * @returns 0..1（不在时间表里的节点按 1 —— 动画进行中新加的节点不该被藏起来）。
 */
export function revealProgressAt(plan: RevealPlan, id: string, elapsedMs: number): number {
  const delay = plan.delayOf.get(id)
  if (delay === undefined) return 1
  const t = (elapsedMs - delay) / plan.timing.fadeMs
  if (t <= 0) return 0
  if (t >= 1) return 1
  return 1 - Math.pow(1 - t, 3)
}

/**
 * 一次性算出全部节点的当前进度（paint 每帧调一次）。
 * @param plan - 时间表。
 * @param elapsedMs - 距动画起点的毫秒数。
 * @returns 节点 id → 进度 0..1。
 */
export function revealProgressMap(plan: RevealPlan, elapsedMs: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of plan.order) out.set(id, revealProgressAt(plan, id, elapsedMs))
  return out
}

/** 绘制场景：一次 `paint` 需要的全部输入。 */
export interface Scene {
  nodes: readonly GNode[]
  edges: readonly GEdge[]
  positions: ReadonlyMap<string, Point>
  radii: ReadonlyMap<string, number>
  /** 节点 id → 头像 sprite（缺失则画社区色圆盘 + 首字） */
  sprites: ReadonlyMap<string, HTMLCanvasElement>
  /** avatar 所有者 username（self 用真实 wxid），用于取 sprite */
  avatarIdOf: (node: GNode) => string
  camera: Camera
  size: ViewSize
  dark: boolean
  settings: GraphSettings
  selectedId: string | null
  hoverNodeId: string | null
  hoverNeighbours: ReadonlySet<string> | null
  pinnedIds: ReadonlySet<string>
  focusCommunity: number | null
  hoverCommunity: number | null
  /** 只画这些边（已按预算截断）；缺省画全部 */
  edgesToDraw?: readonly GEdge[] | undefined
  /**
   * 出现动画：节点 id → 当前显现进度 0..1。
   *
   * `null`（或缺省）表示没有动画，全部节点按 1 画 —— **导出路径（SVG / PNG / 海报）
   * 必须走这一支**：成品图里不能有「还没长出来」的节点。
   */
  reveal?: ReadonlyMap<string, number> | null
}

export const FONT_STACK = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'

/** 标签字体：11px 与改前一致。 */
export const LABEL_FONT = `500 11px ${FONT_STACK}`

/** 节点在屏幕上的半径（含相机缩放），不小于 3px —— 缩到极小也得看得见一个点。 */
export function screenRadius(r: number, k: number): number {
  return Math.max(3, r * k)
}
