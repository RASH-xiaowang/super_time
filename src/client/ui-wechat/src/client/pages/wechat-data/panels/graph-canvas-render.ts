/**
 * `graph-canvas.ts` 的「绘制与导出：drawScene、圆角/箭头/气泡、SVG 导出」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module graph-canvas-render
 */

import { DEFAULT_GRAPH_SETTINGS, communityColor, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { readableOn } from '../utils/theme-color.ts'
import { MAX_ZOOM, Point, docColors, edgeStroke, fitCamera, graphTheme, nodeOpacity, nodeRadius, pickNode, worldToScreen } from './graph-canvas-theme.ts'
import { FONT_STACK, LABEL_FONT, LABEL_MIN_ZOOM, REVEAL_MIN_SCALE, Scene, estimateTextWidth, labelCandidates, screenRadius, selectEdges } from './graph-canvas-geometry.ts'

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
  const edges = scene.edgesToDraw ?? selectEdges(scene.edges, scene.nodes)
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
      // 笔记：紫色圆盘。形状与「人/群」一致，改由**颜色**区分身份。
      // 曾经画成圆角方块，但下面的描边环与选中光环都无条件按 `ctx.arc(sr + …)` 画圆，
      // 圆内切于方块 → 四角戳出环外、环与方块错位，看起来像「方块里套了个圈」。
      // 改成圆后环天然贴合；顺带修掉一个隐性不一致 —— pickNode() 本就按半径判命中，
      // 方块的四角以前是「看得见、点不着」。
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2)
      ctx.fillStyle = dark ? '#6d5bd0' : '#8b7ff0'
      ctx.fill()
      ctx.strokeStyle = dark ? '#a99bff' : '#6d5bd0'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (n.kind === 'file' || n.kind === 'section' || n.kind === 'entity') {
      // 文档层的三类：同样是**圆盘**而不是方块 —— 下面的描边环与选中光环都无条件
      // 按 `ctx.arc(sr + …)` 画圆，笔记那段注释里记着方块错位的旧坑，别再踩一遍。
      // 颜色走 `docColors()`：屏幕与导出 SVG 共用一份，否则导出的图与所见不是一张图。
      const { fill, stroke } = docColors(n.kind, dark)
      ctx.beginPath()
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = stroke
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
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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
export function arrowSize(strokeWidth: number, k: number): number {
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
export function drawArrowHead(
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
  if (node.kind === 'file') {
    const m = node.fileMeta
    return { title: node.label, sub: `文件 · ${m?.ext?.toUpperCase() || '未知类型'} · ${m?.chunkCount ?? node.outLinks ?? 0} 个文本块` }
  }
  if (node.kind === 'section') {
    return { title: node.label, sub: `章节 · ${(node.sectionFileIds?.length ?? 0)} 份文件里都有 · 共出现 ${node.backLinks ?? 0} 次` }
  }
  // 实体必须**自报是推断**：气泡是用户判断「这条关系能不能当事实引用」的第一现场，
  // 只写「实体 · 3 份文件」会让人以为文档里明确写了三处。
  if (node.kind === 'entity') {
    return { title: node.label, sub: `模型推断 · 出现在 ${node.sectionFileIds?.length ?? 0} 份文件里（虚线 = 推断，不是文档里写着的）` }
  }
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

/** 间距归一的倍率窗口：1/8 ~ 8。两端都夹住，极端坐标不会把图压成一个点或拉成噪点。 */
export const MIN_SPACING_SCALE = 0.125
export const MAX_SPACING_SCALE = 8

/**
 * 间距归一系数：把「最近邻距离中位数」校准到 `nodeGap × 2 × 中位半径`（**双向**）。
 *
 * 目标值 `nodeGap × 2 × 中位半径` 的物理含义是「两圆相切，再按 nodeGap 留出呼吸空间」——
 * 也就是「不重叠」与「不空旷」之间的那条线。`nodeGap` 本来就是用户调呼吸空间的滑杆，
 * 这样它才第一次真正决定了密度（改前它只在「要放大」时才起作用）。
 *
 * **为什么从「只放大」改成双向**（实测数据驱动）：
 *   - 只放大 ⇒ FA2 输出多松就永久多松。同一份真实数据，好友网络（251 节点）的
 *     最近邻/中位半径 = 3.44，群组网络（65 节点）= **7.61** —— 间距差了 2.2 倍，
 *     同一个界面里两种密度，群组网络看上去就是「几个小点撒在一大片空地上」。
 *   - 压缩会不会压出重叠？不会 —— 压缩是**等比缩坐标**，之后紧跟的 `relaxCollisions`
 *     会把落到相切以内的那些对推回去（网格化 Jacobi，250 节点 24 轮 <1ms）。
 *     改前的注释担心「压缩会把本来不重叠的图解压到重叠」，那只在没有松弛步骤时成立。
 *   - 压缩还有一个反直觉的好处：`fitCamera` 会按 1/s 放大，所以**屏幕上的圆心间距不变、
 *     而节点圆盘直径放大 s 倍**。稀疏图压缩后头像反而更清楚（受 MAX_ZOOM=5 上限保护）。
 *
 * 只归一不语义化：它不关心图长什么样，只看「间距相对节点尺寸是否合适」这一个比值，
 * 所以对 2 个节点的小图和 1 万个节点的大图是同一把尺子。
 * @param nodes - 节点。
 * @param radii - 节点半径表。
 * @param positions - 坐标表。
 * @param nodeGap - 节点间距滑杆（呼吸空间）。
 * @returns 缩放系数，∈ [MIN_SPACING_SCALE, MAX_SPACING_SCALE]；算不出间距时返回 1。
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
  const target = Math.max(1, nodeGap) * medianR * 2
  return Math.max(MIN_SPACING_SCALE, Math.min(MAX_SPACING_SCALE, target / d0))
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
export function collideCellKey(cx: number, cy: number): number {
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
export function esc(text: string): string {
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
  const edges = scene.edgesToDraw ?? selectEdges(scene.edges, scene.nodes)
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
    const isDoc = n.kind === 'file' || n.kind === 'section' || n.kind === 'entity'
    const commColor = n.kind === 'self' ? theme.ringSelected : n.community >= 0 ? communityColor(n.community) : ''
    const url = isStub || isNote || isDoc ? '' : avatarUrlOf(n)
    const op = ` opacity="${opacity.toFixed(3)}"`
    if (isStub) {
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}" fill="${theme.disc}" fill-opacity="0.2" stroke="${theme.ringStub}" stroke-width="1.5" stroke-dasharray="3 3"${op}/>`)
    } else if (url) {
      const id = clip(n.id)
      parts.push(`<defs><clipPath id="${id}"><circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}"/></clipPath></defs>`)
      parts.push(`<image x="${(s.x - sr).toFixed(2)}" y="${(s.y - sr).toFixed(2)}" width="${(sr * 2).toFixed(2)}" height="${(sr * 2).toFixed(2)}" clip-path="url(#${id})" xlink:href="${esc(url)}"${op}/>`)
    } else if (isNote) {
      // 与屏幕绘制保持同一形状（圆盘）：导出/分享出去的那张图必须和画布一致
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}" fill="${scene.dark ? '#6d5bd0' : '#8b7ff0'}" stroke="${scene.dark ? '#a99bff' : '#6d5bd0'}" stroke-width="1.5"${op}/>`)
    } else if (isDoc) {
      // 文档层的三类：颜色走与屏幕同一个 `docColors()`，否则导出的图与所见不是一张图
      const { fill, stroke } = docColors(n.kind, scene.dark)
      parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${sr.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${op}/>`)
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
