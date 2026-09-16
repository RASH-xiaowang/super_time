/**
 * 图谱绘制层：把一张图（节点 + 边 + 坐标）画到 `CanvasRenderingContext2D` 上，并导出为矢量 SVG。
 *
 * 为什么自己画而不是继续用 ECharts `series.graph`：
 *   ① 节点要显示**头像**。ECharts 的 `symbol:'image://'` 画的是方图，只能先把每张头像重新编码成
 *      「圆形裁剪 + PNG data URL」再喂给它 —— 等于为了一个圆形多存/多解一份位图，而且换尺寸就得重编；
 *      自己画则是 `clip()` 一次，缩放、描边环、选中光环都是原生操作。
 *   ② 悬停高亮、社区聚焦淡出、标签防重叠这些局部状态，用 ECharts 只能整图 `setOption` 再靠它内部
 *      合并，每帧要重建整份数据项；这里是「读一遍数组、画一遍」，代价与状态数量无关。
 *   ③ SVG 导出：ECharts 得另起一个 SVGRenderer 实例重画一遍；这里同一份 `Scene` 直接序列化成
 *      矢量（边是 `<line>`、环是 `<circle>`、头像夹 `<clipPath>`），导出与屏幕所见同源，不会走样。
 *
 * 视觉规格取自两个参考实现：图底/连线/枢纽标签策略来自 graphify 的 vis-network 导出
 * （`graphify/exporters/html.py`），头像圆盘 + 社区色描边环、悬停把非邻居混色淡出、标签带
 * 描边光晕来自 llm_wiki 的 sigma 视图与 tree 视图（`tree_html.py` 的 `paint-order: stroke fill`）。
 *
 * 本模块不 import react，也不碰 DOM 之外的东西（只接 ctx + 数据）：相机数学、命中测试、
 * 尺寸映射、标签排布都是可直接单测的纯函数。
 */
import { DEFAULT_GRAPH_SETTINGS, communityColor, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { readableOn } from '../utils/theme-color.ts'

/** 相机：`(cam.x, cam.y)` 是画布正中对应的世界坐标，`cam.k` 是缩放。 */
export interface Camera {
  x: number
  y: number
  k: number
}

export interface ViewSize {
  w: number
  h: number
}

/** 平面点。 */
export interface Point {
  x: number
  y: number
}

/** 一套主题下的全部绘制配色（深/浅两套，各自在代码里定死，不依赖 CSS 变量）。 */
export interface GraphTheme {
  /** 导出时的底色（屏幕上看不到：屏上是 CSS 画的网格） */
  bg: string
  /** 连线 */
  edgeCommon: string
  edgeIntimacy: string
  edgeWiki: string
  edgeSource: string
  /** 无头像时的兜底圆盘 */
  disc: string
  /** 节点描边环（社区色之外的默认环） */
  ring: string
  ringDim: string
  /** 悬停：参考 graphify 的 hover 规格（填充变白、描边保持社区色） */
  ringHover: string
  /** 选中：主题强调色 */
  ringSelected: string
  selectGlow: string
  /** 固定节点：虚线环 */
  ringPinned: string
  /** 未创建笔记（stub）的虚线环 */
  ringStub: string
  /** 标签与其描边光晕 */
  label: string
  labelHalo: string
  /** 悬停气泡 */
  bubbleBg: string
  bubbleBorder: string
  bubbleText: string
  bubbleSub: string
}

/** 深/浅两套主题。数值来自参考实现的深色规格（#0f0f1a 底 / 灰蓝连线）+ 本面板既有的浅色档。 */
export function graphTheme(dark: boolean): GraphTheme {
  return dark
    ? {
        bg: '#0a1025',
        edgeCommon: 'rgba(148,163,184,0.42)',
        edgeIntimacy: 'rgba(86,170,240,0.66)',
        edgeWiki: 'rgba(169,155,255,0.62)',
        edgeSource: 'rgba(120,200,180,0.5)',
        disc: '#2a3a4a',
        ring: 'rgba(140,150,170,0.6)',
        ringDim: 'rgba(90,100,120,0.45)',
        ringHover: '#ffffff',
        ringSelected: '#22d3ee',
        selectGlow: 'rgba(34,211,238,0.35)',
        ringPinned: 'rgba(250,204,21,0.85)',
        ringStub: 'rgba(150,160,180,0.9)',
        label: 'rgba(232,240,250,0.95)',
        labelHalo: 'rgba(6,10,22,0.9)',
        bubbleBg: 'rgba(16,22,38,0.94)',
        bubbleBorder: 'rgba(140,170,220,0.35)',
        bubbleText: '#e8eef7',
        bubbleSub: '#8aa0c0',
      }
    : {
        bg: '#fafafa',
        edgeCommon: 'rgba(120,130,145,0.5)',
        edgeIntimacy: 'rgba(44,130,210,0.66)',
        edgeWiki: 'rgba(109,91,208,0.6)',
        edgeSource: 'rgba(60,150,130,0.5)',
        disc: '#e2e6ec',
        ring: 'rgba(90,100,115,0.5)',
        ringDim: 'rgba(140,150,165,0.4)',
        ringHover: '#ffffff',
        ringSelected: '#0891b2',
        selectGlow: 'rgba(8,145,178,0.3)',
        ringPinned: 'rgba(202,138,4,0.9)',
        ringStub: 'rgba(110,120,135,0.9)',
        label: 'rgba(28,38,50,0.95)',
        labelHalo: 'rgba(255,255,255,0.92)',
        bubbleBg: 'rgba(255,255,255,0.96)',
        bubbleBorder: 'rgba(28,38,50,0.16)',
        bubbleText: '#1b2233',
        bubbleSub: '#6b7594',
      }
}

/** 节点数 → 头像符号直径上限（节点越多越小，减少重叠）。与改前 ECharts 版逐档一致。 */
export function sizeCapFor(nodeCount: number): number {
  return nodeCount <= 120 ? 60 : nodeCount <= 300 ? 44 : nodeCount <= 800 ? 34 : nodeCount <= 2000 ? 26 : 22
}

/**
 * 节点渲染半径（px）：模型给的「基础半径 × 外观缩放」，再夹进 [8, sizeCap/2]。
 *
 * 口径与改前 ECharts 版逐字一致（`max(8, radius*nodeScale)` 后 `min(sizeCap, max(16, r*2))`），
 * 保持各档 `nodeScale` 下节点大小的相对关系不变 —— 这层手感是用户调过的，不该在这次重写里漂移。
 * @param node - 节点。
 * @param settings - 图谱设置（取 `nodeScale`）。
 * @param nodeCount - 节点总数（决定上限）。
 * @returns 半径（px）。
 */
export function nodeRadius(node: GNode, settings: GraphSettings, nodeCount: number): number {
  const base = Math.max(8, node.radius * settings.nodeScale)
  return Math.min(sizeCapFor(nodeCount) / 2, Math.max(8, base))
}

/**
 * 头像预算：值得去拉头像的节点数上限。
 *
 * 改前是「权重最高的 60 个」（每个节点一次 `apiGetAvatar`，并发 6）；换成批量接口
 * （一次 RPC 拿到全部）之后预算放大到「小图全覆盖、大图取前 N」。
 *
 * 上限为什么是 320 而不是原来的 240：默认「节点上限」是 250，而 240 的预算意味着
 * **默认配置下就有 10 个节点永远拿不到头像** —— 真机上就是「有几个是字母」（实测
 * 251 个节点只画出 240 个头像）。上限仍然要留：节点上限能拉到 2000+，全量请求是
 * 20MB 级 IPC 载荷加几百个远端请求；320 以内约 3MB，仍然轻。
 * @param nodeCount - 节点总数。
 * @returns 头像节点数上限。
 */
export function avatarBudget(nodeCount: number): number {
  return Math.min(nodeCount, 320)
}

/** 节点是否属于「人/群」这一族（只有它们有头像）；笔记与未创建笔记是几何符号。 */
export function hasAvatar(node: GNode): boolean {
  return node.kind !== 'note' && node.kind !== 'stub' && node.stub !== true
}

/**
 * 值得去请求头像的节点：**自身永远优先**，其余按权重降序，最后按预算截断。
 *
 * 为什么自身要插队：`self` 的权重恒为 0（它没有消息量），在「按权重降序」里排最后 ——
 * 预算一旦被好友吃满（250 个节点的图取前 240），图上最中心的「我」就成了唯一没有头像的
 * 节点，真机实测如此。它的头像在本地是有的（head_image.db 命中），纯粹是被截掉的。
 * @param nodes - 图节点。
 * @param budget - 最多请求多少个。
 * @returns 待请求节点（顺序：自身在前，其余按权重降序）。
 */
export function avatarCandidates(nodes: readonly GNode[], budget: number): GNode[] {
  const eligible = nodes.filter(hasAvatar)
  const self = eligible.filter(n => n.kind === 'self')
  const rest = eligible.filter(n => n.kind !== 'self').sort((a, b) => b.weight - a.weight)
  return [...self, ...rest].slice(0, Math.max(0, budget))
}

/** 世界坐标 → 屏幕坐标（CSS 像素）。 */
export function worldToScreen(cam: Camera, view: ViewSize, x: number, y: number): Point {
  return { x: (x - cam.x) * cam.k + view.w / 2, y: (y - cam.y) * cam.k + view.h / 2 }
}

/** 屏幕坐标 → 世界坐标。 */
export function screenToWorld(cam: Camera, view: ViewSize, x: number, y: number): Point {
  return { x: (x - view.w / 2) / cam.k + cam.x, y: (y - view.h / 2) / cam.k + cam.y }
}

/** 缩放上下限：与改前 ECharts 的 `scaleLimit {max:5, min:0.4}` 同档。 */
export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 5

/**
 * 以屏幕某点为锚点缩放（滚轮缩放）：锚点下的世界坐标在缩放前后不动。
 * @param cam - 原相机。
 * @param view - 视口尺寸。
 * @param anchorX - 锚点屏幕 x。
 * @param anchorY - 锚点屏幕 y。
 * @param factor - 缩放倍数（>1 放大）。
 * @returns 新相机。
 */
export function zoomAt(cam: Camera, view: ViewSize, anchorX: number, anchorY: number, factor: number): Camera {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.k * factor))
  if (k === cam.k) return cam
  const before = screenToWorld(cam, view, anchorX, anchorY)
  const after = { x: (anchorX - view.w / 2) / k + cam.x, y: (anchorY - view.h / 2) / k + cam.y }
  return { k, x: cam.x + (before.x - after.x), y: cam.y + (before.y - after.y) }
}

