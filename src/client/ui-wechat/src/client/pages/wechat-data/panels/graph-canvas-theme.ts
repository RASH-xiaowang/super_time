/**
 * `graph-canvas.ts` 的「主题与相机：配色/尺寸/头像候选、世界↔屏幕坐标、缩放与取整、透明度」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module graph-canvas-theme
 */

import { DEFAULT_GRAPH_SETTINGS, communityColor, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { edgeBudget } from './graph-budget.ts'
import { bubbleText } from './graph-canvas-render.ts'

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
  /** 同备注编号(同班级):画虚线,语义上比「共同群」弱一档 */
  edgeClass: string
  /** 首字相同:画虚线,语义上比「同备注编号」再弱一档(最粗粒度的启发式) */
  edgeInitial: string
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
        edgeClass: 'rgba(240,178,74,0.6)',
        // 首字层是**蓝虚线**：蓝与「与我亲密度」同色系，靠**虚线 + 更亮的sky蓝**区分。
        // 图例同时写明「蓝虚线 = 首字相同 / 蓝实线 = 与我亲密度」，颜色不是唯一线索。
        edgeInitial: 'rgba(96,204,255,0.72)',
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
        edgeClass: 'rgba(176,112,16,0.62)',
        edgeInitial: 'rgba(0,138,196,0.62)',
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

/** 节点是否属于「人/群」这一族（只有它们有头像）；笔记、待补、文件与章节都是几何符号。 */
export function hasAvatar(node: GNode): boolean {
  return node.kind !== 'note' && node.kind !== 'stub' && node.stub !== true
    // 文档层的三类都不能去要头像：它们不是通讯录里的对象。
    && node.kind !== 'file' && node.kind !== 'section' && node.kind !== 'entity'
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
 *
 * 两种**推断层**边都画虚线（`class` 金虚线 / `initial` 蓝虚线）：它们是「从备注/名字结构
 * 推出来的」，不是微信数据里观测到的共处，虚线让它们在画面上自解释，不必只靠颜色区分。
 * @param edge - 边。
 * @param theme - 主题。
 * @param settings - 设置（取 `edgeWidth`）。
 * @param stubIds - stub 节点集合。
 * @returns 线型。
 */
/**
 * 文档层三类节点的颜色（屏幕与导出 SVG **共用一份**）。
 *
 * 为什么收成函数而不是两处各写一遍字面量：导出那条分支以前就是「抄一份」，
 * 靠注释说「逐字节一致」—— 而注释不会阻止第三类节点只加在其中一处。
 * 身份靠颜色区分：
 *   文件=青（与主题强调色同族，读作「资料」）；
 *   章节=灰蓝（介于笔记紫与待补灰之间，读作「结构」）；
 *   实体=琥珀（与「推断」的虚线边同一族语言：这是模型说的，不是文档里写着的）。
 * @param kind - 节点类别（file / section / entity）。
 * @param dark - 是否深色主题。
 * @returns `{ fill, stroke }`。
 */
export function docColors(kind: string, dark: boolean): { fill: string; stroke: string } {
  if (kind === 'file') return { fill: dark ? '#12707f' : '#0e7490', stroke: dark ? '#3fd8ee' : '#0f7c92' }
  if (kind === 'entity') return { fill: dark ? '#8a5a12' : '#b45309', stroke: dark ? '#f0b35a' : '#8a4b08' }
  return { fill: dark ? '#41506b' : '#7d8797', stroke: dark ? '#8b9bb4' : '#5b6472' }
}

export function edgeStroke(
  edge: GEdge,
  theme: GraphTheme,
  settings: GraphSettings,
  stubIds: ReadonlySet<string>,
): EdgeStroke {
  const isWiki = edge.kind === 'wiki'
  const isSource = edge.kind === 'source'
  const isClass = edge.kind === 'class'
  const isInitial = edge.kind === 'initial'
  const isContain = edge.kind === 'contain'
  const isMention = edge.kind === 'mention'
  // suggest（模型抽出的实体 ↔ 文件）也是推断层：虚线、细，与 mention 同档。
  const isSuggest = edge.kind === 'suggest'
  // 三个推断层用同一档线宽（都比共同群细），首字层是三者里最粗粒度的规则
  const isInferred = isClass || isInitial || isMention || isSuggest
  // contain（章节确实在文件里）与 wiki 同档：两者都是**记录下来的事实**，不是猜的。
  // mention（笔记标题出现在正文里）与 class/initial 同档：推断层，虚线、更细。
  const isFactual = isWiki || isContain
  const width = isFactual
    ? Math.max(0.4, settings.edgeWidth * 0.9)
    : isSource
      ? Math.max(0.4, settings.edgeWidth * 0.7)
      : isInferred
        ? Math.max(0.35, settings.edgeWidth * 0.6)
        : Math.max(0.3, settings.edgeWidth * (edge.kind === 'intimacy' ? 1.25 : 0.8))
  // 刻意**复用**已有的主题色而不是新增两个 token：新增就得同时给深色与浅色两套值，
  // 而这两类边在图上的身份（事实 / 推断）已经由线宽与虚实表达清楚了。
  const color = isFactual
    ? theme.edgeWiki
    : isSource
      ? theme.edgeSource
      : isClass
        ? theme.edgeClass
        : isInitial
          ? theme.edgeInitial
          : edge.kind === 'intimacy'
            ? theme.edgeIntimacy
            : theme.edgeCommon
  return { width, color, dashed: (isWiki && stubIds.has(edge.target)) || isInferred }
}

/**
 * 连线预算（`MIN_EDGE_BUDGET` / `EDGES_PER_NODE` / `MAX_EDGE_BUDGET` / `edgeBudget` /
 * `edgeHeadroom`）已移到 `graph-budget.ts` —— **建模层也要用它**，写在画布模块里
 * 会让 `graph-model` 只能硬编码一份自己的额度（那正是「模型里有边、图上没画」的根源）。
 * 这里保留 re-export，既有的 `import { edgeBudget } from './graph-canvas.ts'` 全部照常可用。
 */
export { EDGES_PER_NODE, MAX_EDGE_BUDGET, MIN_EDGE_BUDGET, edgeBudget, edgeHeadroom } from './graph-budget.ts'