/**
 * 适应视图：把全部节点（含半径）装进视口，留出边距。
 * @param nodes - 节点。
 * @param positions - 坐标表。
 * @param radiusOf - 取半径。
 * @param view - 视口尺寸。
 * @returns 相机；没有可用坐标时返回 `null`（调用方保持原相机）。
 */
export function fitCamera(
  nodes: readonly GNode[],
  positions: ReadonlyMap<string, Point>,
  radiusOf: (node: GNode) => number,
  view: ViewSize,
): Camera | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const p = positions.get(n.id)
    if (!p) continue
    const r = radiusOf(n)
    if (p.x - r < minX) minX = p.x - r
    if (p.x + r > maxX) maxX = p.x + r
    if (p.y - r < minY) minY = p.y - r
    if (p.y + r > maxY) maxY = p.y + r
  }
  if (!Number.isFinite(minX) || view.w <= 0 || view.h <= 0) return null
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(view.w / spanX, view.h / spanY) * 0.92))
  return { k, x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * 命中测试：返回**世界坐标**点下的节点 id（取数组里最后画的那个，即叠在最上面的）。
 *
 * 参数是世界坐标而不是屏幕坐标：`positions` 就是世界坐标表，在这里换算过来比让调用方
 * 先算屏幕坐标再反查少一次变换，也避免「传错坐标系」这类静默错误 —— 传错时表现为
 * 「点到的地方和选中的节点差一个缩放倍率」，很难一眼看出来。
 *
 * 为什么要显式按绘制顺序反查而不是靠「最近」：节点重叠时用户看到的是**画在上面**的那个，
 * 选中的也应该是它，否则会出现「点的是 A、选中了被 A 压住的 B」。
 * @param nodes - 节点（绘制顺序）。
 * @param positions - 世界坐标表。
 * @param radiusOf - 取半径。
 * @param cam - 相机（只用来把「4px 命中容差」换算成世界单位）。
 * @param px - 世界坐标 x。
 * @param py - 世界坐标 y。
 * @returns 命中的节点 id，或 `null`。
 */
export function pickNode(
  nodes: readonly GNode[],
  positions: ReadonlyMap<string, Point>,
  radiusOf: (node: GNode) => number,
  cam: Camera,
  px: number,
  py: number,
): string | null {
  // 命中容差：环上的点也该点得中（半径 + 2px 描边的余量 + 手指/触控板的误差）
  const slack = 4 / cam.k
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (!n) continue
    const p = positions.get(n.id)
    if (!p) continue
    const r = radiusOf(n) + slack
    const dx = px - p.x
    const dy = py - p.y
    if (dx * dx + dy * dy <= r * r) return n.id
  }
  return null
}

/** 社区聚焦/悬停的淡出系数。聚焦时非本圈几乎隐形，仅悬停时只做轻度淡出（免得扫过就闪）。 */
export function dimOpacity(community: number, focus: number | null, hover: number | null): number {
  const active = focus ?? hover
  if (active == null) return 1
  if (community === active) return 1
  return focus != null ? 0.12 : 0.35
}

/** 单个节点的不透明度：悬停邻居优先（只留邻居），否则走社区聚焦规则。 */
export function nodeOpacity(
  node: GNode,
  view: {
    hoverNodeId: string | null
    hoverNeighbours: ReadonlySet<string> | null
    focusCommunity: number | null
    hoverCommunity: number | null
  },
): number {
  if (view.hoverNodeId != null) {
    return node.id === view.hoverNodeId || view.hoverNeighbours?.has(node.id) === true ? 1 : 0.15
  }
  return dimOpacity(node.community, view.focusCommunity, view.hoverCommunity)
}

/** 边的线型规格（宽度、颜色、是否虚线）。 */
export interface EdgeStroke {
  width: number
  color: string
  dashed: boolean
}

/**
 * 边的线型：按类型分色/分粗细，指向 stub 的 wiki 边画虚线（「这篇笔记还不存在」）。
 * 数值与改前 ECharts 版逐项一致 —— 图例（灰线=共同群数 / 蓝线=亲密度 / 紫线=[[链接]]）
 * 就是按这套颜色写的，改色等于把图例变成谎话。
 * @param edge - 边。
 * @param theme - 主题。
 * @param settings - 设置（取 `edgeWidth`）。
 * @param stubIds - stub 节点集合。
 * @returns 线型。
 */
export function edgeStroke(
  edge: GEdge,
  theme: GraphTheme,
  settings: GraphSettings,
  stubIds: ReadonlySet<string>,
): EdgeStroke {
  const isWiki = edge.kind === 'wiki'
  const isSource = edge.kind === 'source'
  const width = isWiki
    ? Math.max(0.4, settings.edgeWidth * 0.9)
    : isSource
      ? Math.max(0.4, settings.edgeWidth * 0.7)
      : Math.max(0.3, settings.edgeWidth * (edge.kind === 'intimacy' ? 1.25 : 0.8))
  const color = isWiki
    ? theme.edgeWiki
    : isSource
      ? theme.edgeSource
      : edge.kind === 'intimacy'
        ? theme.edgeIntimacy
        : theme.edgeCommon
  return { width, color, dashed: isWiki && stubIds.has(edge.target) }
}

/**
 * 连线预算：节点越多，只画权重最高的那些（改前 ECharts 版同口径，避免大图被线糊住）。
 *
 * 外层再夹一次 `edgeCount`：改前写的是 `Math.max(180, Math.min(edgeCount, …))`，边很少时
 * 会返回一个比实际边数还大的「预算」（例如 5 条边返回 180）。`slice` 之下无害，但会让
 * 任何拿它做循环上界、或打印「画了多少条」的地方对不上 —— 预算就该不超过可用量。
 * @param nodeCount - 节点数。
 * @param edgeCount - 实际边数。
 * @returns 实际绘制的边数上限。
 */
export function edgeBudget(nodeCount: number, edgeCount: number): number {
  return Math.min(edgeCount, Math.max(180, Math.round(nodeCount * 0.9)))
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
 * 按 kind 分桶、每桶先按权重取保底份额（桶数均分），剩余预算再按桶大小回填：
 * 「我↔对方」与「对方↔对方」两类边都能出现，且各自只保留权重最高的那部分。
 * @param edges - 全量边（按 buildGraph 的顺序）。
 * @param nodeCount - 节点数（决定预算）。
 * @returns 实际要画的边（保持输入顺序，绘制顺序稳定）。
 */
export function selectEdges(edges: readonly GEdge[], nodeCount: number): GEdge[] {
  const budget = edgeBudget(nodeCount, edges.length)
  if (edges.length <= budget) return [...edges]
  const byKind = new Map<GEdge['kind'], number[]>()
  edges.forEach((e, i) => {
    const arr = byKind.get(e.kind)
    if (arr) arr.push(i)
    else byKind.set(e.kind, [i])
  })
  // 各桶按权重降序：桶内取前 share 条就是该类里最强的那些边
  for (const arr of byKind.values()) arr.sort((a, b) => (edges[b]?.weight ?? 0) - (edges[a]?.weight ?? 0))
  const kinds = [...byKind.keys()]
  if (kinds.length === 0) return []
  const share = Math.max(1, Math.floor(budget / kinds.length))
  const chosen = new Set<number>()
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
const LABEL_MIN_ZOOM = 0.32

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

const FONT_STACK = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'

/** 标签字体：11px 与改前一致。 */
export const LABEL_FONT = `500 11px ${FONT_STACK}`

/** 节点在屏幕上的半径（含相机缩放），不小于 3px —— 缩到极小也得看得见一个点。 */
function screenRadius(r: number, k: number): number {
  return Math.max(3, r * k)
}

/**
 * 把场景画到 ctx 上。调用方负责 `ctx.setTransform(dpr,…)` 与清屏。
 *
 * 绘制顺序：边 → 节点圆盘/头像 → 描边环 → 标签 → 悬停气泡。后画的盖住先画的，
 * 所以「悬停/选中的节点在最上面」是靠把它们的节点序挪到末尾实现的。
 * @param ctx - 画布上下文（CSS 像素坐标系）。
 * @param scene - 场景。
 * @returns 实际画出的标签 id 集合（调用方用它缓存，避免重复计算）。
 */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): { labels: Set<string>; avatars: number } {
  const { camera: cam, size, settings, dark } = scene
  const theme = graphTheme(dark)
  const k = cam.k
  const stubIds = new Set(scene.nodes.filter(n => n.stub === true || n.kind === 'stub').map(n => n.id))
  const hoverId = scene.hoverNodeId
  const edges = scene.edgesToDraw ?? selectEdges(scene.edges, scene.nodes.length)
  /** 出现动画里某节点当前的显现进度；没有动画时恒为 1。 */
  const revealMap = scene.reveal ?? null
  const revealOf = (id: string): number => (revealMap ? revealMap.get(id) ?? 1 : 1)

  // ── 边 ──
  ctx.save()
  ctx.lineCap = 'round'
  for (const e of edges) {
    const a = scene.positions.get(e.source)
    const b = scene.positions.get(e.target)
    if (!a || !b) continue
    if (hoverId != null && e.source !== hoverId && e.target !== hoverId) continue
    // 出现动画：边要**两端都出现之后**才跟着淡入 —— 只按一端算的话，
    // 新出现的节点会先拖着一条连向「还不存在的邻居」的线，看着像断线
    const edgeReveal = Math.min(revealOf(e.source), revealOf(e.target))
    if (edgeReveal <= 0) continue
    ctx.globalAlpha = edgeReveal
    const sa = worldToScreen(cam, size, a.x, a.y)
    const sb = worldToScreen(cam, size, b.x, b.y)
    const stroke = edgeStroke(e, theme, settings, stubIds)
    const width = Math.max(0.3, stroke.width * (hoverId != null ? 1.6 : 1))
    ctx.beginPath()
    ctx.setLineDash(stroke.dashed ? [4 / Math.max(k, 0.5), 4 / Math.max(k, 0.5)] : [])
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = width
    ctx.moveTo(sa.x, sa.y)
    ctx.lineTo(sb.x, sb.y)
    ctx.stroke()
    if (settings.showArrows) {
      // 箭头内缩到节点环之外，别被圆盘盖住；两端都画的只有互惠关系（共同群 / 亲密度），
      // 有方向的 [[链接]] 与「沉淀来源」只画指向 target 的那一端。
      const angle = Math.atan2(sb.y - sa.y, sb.x - sa.x)
      const size = arrowSize(width, k)
      const ends = arrowEnds(e.bidirectional)
      if (ends.target) {
        const r = screenRadius(scene.radii.get(e.target) ?? 8, k) + 2
        drawArrowHead(ctx, sb.x - Math.cos(angle) * r, sb.y - Math.sin(angle) * r, angle, size, stroke.color)
      }
      if (ends.source) {
        const r = screenRadius(scene.radii.get(e.source) ?? 8, k) + 2
        drawArrowHead(ctx, sa.x + Math.cos(angle) * r, sa.y + Math.sin(angle) * r, angle + Math.PI, size, stroke.color)
      }
    }
  }
  ctx.restore()

  // ── 节点：先画普通节点，悬停/选中的最后画（压在最上层） ──
  const order: GNode[] = []
  let hovered: GNode | null = null
  let selected: GNode | null = null
  for (const n of scene.nodes) {
    if (n.id === hoverId) { hovered = n; continue }
    if (n.id === scene.selectedId) { selected = n; continue }
    order.push(n)
  }
  if (selected) order.push(selected)
  if (hovered) order.push(hovered)

  const labels = new Set<string>()
  /**
   * 用头像位图真正画出来的节点数。
   *
   * 为什么要数它：节点的「有没有头像」在画面上只能看出「有个圆盘」，看不出里面是头像照片
   * 还是兜底的社区色 + 首字 —— 用户报「有些节点没有头像」时，得先能区分
   * 「头像没拉到 / 被预算截掉」（我们能修）与「这个人本地就没有头像数据」（修不了）。
   * 调用方把它暴露成画布的 `data-avatars`。
   */
  let avatars = 0

  for (const n of order) {
    const p = scene.positions.get(n.id)
    if (!p) continue
    const r = scene.radii.get(n.id) ?? 8
    const fullSr = screenRadius(r, k)
    const s = worldToScreen(cam, size, p.x, p.y)
    // 视口剔除：完全在画布外的节点不必走绘制路径（大图平移时省下大量 drawImage）。
    // 用**完整**半径判：出现动画里的节点也占位，别因为它当前小就多画一遍。
    if (s.x + fullSr < -8 || s.x - fullSr > size.w + 8 || s.y + fullSr < -8 || s.y - fullSr > size.h + 8) continue
    // 出现动画：还没到时刻的节点整个不画（也就不会计入头像 / 标签 / 悬停高亮）
    const reveal = revealOf(n.id)
    if (reveal <= 0) continue
    // 半径随进度从 REVEAL_MIN_SCALE 长到 1 —— 「衍生」的观感来自「长大」而不只是淡入
    const sr = fullSr * (REVEAL_MIN_SCALE + (1 - REVEAL_MIN_SCALE) * reveal)
    const opacity = nodeOpacity(n, {
      hoverNodeId: hoverId,
      hoverNeighbours: scene.hoverNeighbours,
      focusCommunity: scene.focusCommunity,
      hoverCommunity: scene.hoverCommunity,
    })
    const isStub = n.stub === true || n.kind === 'stub'
    const isNote = n.kind === 'note'
    const isHover = n.id === hoverId
    const isSelected = n.id === scene.selectedId
    const isPinned = scene.pinnedIds.has(n.id)

    ctx.save()
    ctx.globalAlpha = opacity * (isStub ? 0.6 : 1) * reveal
    if (settings.blurNodes > 0) {
      ctx.shadowBlur = settings.blurNodes * 1.5
      ctx.shadowColor = dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.3)'
    }
    const avatarId = scene.avatarIdOf(n)
    const sprite = avatarId ? scene.sprites.get(avatarId) : undefined
    const commColor = n.kind === 'self' ? theme.ringSelected : n.community >= 0 ? communityColor(n.community) : ''
    if (isStub) {
      // 未创建的笔记：中性灰虚线圆 + 半透明，视觉上退到背景里（缺口提示）
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2)
      ctx.fillStyle = dark ? 'rgba(120,130,150,0.16)' : 'rgba(140,150,165,0.14)'
      ctx.fill()
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = theme.ringStub
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (isNote) {
      // 笔记：紫色圆角方块，与「人/群」的圆盘在形状上就分得开
      const rr = sr * 0.32
      roundRectPath(ctx, s.x - sr, s.y - sr, sr * 2, sr * 2, rr)
      ctx.fillStyle = dark ? '#6d5bd0' : '#8b7ff0'
      ctx.fill()
      ctx.strokeStyle = dark ? '#a99bff' : '#6d5bd0'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (sprite) {
      // 头像圆盘：头像位图自己裁过圆，这里只画底 + 图
      avatars++
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2)
      ctx.fillStyle = theme.disc
      ctx.fill()
      ctx.drawImage(sprite, s.x - sr, s.y - sr, sr * 2, sr * 2)
    } else {
      // 兜底：社区色圆盘 + 首字（头像还没到位 / 拉取失败）
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2)
      const fill = commColor || theme.disc
      ctx.fillStyle = fill
      ctx.fill()
      if (sr >= 7) {
        ctx.fillStyle = readableOn(fill)
        ctx.font = `600 ${Math.max(8, sr * 0.9)}px ${FONT_STACK}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(n.label.slice(0, 1).toUpperCase(), s.x, s.y)
      }
    }
    ctx.restore()

    // ── 描边环：社区色 2px；悬停变白加粗；选中加青色光环；固定画黄虚线 ──
    const ringColor = isHover || isSelected
      ? (isSelected ? theme.ringSelected : theme.ringHover)
      : commColor || (opacity >= 1 ? theme.ring : theme.ringDim)
    ctx.save()
    ctx.globalAlpha = (isHover || isSelected ? 1 : opacity) * reveal
    if (isSelected) {
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr + 4, 0, Math.PI * 2)
      ctx.strokeStyle = theme.selectGlow
      ctx.lineWidth = 3
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(s.x, s.y, sr + 0.75, 0, Math.PI * 2)
    ctx.strokeStyle = ringColor
    ctx.lineWidth = isSelected ? 3 : isHover ? 2.5 : 2
    ctx.setLineDash(isPinned ? [3, 3] : [])
    ctx.stroke()
    ctx.restore()

    if (isHover || isSelected || n.id === scene.selectedId || scene.pinnedIds.has(n.id)) labels.add(n.id)
  }

  // ── 标签 ──
  if (k >= LABEL_MIN_ZOOM) {
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    const queue = labelCandidates(scene.nodes, settings, {
      hoverNodeId: hoverId,
      selectedId: scene.selectedId,
      pinnedIds: scene.pinnedIds,
    })
    ctx.save()
    ctx.font = LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (const n of queue) {
      const p = scene.positions.get(n.id)
      if (!p) continue
      // 出现动画：节点还没长出来就谈不上标签 —— 提前 continue 还能把它从避重叠的
      // 占位里让出去，否则后来真正出现的节点会被一个看不见的名字挤到旁边
      const reveal = revealOf(n.id)
      if (reveal <= 0) continue
      const sr = screenRadius(scene.radii.get(n.id) ?? 8, k)
      const s = worldToScreen(cam, size, p.x, p.y)
      if (s.x + sr < -8 || s.x - sr > size.w + 8 || s.y < -20 || s.y > size.h + 20) continue
      const text = n.label
      const rect = { x0: s.x + sr + 5, y0: s.y - 7, x1: s.x + sr + 5 + ctx.measureText(text).width, y1: s.y + 7 }
      const forced = n.id === hoverId || n.id === scene.selectedId || scene.pinnedIds.has(n.id)
      // 贪心避重叠：普通标签与已放置的相交就让位（权重大的先放，小节点被挤掉是预期优先级）；
      // 悬停/选中/固定强制画出，否则会出现「鼠标指着的那个偏偏没名字」。
      if (!forced && placed.some(q => rect.x0 < q.x1 && rect.x1 > q.x0 && rect.y0 < q.y1 && rect.y1 > q.y0)) continue
      placed.push(rect)
      const a = nodeOpacity(n, {
        hoverNodeId: hoverId,
        hoverNeighbours: scene.hoverNeighbours,
        focusCommunity: scene.focusCommunity,
        hoverCommunity: scene.hoverCommunity,
      })
      const alpha = (forced ? 1 : a) * (n.stub === true || n.kind === 'stub' ? 0.75 : 1) * reveal
      // 描边光晕：图谱底色上有大量连线穿过，不打光晕的小字基本读不出来
      ctx.globalAlpha = Math.max(0, Math.min(1, settings.labelOpacity * alpha))
      ctx.strokeStyle = theme.labelHalo
      ctx.lineWidth = 3
      ctx.lineJoin = 'round'
      ctx.strokeText(text, rect.x0, s.y)
      ctx.fillStyle = theme.label
      ctx.fillText(text, rect.x0, s.y)
      labels.add(n.id)
    }
    ctx.restore()
  }

  return { labels, avatars }
}

/** 圆角矩形路径（笔记节点用）。 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 箭头尺寸（px）：随线宽略增、随缩放略减，缩到很小时也不至于变成一坨。 */
function arrowSize(strokeWidth: number, k: number): number {
  return Math.min(9, 4 + strokeWidth * 1.2) * Math.min(1.4, Math.max(0.75, k))
}

/**
 * 箭头**尖端朝向 target**，画在 `(tipX, tipY)` 处（调用方已按目标节点半径内缩）。
 * @param ctx - 上下文。
 * @param tipX - 尖端屏幕 x。
 * @param tipY - 尖端屏幕 y。
 * @param angle - 指向方向（弧度，从 source 指向 target）。
 * @param size - 边长（px）。
 * @param color - 填充色。
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  size: number,
  color: string,
): void {
  ctx.save()
  ctx.setLineDash([])
  ctx.translate(tipX, tipY)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, size * 0.45)
  ctx.lineTo(-size, -size * 0.45)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

/** 一条边的箭头应该画在哪几端：有方向的（wiki/source）只画 target 端，互惠关系两端都画。 */
export function arrowEnds(bidirectional: boolean | undefined): { source: boolean; target: boolean } {
  return { source: bidirectional === true, target: true }
}

/** 悬停气泡的内容（标题 + 副标题）。 */
export function bubbleText(node: GNode): { title: string; sub: string } {
  if (node.kind === 'note') return { title: node.label, sub: `笔记 · 出链 ${node.outLinks ?? 0} / 被引用 ${node.backLinks ?? 0}` }
  if (node.stub === true || node.kind === 'stub') return { title: node.label, sub: `尚未创建的笔记 · 被引用 ${node.backLinks ?? 0} 次` }
  const kind = node.kind === 'group' ? '群聊' : node.kind === 'self' ? '我' : node.isOfficial ? '公众号' : node.isFriend ? '好友' : '群友'
  return { title: node.label, sub: `${kind} · 消息量 ${node.intimacy ?? node.weight}` }
}

/**
 * 画悬停气泡（参考 llm_wiki 的自定义 hover renderer：2D 圆 + 圆角矩形标签）。
 *
 * 为什么不用 HTML tooltip：图谱整体是可以平移缩放的画布，HTML 浮层要跟着相机走、
 * 还要处理遮挡与滚动；画在同一张画布上天然与节点对齐，导出 PNG 时也一起带上。
 * @param ctx - 上下文。
 * @param scene - 场景。
 * @param node - 悬停节点。
 * @returns 无。
 */
export function drawHoverBubble(ctx: CanvasRenderingContext2D, scene: Scene, node: GNode): void {
  const p = scene.positions.get(node.id)
  if (!p) return
  const theme = graphTheme(scene.dark)
  const sr = screenRadius(scene.radii.get(node.id) ?? 8, scene.camera.k)
  const s = worldToScreen(scene.camera, scene.size, p.x, p.y)
  const { title, sub } = bubbleText(node)
  ctx.save()
  ctx.font = LABEL_FONT
  const titleW = ctx.measureText(title).width
  const subW = ctx.measureText(sub).width
  const w = Math.max(titleW, subW) + 20
  const h = 40
  const x = Math.min(Math.max(s.x + sr + 8, 6), Math.max(6, scene.size.w - w - 6))
  const y = Math.min(Math.max(s.y - h / 2, 6), Math.max(6, scene.size.h - h - 6))
  roundRectPath(ctx, x, y, w, h, 8)
  ctx.fillStyle = theme.bubbleBg
  ctx.fill()
  ctx.strokeStyle = theme.bubbleBorder
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = theme.bubbleText
  ctx.fillText(title, x + 10, y + 14)
  ctx.fillStyle = theme.bubbleSub
  ctx.font = `400 10px ${FONT_STACK}`
  ctx.fillText(sub, x + 10, y + 29)
  ctx.restore()
}

/** 数值中位数（原地不排序副本）。 */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * 从坐标表里取「最近邻距离中位数」。
 *
 * 为什么要这个量：FA2 输出的坐标是**无量纲**的 —— 它取决于 `scalingRatio`/`slowDown` 与图的规模，
 * 和画布上的像素半径毫无关系。节点只有 2 个时 FA2 的自然坐标量级是 ±6，而节点半径是 5~23px，
 * 于是两个圆直接叠在一起（真机实测：知识图谱 2 个节点相隔 16 个单位，半径 21px 与 12px 的圆
 * 严重重叠，而画布的自适应缩放有 5× 上限、补不回来）。
 *
 * 大图用「按 x 排序后只比较邻近若干个」的近似：精确解是 O(n²)（10000 节点要一亿次距离计算），
 * 而这个量只用来定一个**全局缩放系数**，取中位数的统计量本来就对少量漏配不敏感。
 * @param nodes - 节点。
 * @param positions - 坐标表。
 * @returns 中位最近邻距离；可用点不足 2 个时返回 0。
 */
export function medianNearestDistance(
  nodes: readonly GNode[],
  positions: ReadonlyMap<string, Point>,
): number {
  const pts: Point[] = []
  for (const n of nodes) {
    const p = positions.get(n.id)
    if (p) pts.push(p)
  }
  if (pts.length < 2) return 0
  if (pts.length <= 1500) {
    const dists: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      if (!a) continue
      let best = Infinity
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue
        const b = pts[j]
        if (!b) continue
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2
        if (d < best) best = d
      }
      if (Number.isFinite(best)) dists.push(Math.sqrt(best))
    }
    return medianOf(dists)
  }
  const byX = [...pts].sort((a, b) => a.x - b.x)
  const dists: number[] = []
  for (let i = 0; i < byX.length; i++) {
    const a = byX[i]
    if (!a) continue
    let best = Infinity
    for (let k = -4; k <= 4; k++) {
      const b = byX[i + k]
      if (!b || b === a) continue
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2
      if (d < best) best = d
    }
    if (Number.isFinite(best)) dists.push(Math.sqrt(best))
  }
  return medianOf(dists)
}

/**
 * 间距安全网的缩放系数：**只在圆会真的相交时才把坐标放大**，否则原样返回 1。
 *
 * 为什么必须这么保守：坐标放大 s 倍后，画布的自适应缩放会按 1/s 缩回去 —— 屏幕上的
 * **圆心间距不变，而节点圆盘直径缩小 s 倍**。也就是说「归一化」的代价是节点在屏幕上变小。
 * 第一版按「间距 = nodeGap ×（2×中位半径 + 14）」无条件归一，在 251 节点的人脉图上把坐标
 * 放大了约 2 倍，结果头像退化成看不清的小点（真机截图对比确认），而那张图本来并不重叠。
 * 所以判据只能是「有没有重叠」，不能是「间距够不够宽松」。
 *
 * 判据：圆心间距中位数 < 2×中位半径 ⇒ 必然存在相交的圆，按 `nodeGap × 2×中位半径` 放大；
 * 只放大不压缩（压缩会把本来不重叠的图解压到重叠）。
 *
 * 触发场景就是小图：FA2 的坐标是无量纲的，2 个节点时自然量级是 ±6，而半径是 5~23px，
 * 两个圆必然叠住（真机实测：知识图谱 2 个节点相隔 16 单位、半径 21px 与 12px）。
 * @param nodes - 节点。
 * @param radii - 节点半径表。
 * @param positions - 坐标表。
 * @param nodeGap - 节点间距滑杆。
 * @returns 缩放系数，≥ 1（不需要调整时为 1）。
 */
export function spacingScale(
  nodes: readonly GNode[],
  radii: ReadonlyMap<string, number>,
  positions: ReadonlyMap<string, Point>,
  nodeGap: number,
): number {
  const d0 = medianNearestDistance(nodes, positions)
  if (!(d0 > 0)) return 1
  const radiiList: number[] = []
  for (const n of nodes) {
    if (!positions.has(n.id)) continue
    radiiList.push(radii.get(n.id) ?? nodeRadius(n, DEFAULT_GRAPH_SETTINGS, nodes.length))
  }
  const medianR = medianOf(radiiList) || 10
  const overlapThreshold = medianR * 2
  if (d0 >= overlapThreshold) return 1
  const target = Math.max(1, nodeGap) * overlapThreshold
  return Math.max(1, Math.min(8, target / d0))
}

/* ── 碰撞松弛 ───────────────────────────────────────────────────────────
 *
 * 目标：任意两圆的圆心距 ≥ (r1 + r2) × gap，移动中与静止后都不重叠。
 *
 * 为什么不用「按顺序逐对推开」（Gauss-Seidel）：边扫边改会让节点在本轮中途跑出自己的
 * 网格单元，而网格是本轮开头建的，于是本该配对的点查不到彼此，表现为「松弛了 N 遍还剩
 * 几对叠着」。这里每轮扫描完统一施加位移（Jacobi），整轮网格都有效。
 *
 * 为什么用网格而不是 O(n²)：cellSize 取最大直径 × gap，两圆若重叠则圆心距必 ≤ cellSize，
 * 因此只看 3×3 邻格就足够。2000 节点时每轮约 3 万次配对检查（<1ms），拖拽可以逐帧跑。
 */
/** 圆心距下限系数：(r1 + r2) × gap。1.08 留一点视觉空隙（1.0 = 圆刚好相切）。 */
export const COLLIDE_GAP = 1.08

/** 网格桶键：坐标已按 cellSize 取整，落在 ±10 万格内足够。 */
function collideCellKey(cx: number, cy: number): number {
  return (cx + 100000) * 400000 + (cy + 100000)
}

/**
 * 碰撞松弛：就地把重叠的圆推开。
 * @param nodes - 节点（含绘制顺序，仅用于遍历）。
 * @param positions - 坐标表（就地修改）。
 * @param radii - 半径表。
 * @param options.gap - 圆心距下限系数。
 * @param options.iterations - 松弛轮数。
 * @param options.skip - 不参与位移的节点（固定/锁定）—— 它们仍把别人推开。
 */
export function relaxCollisions(
  nodes: readonly GNode[],
  positions: Map<string, Point>,
  radii: ReadonlyMap<string, number>,
  options: { gap?: number; iterations?: number; skip?: ReadonlySet<string> | undefined } = {},
): void {
  const gap = options.gap ?? COLLIDE_GAP
  const iterations = Math.max(0, options.iterations ?? 3)
  const skip = options.skip
  const n = nodes.length
  if (n < 2 || iterations === 0) return
  let maxR = 0
  for (const node of nodes) {
    const r = radii.get(node.id) ?? 0
    if (r > maxR) maxR = r
  }
  if (!(maxR > 0)) return
  const cellSize = Math.max(1, maxR * 2 * gap)
  const cells = new Map<number, number[]>()
  const delta = new Map<number, Point>()
  for (let round = 0; round < iterations; round++) {
    cells.clear()
    delta.clear()
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const p = node ? positions.get(node.id) : undefined
      if (!node || !p) continue
      const k = collideCellKey(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize))
      const bucket = cells.get(k)
      if (bucket) bucket.push(i)
      else cells.set(k, [i])
    }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]
      const pa = a ? positions.get(a.id) : undefined
      if (!a || !pa) continue
      const cx = Math.floor(pa.x / cellSize)
      const cy = Math.floor(pa.y / cellSize)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const j of cells.get(collideCellKey(cx + ox, cy + oy)) ?? []) {
            if (j <= i) continue
            const b = nodes[j]
            const pb = b ? positions.get(b.id) : undefined
            if (!b || !pb) continue
            const aFixed = skip?.has(a.id) === true
            const bFixed = skip?.has(b.id) === true
            if (aFixed && bFixed) continue
            const minDist = ((radii.get(a.id) ?? 0) + (radii.get(b.id) ?? 0)) * gap
            if (!(minDist > 0)) continue
            let dx = pb.x - pa.x
            let dy = pb.y - pa.y
            let d = Math.hypot(dx, dy)
            if (d >= minDist) continue
            // 完全重合时给一个确定性的分离方向（用下标差定角度，不引入随机数，
            // 否则同一份数据两次松弛会不一样）。
            if (d < 1e-6) {
              const ang = (i - j) * (Math.PI * (3 - Math.sqrt(5)))
              dx = Math.cos(ang)
              dy = Math.sin(ang)
              d = 1
            }
            const push = (minDist - d) / d / 2
            const mx = dx * push
            const my = dy * push
            const add = (idx: number, sx: number, sy: number): void => {
              const cur = delta.get(idx)
              if (cur) { cur.x += sx; cur.y += sy }
              else delta.set(idx, { x: sx, y: sy })
            }
            if (aFixed) add(j, mx * 2, my * 2)
            else if (bFixed) add(i, -mx * 2, -my * 2)
            else { add(i, -mx, -my); add(j, mx, my) }
          }
        }
      }
    }
    for (const [i, d] of delta) {
      const node = nodes[i]
      const p = node ? positions.get(node.id) : undefined
      if (!p) continue
      p.x += d.x
      p.y += d.y
    }
  }
}

/** SVG 文本转义。 */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 把场景序列化成**矢量** SVG（导出用）。
 *
 * 与 `drawScene` 共用同一份尺寸/线型/淡出规则（都从 `nodeRadius` / `edgeStroke` / `nodeOpacity`
 * 取），所以「屏幕所见」与「导出的 SVG」不会走样 —— 这正是改前 ECharts 版靠 SVGRenderer
 * 重画一遍所不能保证的（那条路径上还有 hideOverlap 之类的内部差异）。
 * 头像用 `<image>` + `<clipPath>` 内联 data URL，因此导出的 SVG 是自包含的。
 * @param scene - 场景（`avatarUrlOf` 提供原始 data URL）。
 * @param avatarUrlOf - 节点 → 头像 data URL。
 * @returns SVG 字符串。
 */
export function sceneToSvg(
  scene: Scene,
  avatarUrlOf: (node: GNode) => string,
): string {
  const theme = graphTheme(scene.dark)
  const { size, camera: cam, settings } = scene
  const stubIds = new Set(scene.nodes.filter(n => n.stub === true || n.kind === 'stub').map(n => n.id))
  const edges = scene.edgesToDraw ?? selectEdges(scene.edges, scene.nodes.length)
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">`)
  parts.push(`<rect width="${size.w}" height="${size.h}" fill="${theme.bg}"/>`)
  const clip = (id: string): string => `clip-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  // 边的描边
  parts.push('<g fill="none">')
  for (const e of edges) {
    const a = scene.positions.get(e.source)
    const b = scene.positions.get(e.target)
    if (!a || !b) continue
    const sa = worldToScreen(cam, size, a.x, a.y)
    const sb = worldToScreen(cam, size, b.x, b.y)
    const stroke = edgeStroke(e, theme, settings, stubIds)
    const dash = stroke.dashed ? ` stroke-dasharray="${(4 / Math.max(cam.k, 0.5)).toFixed(2)}"` : ''
    parts.push(`<line x1="${sa.x.toFixed(2)}" y1="${sa.y.toFixed(2)}" x2="${sb.x.toFixed(2)}" y2="${sb.y.toFixed(2)}" stroke="${stroke.color}" stroke-width="${stroke.width.toFixed(2)}"${dash}/>`)
    if (settings.showArrows) {
      // 与画布绘制同一套口径（arrowEnds / arrowSize），否则导出的图与屏幕所见不一致
      const angle = Math.atan2(sb.y - sa.y, sb.x - sa.x)
      const size = arrowSize(stroke.width, cam.k)
      const ends = arrowEnds(e.bidirectional)
      const head = (tipX: number, tipY: number, dir: number): string => {
        const p1 = { x: tipX, y: tipY }
        const p2 = { x: tipX - Math.cos(dir) * size - Math.sin(dir) * size * 0.45, y: tipY - Math.sin(dir) * size + Math.cos(dir) * size * 0.45 }
        const p3 = { x: tipX - Math.cos(dir) * size + Math.sin(dir) * size * 0.45, y: tipY - Math.sin(dir) * size - Math.cos(dir) * size * 0.45 }
        return `<polygon points="${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p3.x.toFixed(2)},${p3.y.toFixed(2)}" fill="${stroke.color}"/>`
      }
      if (ends.target) {
        const r = screenRadius(scene.radii.get(e.target) ?? 8, cam.k) + 2
        parts.push(head(sb.x - Math.cos(angle) * r, sb.y - Math.sin(angle) * r, angle))
      }
      if (ends.source) {
        const r = screenRadius(scene.radii.get(e.source) ?? 8, cam.k) + 2
        parts.push(head(sa.x + Math.cos(angle) * r, sa.y + Math.sin(angle) * r, angle + Math.PI))
      }
    }
  }
  parts.push('</g>')
  // 节点
  parts.push('<g>')
  for (const n of scene.nodes) {
    const p = scene.positions.get(n.id)
    if (!p) continue
    const sr = screenRadius(scene.radii.get(n.id) ?? 8, cam.k)
    const s = worldToScreen(cam, size, p.x, p.y)
    const opacity = nodeOpacity(n, {
      hoverNodeId: scene.hoverNodeId,
      hoverNeighbours: scene.hoverNeighbours,
      focusCommunity: scene.focusCommunity,
      hoverCommunity: scene.hoverCommunity,
    }) * (n.stub === true || n.kind === 'stub' ? 0.6 : 1)
    const isStub = n.stub === true || n.kind === 'stub'
    const isNote = n.kind === 'note'
    const commColor = n.kind === 'self' ? theme.ringSelected : n.community >= 0 ? communityColor(n.community) : ''
    const url = isStub || isNote ? '' : avatarUrlOf(n)
    const op = ` opacity="${opacity.toFixed(3)}"`
    if (isStub) {
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}" fill="${theme.disc}" fill-opacity="0.2" stroke="${theme.ringStub}" stroke-width="1.5" stroke-dasharray="3 3"${op}/>`)
    } else if (url) {
      const id = clip(n.id)
      parts.push(`<defs><clipPath id="${id}"><circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}"/></clipPath></defs>`)
      parts.push(`<image x="${(s.x - sr).toFixed(2)}" y="${(s.y - sr).toFixed(2)}" width="${(sr * 2).toFixed(2)}" height="${(sr * 2).toFixed(2)}" clip-path="url(#${id})" xlink:href="${esc(url)}"${op}/>`)
    } else if (isNote) {
      parts.push(`<rect x="${(s.x - sr).toFixed(2)}" y="${(s.y - sr).toFixed(2)}" width="${(sr * 2).toFixed(2)}" height="${(sr * 2).toFixed(2)}" rx="${(sr * 0.32).toFixed(2)}" fill="${scene.dark ? '#6d5bd0' : '#8b7ff0'}" stroke="${scene.dark ? '#a99bff' : '#6d5bd0'}" stroke-width="1.5"${op}/>`)
    } else {
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}" fill="${commColor || theme.disc}"${op}/>`)
    }
    if (!isStub) {
      const ring = commColor || theme.ring
      const pinned = scene.pinnedIds.has(n.id) ? ' stroke-dasharray="3 3"' : ''
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${(sr + 0.75).toFixed(2)}" fill="none" stroke="${ring}" stroke-width="2"${pinned}${op}/>`)
    }
  }
  parts.push('</g>')
  // 标签：与屏幕绘制挑同一批候选（labelCandidates），并做同样的贪心避重叠 ——
  // 否则导出的 SVG 会比屏幕多出一堆互相压住的字。
  parts.push(`<g font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="11">`)
  const placedLabels: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  for (const n of labelCandidates(scene.nodes, settings, {
    hoverNodeId: scene.hoverNodeId,
    selectedId: scene.selectedId,
    pinnedIds: scene.pinnedIds,
  })) {
    const p = scene.positions.get(n.id)
    if (!p) continue
    const sr = screenRadius(scene.radii.get(n.id) ?? 8, cam.k)
    const s = worldToScreen(cam, size, p.x, p.y)
    const forced = n.id === scene.hoverNodeId || n.id === scene.selectedId || scene.pinnedIds.has(n.id)
    const rect = { x0: s.x + sr + 5, y0: s.y - 7, x1: s.x + sr + 5 + estimateTextWidth(n.label, 11), y1: s.y + 7 }
    if (!forced && placedLabels.some(q => rect.x0 < q.x1 && rect.x1 > q.x0 && rect.y0 < q.y1 && rect.y1 > q.y0)) continue
    placedLabels.push(rect)
    const alpha = (forced
      ? 1
      : nodeOpacity(n, {
          hoverNodeId: scene.hoverNodeId,
          hoverNeighbours: scene.hoverNeighbours,
          focusCommunity: scene.focusCommunity,
          hoverCommunity: scene.hoverCommunity,
        })) * settings.labelOpacity
    parts.push(`<text x="${rect.x0.toFixed(2)}" y="${s.y.toFixed(2)}" dominant-baseline="middle" stroke="${theme.labelHalo}" stroke-width="3" stroke-linejoin="round" fill="${theme.label}" fill-opacity="${alpha.toFixed(3)}" stroke-opacity="${alpha.toFixed(3)}">${esc(n.label)}</text>`)
  }
  parts.push('</g>')
  parts.push('</svg>')
  return parts.join('')
}
