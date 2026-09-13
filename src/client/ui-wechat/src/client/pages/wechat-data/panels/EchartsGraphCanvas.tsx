/**
 * ECharts `graph` (force) renderer for the WeChat 社交关系图谱. Replaces the
 * custom canvas for the WeChat panel only; the knowledge graph keeps GraphCanvas.
 *
 * Preserves: avatar nodes (`symbol: 'image://…'`), the force/appearance sliders
 * (mapped onto ECharts `force.repulsion/edgeLength/gravity` and node/label/line
 * styles), and node click → select. Selection is applied with an ECharts
 * `highlight` action so it does not re-run the force layout. Export (SVG/PNG/海报)
 * re-renders the same graph in an offscreen chart so the chosen ratio and style
 * actually change the output and the SVG button produces a real SVG file; SVG
 * re-render requires the SVGRenderer. The legacy right-click menu, community
 * glows, drag inertia, minimap, and community focus dimming stay simplified.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'
import { apiGetAvatar } from '../api.ts'
import { tokenColor } from '../utils/theme-color.ts'
import { communityColor, DEFAULT_GRAPH_SETTINGS, groupCommunities, neighboursOf, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { buildPoster, posterToDataUrl, type PosterCommunity, type PosterInput, type PosterRelation, type PosterStatItem, type PosterRatio, type PosterStyle } from './graph-poster.ts'
import css from './graph.module.css'

echarts.use([GraphChart, TooltipComponent, CanvasRenderer, SVGRenderer])

export interface EchartsGraphCanvasHandle {
  fitView: () => void
  centerOn: (id: string) => void
  runAnimation: () => void
  relayout: () => void
  exportSvg: () => Promise<string>
  exportPng: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
  renderPoster: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
}

interface EchartsGraphCanvasProps {
  graph: BuiltGraph
  dark?: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
  settings: GraphSettings
  selfUsername?: string | undefined
  pinnedIds?: ReadonlySet<string>
  focusCommunity?: number | null
  hoverCommunity?: number | null
  hoverNodeId?: string | null
  onHoverNode?: ((id: string | null) => void) | undefined
  onOpenChat?: ((username: string) => void) | undefined
  onFocusNode?: ((id: string) => void) | undefined
}

/** username → raw avatar URL (data / http), shared across remounts. */
const avatarCache = new Map<string, string>()
/** raw avatar URL → circular (arc-clipped) PNG data URL cache. */
const circleCache = new Map<string, string>()
/** 头像并发加载上限:避免一次性发起大量 avatar RPC,大图也不卡。 */
const AVATAR_CONCURRENCY = 6
/** 头像缓存上限:超过后按先入先出淘汰,防止长时间浏览内存无限增长。 */
const AVATAR_CACHE_MAX = 120

function cacheBounded(cache: Map<string, string>, key: string, value: string, max: number): void {
  if (cache.size >= max) {
    const first = cache.keys().next()
    if (!first.done && first.value !== undefined) cache.delete(first.value)
  }
  cache.set(key, value)
}

/** 并发受限的 map:同一时刻最多 limit 个任务在跑。 */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      const item = items[idx]
      if (item === undefined) break
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** 节点数 → 头像符号大小上限(节点越多越小,减少重叠)。 */
function sizeCapFor(nodeCount: number): number {
  return nodeCount <= 120 ? 60 : nodeCount <= 300 ? 44 : nodeCount <= 800 ? 34 : nodeCount <= 2000 ? 26 : 22
}

/** 持久化节点坐标:再次进入时恢复上次布局,避免力导向每次都从随机位置重新收敛。 */
const POSITION_KEY = 'dsh-graph-layout-v1'
type GridPos = { x: number; y: number }
function loadSavedPositions(): Map<string, GridPos> {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return new Map()
    return new Map(Object.entries(JSON.parse(raw) as Record<string, GridPos>))
  } catch {
    return new Map()
  }
}
function savePositions(positions: Map<string, GridPos>): void {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(Object.fromEntries(positions))) } catch { /* localStorage 不可用时忽略 */ }
}

/** 导出画幅像素(按比例)。 */
const EXPORT_SIZES: Record<PosterRatio, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '16:9': { width: 1920, height: 1080 },
}

/** 导出背景色(按风格)。 */
const EXPORT_BG: Record<PosterStyle, string> = {
  light: '#fafafa',
  dark: '#0a1025',
  neon: '#05010f',
}

/** 从 ECharts SVG data URL 解码出原始 SVG 字符串。 */
function decodeSvgDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(',')
  const payload = i >= 0 ? dataUrl.slice(i + 1) : dataUrl
  try { return decodeURIComponent(payload) } catch { return payload }
}

/** 圈子高亮淡出:聚焦圈内保持不透明,其余按需淡出。 */
function dimOpacity(community: number, focus: number | null, hover: number | null): number {
  const active = focus ?? hover
  if (active == null) return 1
  if (community === active) return 1
  return focus != null ? 0.12 : 0.35
}

/** data URL 头像 → 海报头像精灵(canvas)。 */
function dataUrlToSprite(url: string): Promise<HTMLCanvasElement | null> {
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const size = 96
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const ctx = c.getContext('2d')
      if (ctx) ctx.drawImage(img, 0, 0, size, size)
      resolve(c)
    }
    img.onerror = () => { resolve(null) }
    img.src = url
  })
}

function loadAvatar(username: string): Promise<string> {
  const hit = avatarCache.get(username)
  if (hit !== undefined) return Promise.resolve(hit)
  cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX)
  return apiGetAvatar({ username })
    .then((r) => {
      const url = r.data || r.url || ''
      cacheBounded(avatarCache, username, url, AVATAR_CACHE_MAX)
      return url
    })
    .catch(() => {
      cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX)
      return ''
    })
}

/**
 * Re-encode an avatar image into a circle-cropped PNG data URL so ECharts
 * `image://` symbols render round (they otherwise draw the raw rectangle).
 * Falls back to the original URL when the image cannot be read (e.g. a
 * cross-origin canvas taint) so a square avatar is still shown.
 */
function circleAvatarUrl(raw: string, size = 128): Promise<string> {
  const hit = circleCache.get(raw)
  if (hit !== undefined) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const ctx = c.getContext('2d')
        if (!ctx) { cacheBounded(circleCache, raw, raw, AVATAR_CACHE_MAX); resolve(raw); return }
        ctx.beginPath()
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
        ctx.clip()
        const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight)
        const w = img.naturalWidth * scale
        const h = img.naturalHeight * scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        const url = c.toDataURL('image/png')
        cacheBounded(circleCache, raw, url, AVATAR_CACHE_MAX)
        resolve(url)
      } catch {
        // Cross-origin without CORS taints the canvas; keep the square avatar.
        cacheBounded(circleCache, raw, raw, AVATAR_CACHE_MAX)
        resolve(raw)
      }
    }
    img.onerror = () => { cacheBounded(circleCache, raw, raw, AVATAR_CACHE_MAX); resolve(raw) }
    img.src = raw
  })
}

/** Single node as an ECharts graph data item. */
function nodeItem(
  g: GNode,
  settings: GraphSettings,
  dark: boolean,
  avatar: string,
  sizeCap: number,
  labelShow: boolean,
  opacity: number,
  fixed: boolean,
  pos?: GridPos,
): Record<string, unknown> {
  const comm = g.community
  // 知识节点（笔记 / 未解析目标）与「人」是两种物种：形状 + 配色同时区分，
  // 而不是只靠大小 —— 默认 nodeScale 下大小差异很容易被压平。
  const isNote = g.kind === 'note'
  const isStub = g.stub === true || g.kind === 'stub'
  const radius = Math.max(8, g.radius * settings.nodeScale)
  const symbolSize = Math.min(sizeCap, Math.max(16, radius * 2))
  const borderColor = isStub
    ? (dark ? 'rgba(150,160,180,0.9)' : 'rgba(110,120,135,0.9)')
    : isNote
      ? (dark ? '#a99bff' : '#6d5bd0')
      : comm >= 0 ? communityColor(comm) : (dark ? 'rgba(140,150,170,0.6)' : 'rgba(90,100,115,0.5)')
  const labelColor = dark ? 'rgba(200,255,255,0.95)' : 'rgba(30,40,52,0.95)'
  const fill = isStub
    ? (dark ? 'rgba(120,130,150,0.16)' : 'rgba(140,150,165,0.14)')
    : isNote
      ? (dark ? '#6d5bd0' : '#8b7ff0')
      : comm >= 0 ? communityColor(comm) : (dark ? '#2a3a4a' : '#e2e6ec')
  return {
    id: g.id,
    name: g.label,
    value: g.weight,
    // 供 tooltip 区分物种（echarts 允许数据项带自定义字段）
    kind: g.kind,
    stub: isStub,
    backLinks: g.backLinks ?? 0,
    outLinks: g.outLinks ?? 0,
    fixed,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    // 头像只属于「人」：知识节点固定用几何符号，不被 avatar 顶掉形状。
    symbol: avatar ? `image://${avatar}` : (isNote ? 'roundRect' : 'circle'),
    symbolSize,
    category: comm >= 0 ? comm : undefined,
    itemStyle: {
      color: fill,
      borderColor,
      borderWidth: isNote || isStub ? 1.5 : 0,
      ...(isStub ? { borderType: 'dashed' } : {}),
      // stub 半透明：它代表「还没写的那篇笔记」，视觉上要退到背景里。
      ...(isStub ? { opacity: opacity * 0.6 } : opacity < 1 ? { opacity } : {}),
      ...(settings.blurNodes > 0 ? {
        shadowBlur: settings.blurNodes * 1.5,
        shadowColor: dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.3)',
      } : {}),
    },
    label: {
      show: labelShow,
      formatter: g.label,
      color: labelColor,
      fontSize: 11,
      ...(isStub ? { fontStyle: 'italic' } : {}),
    },
  }
}

/** Build the full ECharts option for a baked graph + settings. */
function buildOption(
  graph: BuiltGraph,
  settings: GraphSettings,
  dark: boolean,
  avatars: Map<string, string>,
  view: {
    focusCommunity: number | null
    hoverCommunity: number | null
    hoverNodeId?: string | null
    pinnedIds: ReadonlySet<string>
    positions?: ReadonlyMap<string, GridPos>
  },
): echarts.EChartsCoreOption {
  const nodeCount = Math.max(1, graph.nodes.length)
  // Obsidian 式悬停高亮:悬停节点与其一阶邻居保持不透明,其余淡出。
  const hoverId = view.hoverNodeId ?? null
  const hoverNeighbors = hoverId ? neighboursOf(graph, hoverId) : null
  const nodeOpacityOf = (g: GNode): number => {
    if (hoverId == null) return dimOpacity(g.community, view.focusCommunity, view.hoverCommunity)
    if (g.id === hoverId || hoverNeighbors?.has(g.id)) return 1
    return 0.15
  }
  const edgeOpacityOf = (e: GEdge): number => {
    if (hoverId == null) return 1
    return e.source === hoverId || e.target === hoverId ? 1 : 0.12
  }
  // 密度:节点越多,头像圆越小 + 斥力/连线越长,减少重叠。
  const density = 1 + Math.log2(Math.max(1, nodeCount / 120))
  const sizeCap = sizeCapFor(nodeCount)
  // 重要节点(高亲密度/权重)即使关闭全局标签也始终显示名字,提升图谱可读性。
  const important = new Set([...graph.nodes].sort((a, b) => b.weight - a.weight).slice(0, 12).map(n => n.id))
  if (graph.nodes.some(n => n.id === 'self')) important.add('self')
  // 性能:仅前 60 个高权重节点用头像,其余渲染为彩色圆点;拖拽/缩放每帧图片绘制量大减。
  // 知识节点排除在外:笔记/未解析目标没有头像,占额度等于白占名额。
  const avatarNodes = new Set(
    [...graph.nodes]
      .filter(n => n.kind !== 'note' && n.kind !== 'stub' && n.stub !== true)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 60)
      .map(n => n.id),
  )
  avatarNodes.add('self')
  const nodes = graph.nodes.map(g => nodeItem(
    g,
    settings,
    dark,
    (avatarNodes.has(g.id) ? avatars.get(g.id) : '') ?? '',
    sizeCap,
    settings.showLabels || important.has(g.id),
    nodeOpacityOf(g),
    view.pinnedIds.has(g.id),
    view.positions?.get(g.id),
  ))
  const labelColor = dark ? `rgba(200,255,255,${settings.labelOpacity})` : `rgba(30,40,52,${settings.labelOpacity})`
  // 性能:仅对权重最高的前 N 条连线做力导向与渲染。连线从 graph.edges 按权重降序,
  // 保留「我与对方」亲密度连线(在前),再补充最强的共同群边;大图拖拽/缩放更流畅,也减少视觉噪点。
  const maxLinks = Math.max(180, Math.min(graph.edges.length, Math.round(graph.nodes.length * 0.9)))
  // 指向 stub 的链接画虚线：表达「这条 [[链接]] 指向的笔记还不存在」，
  // 与实线的「已建成关系」形成对比，缺口一眼可见。
  const stubIds = new Set(graph.nodes.filter(n => n.stub === true || n.kind === 'stub').map(n => n.id))
  const links = graph.edges.slice(0, maxLinks).map(e => {
    const isWiki = e.kind === 'wiki'
    const isSource = e.kind === 'source'
    const width = isWiki
      ? Math.max(0.4, settings.edgeWidth * 0.9)
      : isSource
        ? Math.max(0.4, settings.edgeWidth * 0.7)
        : Math.max(0.3, settings.edgeWidth * (e.kind === 'intimacy' ? 1.25 : 0.8))
    const color = isWiki
      ? (dark ? 'rgba(169,155,255,0.62)' : 'rgba(109,91,208,0.6)')
      : isSource
        ? (dark ? 'rgba(120,200,180,0.5)' : 'rgba(60,150,130,0.5)')
        : e.kind === 'intimacy'
          ? (dark ? 'rgba(86,170,240,0.66)' : 'rgba(44,130,210,0.66)')
          : (dark ? 'rgba(148,163,184,0.42)' : 'rgba(120,130,145,0.5)')
    return {
      source: e.source,
      target: e.target,
      value: e.weight,
      lineStyle: {
        width,
        opacity: edgeOpacityOf(e),
        color,
        curveness: settings.showArrows ? 0.2 : 0.08,
        ...(isWiki && stubIds.has(e.target) ? { type: 'dashed' as const } : {}),
      },
    }
  })

  // 力度滑杆 → echarts force 的近似映射(echarts 无 nodeGap/communitySeparation/attraction 独立项):
  // 节点间距/圈子分离度 → 放大全局斥力;相连节点的吸引力 → 反向缩放连线长度(越强拉得越近)。
  // 默认值时三者均归一为 1,不改变默认布局。
  const gapK = 0.35 + 0.65 * (settings.nodeGap / DEFAULT_GRAPH_SETTINGS.nodeGap)
  const commK = 0.5 + 0.5 * (settings.communitySeparation / DEFAULT_GRAPH_SETTINGS.communitySeparation)
  const attractK = Math.min(Math.max(settings.forceAttraction / DEFAULT_GRAPH_SETTINGS.forceAttraction, 0.5), 2)

  const categories = Array.from({ length: graph.communityCount }, (_, i) => ({
    name: `圈子 #${i + 1}`,
    itemStyle: { color: communityColor(i) },
  }))

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataType: string; data: { name?: string; value?: number; source?: string; target?: string; kind?: string; stub?: boolean; backLinks?: number; outLinks?: number } }) => {
        const d = p.data
        if (p.dataType !== 'node') return `${d.source ?? ''} ↔ ${d.target ?? ''} · ${d.value ?? 0}`
        if (d.kind === 'note') return `${d.name ?? ''}<br/>笔记 · 出链 ${d.outLinks ?? 0} / 被引用 ${d.backLinks ?? 0}`
        if (d.stub === true || d.kind === 'stub') return `${d.name ?? ''}<br/>尚未创建的笔记（被引用 ${d.backLinks ?? 0} 次）`
        return `${d.name ?? ''}<br/>${d.value ?? 0} 条消息`
      },
      backgroundColor: tokenColor('--dsw-alias-tooltip-bg'),
      borderColor: tokenColor('--nm-cyan', 0.4),
      textStyle: { color: tokenColor('--nm-text-1') },
    },
    legend: {
      data: categories.map(c => c.name),
      top: 4,
      left: 'left',
      textStyle: { color: dark ? 'rgba(200,255,255,0.8)' : 'rgba(30,40,52,0.85)' },
      icon: 'circle',
      itemGap: 6,
    },
    series: [{
      type: 'graph',
      layout: 'force',
      animation: false,
      roam: true,
      roamTrigger: 'global',
      scaleLimit: { max: 5, min: 0.4 },
      categories,
      draggable: !settings.lockLayout,
      force: {
        // 密度自适应:节点越多斥力越强、连线越长,图铺得更开以减少重叠。
        repulsion: settings.forceRepulsion * 90 * Math.min(density, 5) * gapK * commK,
        edgeLength: settings.forceEdgeLength * 40 * (0.9 + 0.4 * Math.min(density - 1, 2)) / attractK,
        gravity: settings.forceCentripetal * 0.12,
        // 适中阻尼:拖拽时邻居快速稳定、不过度回弹;瞬时收敛让布局一次定稿,节点不再持续漂移。
        friction: 0.5,
        layoutAnimation: false,
      },
      label: {
        show: settings.showLabels,
        position: 'right',
        color: labelColor,
        fontSize: 11,
        formatter: '{b}',
      },
      edgeSymbol: settings.showArrows ? ['arrow', 'arrow'] : undefined,
      edgeSymbolSize: 8,
      lineStyle: { width: Math.max(0.3, settings.edgeWidth) },
      labelLayout: { hideOverlap: true },
      data: nodes,
      links,
      emphasis: {
        focus: 'adjacency',
        // 收敛灵敏度:悬停不放大节点,避免密集图谱上扫过时一直「跳」。
        scale: false,
        lineStyle: { width: 3 },
        label: { show: true, color: '#fff' },
      },
      blur: {
        lineStyle: { opacity: 0.08 },
        itemStyle: { opacity: 0.28 },
        label: { opacity: 0 },
      },
    }],
  }
}

/** ECharts 内部 model 的窄化类型(仅用于读取力导向布局坐标;公开 API 无「按节点居中」动作)。 */
interface EChartModelAccess {
  getModel: () => {
    getSeriesByIndex: (i: number) => {
      getData: () => {
        getItemLayout: (i: number) => [number, number] | { x: number; y: number }
      }
    } | null
  } | null
}

/** 读取 graph 序列中某节点布局坐标(view 变换前的数据坐标)。 */
function nodeLayout(chart: echarts.ECharts, id: string, indexMap: Map<string, number>): [number, number] | null {
  const idx = indexMap.get(id)
  if (idx === undefined) return null
  const model = (chart as unknown as EChartModelAccess).getModel()
  const seriesModel = model?.getSeriesByIndex(0)
  const data = seriesModel?.getData()
  const layout = data?.getItemLayout(idx)
  if (Array.isArray(layout)) return [layout[0], layout[1]]
  if (layout && typeof layout.x === 'number' && typeof layout.y === 'number') return [layout.x, layout.y]
  return null
}

/** 在离屏容器按目标画幅/风格/渲染器重绘图谱,返回 data URL(SVG 时返回 SVG 字符串)。 */
async function exportChartOffscreen(
  graph: BuiltGraph,
  settings: GraphSettings,
  dark: boolean,
  avatars: Map<string, string>,
  ratio: PosterRatio,
  style: PosterStyle,
  renderer: 'canvas' | 'svg',
): Promise<string> {
  const { width, height } = EXPORT_SIZES[ratio]
  const div = document.createElement('div')
  div.style.cssText = `position:fixed;left:-99999px;top:-99999px;width:${width}px;height:${height}px;`
  document.body.appendChild(div)
  const chart = echarts.init(div, undefined, { renderer })
  const option = buildOption(graph, settings, dark, avatars, { focusCommunity: null, hoverCommunity: null, pinnedIds: new Set() }) as {
    backgroundColor?: string
    tooltip?: unknown
    legend?: unknown
    series?: Array<{ animation?: boolean; force?: { layoutAnimation?: boolean } }>
  }
  option.backgroundColor = EXPORT_BG[style]
  option.tooltip = { show: false }
  option.legend = { show: false }
  if (option.series?.[0]) {
    option.series[0].animation = false
    if (option.series[0].force) option.series[0].force.layoutAnimation = false
  }
  chart.setOption(option)
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => { if (!settled) { settled = true; resolve() } }
    chart.on('finished', finish)
    window.setTimeout(finish, 1200)
  })
  let out = ''
  try {
    out = renderer === 'svg'
      ? decodeSvgDataUrl(chart.getDataURL({ type: 'svg', backgroundColor: EXPORT_BG[style] }))
      : chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: EXPORT_BG[style] })
  } finally {
    chart.dispose()
    div.remove()
  }
  return out
}

/** 把图谱绘制到一块离屏 canvas(海报图层的底层图谱)。 */
async function renderGraphLayerCanvas(
  graph: BuiltGraph,
  settings: GraphSettings,
  dark: boolean,
  avatars: Map<string, string>,
  style: PosterStyle,
): Promise<HTMLCanvasElement> {
  const width = 1280
  const height = 720
  const div = document.createElement('div')
  div.style.cssText = `position:fixed;left:-99999px;top:-99999px;width:${width}px;height:${height}px;`
  document.body.appendChild(div)
  const chart = echarts.init(div)
  const option = buildOption(graph, settings, dark, avatars, { focusCommunity: null, hoverCommunity: null, pinnedIds: new Set() }) as {
    backgroundColor?: string
    tooltip?: unknown
    legend?: unknown
    series?: Array<{ animation?: boolean; force?: { layoutAnimation?: boolean } }>
  }
  option.backgroundColor = EXPORT_BG[style]
  option.tooltip = { show: false }
  option.legend = { show: false }
  if (option.series?.[0]) {
    option.series[0].animation = false
    if (option.series[0].force) option.series[0].force.layoutAnimation = false
  }
  chart.setOption(option)
  let finishTimer = 0
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(finishTimer)
      resolve()
    }
    chart.on('finished', finish)
    finishTimer = window.setTimeout(finish, 1200)
  })
  let dataUrl = ''
  try {
    dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: EXPORT_BG[style] })
  } finally {
    // 即使导出抛错也必须回收：否则 ECharts 实例与临时挂到 body 的
    // 1280×720 容器会永久留在文档里。
    chart.dispose()
    div.remove()
  }
  const img = new Image()
  await new Promise<void>((resolve) => {
    img.onload = (): void => { resolve() }
    img.onerror = (): void => { resolve() }
    img.src = dataUrl
  })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth || width
  c.height = img.naturalHeight || height
  const ctx = c.getContext('2d')
  if (ctx) ctx.drawImage(img, 0, 0)
  return c
}

/**
 * Render the ECharts force graph.
 * @param props - graph / settings / callbacks.
 * @returns the chart container element.
 */
export const EchartsGraphCanvas = forwardRef<EchartsGraphCanvasHandle, EchartsGraphCanvasProps>(function EchartsGraphCanvas({
  graph, dark = false, selectedId, onSelect, settings, selfUsername, pinnedIds, focusCommunity, hoverCommunity, hoverNodeId, onHoverNode,
}: EchartsGraphCanvasProps, ref): React.JSX.Element {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const propsRef = useRef({ graph, dark, settings, onSelect, pinnedIds, focusCommunity, hoverCommunity, hoverNodeId, onHoverNode })
  const avatarsRef = useRef(new Map<string, string>())
  const idIndexRef = useRef(new Map<string, number>())
  const roRef = useRef<ResizeObserver | null>(null)
  const miniRef = useRef<HTMLCanvasElement | null>(null)
  const positionsRef = useRef<Map<string, GridPos>>(loadSavedPositions())

  propsRef.current = { graph, dark, settings, onSelect, pinnedIds, focusCommunity, hoverCommunity, hoverNodeId, onHoverNode }

  const onNodeClick = (params: unknown): void => {
    const p = params as { dataType?: string; data?: { id?: string } }
    if (p.dataType === 'node' && p.data?.id) propsRef.current.onSelect(p.data.id)
  }

  const applyFull = (): void => {
    const chart = chartRef.current
    const el = elRef.current
    if (!chart || !el) return
    const p = propsRef.current
    const option = buildOption(p.graph, p.settings, p.dark, avatarsRef.current, {
      focusCommunity: p.focusCommunity ?? null,
      hoverCommunity: p.hoverCommunity ?? null,
      hoverNodeId: p.hoverNodeId ?? null,
      pinnedIds: p.pinnedIds ?? new Set(),
      positions: positionsRef.current,
    })
    chart.setOption(option, { notMerge: true })
    // Keep an id → data index map for programmatic highlight / center.
    const series = option.series
    const nodes = Array.isArray(series) ? (series[0] as { data?: Array<{ id: string }> }).data ?? [] : []
    idIndexRef.current = new Map(nodes.map((n, i) => [n.id, i]))
    drawMinimap()
  }

  // 外观参数的 series 级刷新:不重发 data/links/layout/force,echarts 保留已布局位置,
  // 因此调整「连线粗细/文本透明度/全部标签/箭头」不再整图重排。
  const refreshCosmetic = (): void => {
    const chart = chartRef.current
    if (!chart) return
    const p = propsRef.current
    const labelColor = p.dark ? `rgba(200,255,255,${p.settings.labelOpacity})` : `rgba(30,40,52,${p.settings.labelOpacity})`
    chart.setOption({
      series: [{
        lineStyle: { width: Math.max(0.3, p.settings.edgeWidth) },
        edgeSymbol: p.settings.showArrows ? ['arrow', 'arrow'] : undefined,
        label: { show: p.settings.showLabels, color: labelColor },
      }],
    } as unknown as echarts.EChartsCoreOption, { notMerge: false })
  }

  // 圈子聚焦/悬停淡出 + 节点固定:逐节点合并更新,不重发布局/连线,保留已摆放位置。
  const refreshDim = (): void => {
    const chart = chartRef.current
    if (!chart) return
    const p = propsRef.current
    const hoverId = p.hoverNodeId ?? null
    const hoverNbrs = hoverId ? neighboursOf(p.graph, hoverId) : null
    const view = { focusCommunity: p.focusCommunity ?? null, hoverCommunity: p.hoverCommunity ?? null, hoverNodeId: hoverId, pinnedIds: p.pinnedIds ?? new Set() }
    const data = p.graph.nodes.map((n) => {
      const rec: Record<string, unknown> = { id: n.id }
      if (view.pinnedIds.has(n.id)) rec.fixed = true
      let op = 1
      if (hoverId != null) op = n.id === hoverId || hoverNbrs?.has(n.id) ? 1 : 0.15
      else op = dimOpacity(n.community, view.focusCommunity, view.hoverCommunity)
      // stub 的半透明是本体的固有外观，不是「被淡出」，必须在这里同样乘上：
      // setOption 是合并语义，这里写 op=1 会把 nodeItem 给的 0.6 直接盖掉，
      // 表现为「hover 过一次之后，stub 就不再是半透明了」。
      const eff = op * (n.stub === true || n.kind === 'stub' ? 0.6 : 1)
      if (eff !== 1) rec.itemStyle = { opacity: eff }
      return rec
    })
    const maxLinks = Math.max(180, Math.min(p.graph.edges.length, Math.round(p.graph.nodes.length * 0.9)))
    const links = p.graph.edges.slice(0, maxLinks).map((e) => ({
      source: e.source,
      target: e.target,
      lineStyle: {
        opacity: hoverId == null ? 1 : (e.source === hoverId || e.target === hoverId ? 1 : 0.12),
      },
    }))
    chart.setOption({ series: [{ data, links }] }, { notMerge: false })
  }

  // 小地图:读取力导向布局坐标 → 总览缩略图 + 点击跳转视图。
  const miniLayouts = (): Array<{ id: string; x: number; y: number }> => {
    const chart = chartRef.current
    if (!chart) return []
    const indexMap = idIndexRef.current
    const out: Array<{ id: string; x: number; y: number }> = []
    for (const n of propsRef.current.graph.nodes) {
      const pos = nodeLayout(chart, n.id, indexMap)
      if (pos) out.push({ id: n.id, x: pos[0], y: pos[1] })
    }
    return out
  }
  const miniTransform = (layouts: Array<{ x: number; y: number }>):
    { minX: number; minY: number; s: number; ox: number; oy: number } | null => {
    if (layouts.length === 0) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const l of layouts) {
      minX = Math.min(minX, l.x)
      maxX = Math.max(maxX, l.x)
      minY = Math.min(minY, l.y)
      maxY = Math.max(maxY, l.y)
    }
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const mini = miniRef.current
    const W = mini?.width ?? 148
    const H = mini?.height ?? 96
    const pad = 8
    const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
    const ox = pad + (W - pad * 2 - spanX * s) / 2
    const oy = pad + (H - pad * 2 - spanY * s) / 2
    return { minX, minY, s, ox, oy }
  }
  const drawMinimap = (): void => {
    const mini = miniRef.current
    const ctx = mini?.getContext('2d')
    if (!mini || !ctx) return
    const W = mini.width
    const H = mini.height
    ctx.clearRect(0, 0, W, H)
    const layouts = miniLayouts()
    const t = miniTransform(layouts)
    if (!t) return
    const graphNodes = propsRef.current.graph.nodes
    const byId = new Map(graphNodes.map(n => [n.id, n]))
    const px = (x: number) => t.ox + (x - t.minX) * t.s
    const py = (y: number) => t.oy + (y - t.minY) * t.s
    ctx.strokeStyle = 'rgba(128,144,166,0.18)'
    ctx.lineWidth = 0.5
    const posById = new Map(layouts.map(l => [l.id, l]))
    for (const e of propsRef.current.graph.edges) {
      const a = posById.get(e.source)
      const b = posById.get(e.target)
      if (!a || !b) continue
      ctx.beginPath()
      ctx.moveTo(px(a.x), py(a.y))
      ctx.lineTo(px(b.x), py(b.y))
      ctx.stroke()
    }
    for (const l of layouts) {
      const n = byId.get(l.id)
      const r = Math.max(1.4, Math.min(4.5, 1.4 + (n?.weight ?? 0) / 600))
      ctx.beginPath()
      ctx.arc(px(l.x), py(l.y), r, 0, Math.PI * 2)
      ctx.fillStyle = n ? communityColor(n.community) : '#9aa0a6'
      ctx.fill()
    }
  }
  const onMiniClick = (ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const mini = miniRef.current
    if (!mini) return
    const rect = mini.getBoundingClientRect()
    const layouts = miniLayouts()
    const t = miniTransform(layouts)
    if (!t) return
    const px = ((ev.clientX - rect.left) - t.ox) / t.s + t.minX
    const py = ((ev.clientY - rect.top) - t.oy) / t.s + t.minY
    chartRef.current?.setOption({ series: [{ center: [px, py], zoom: 1.1 }] })
  }

  // 头像加载完成后局部更新 symbol,不重跑力导向(位置保持)。
  const refreshAvatars = (): void => {
    const chart = chartRef.current
    if (!chart) return
    const avatars = avatarsRef.current
    const data: Array<Record<string, unknown>> = []
    for (const n of propsRef.current.graph.nodes) {
      const url = avatars.get(n.id)
      if (url) data.push({ id: n.id, symbol: `image://${url}` })
    }
    if (data.length === 0) return
    chart.setOption({ series: [{ data }] }, { notMerge: false })
  }

  // 布局落定后读取节点坐标并持久化,下次进入原地恢复。
  const capturePositions = (): void => {
    const chart = chartRef.current
    if (!chart) return
    const map = new Map<string, GridPos>()
    for (const n of propsRef.current.graph.nodes) {
      const pos = nodeLayout(chart, n.id, idIndexRef.current)
      if (pos) map.set(n.id, { x: pos[0], y: pos[1] })
    }
    if (map.size === 0) return
    positionsRef.current = map
    savePositions(map)
  }

  // Create the chart once; re-apply on structural changes (graph/params/theme).
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const chart = echarts.init(el, undefined, { renderer: 'canvas', useDirtyRect: true })
    chartRef.current = chart
    chart.on('click', onNodeClick)
    chart.on('mouseover', (params: unknown) => {
      const id = (params as { data?: { id?: string } })?.data?.id
      if (id) propsRef.current.onHoverNode?.(id)
    })
    chart.on('mouseout', () => { propsRef.current.onHoverNode?.(null) })
    const ro = new ResizeObserver(() => { chart.resize() })
    ro.observe(el)
    roRef.current = ro
    applyFull()
    chart.on('finished', () => { drawMinimap(); capturePositions() })
    return () => {
      roRef.current?.disconnect()
      roRef.current = null
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  // 结构性变化(图/主题/力度参数)整体重建(重排);外观 series 级参数走局部刷新,不重排。
  const forceKey = `${settings.forceCentripetal}|${settings.forceRepulsion}|${settings.forceAttraction}|${settings.forceEdgeLength}|${settings.nodeGap}|${settings.communitySeparation}|${settings.lockLayout}`
  useEffect(() => { applyFull() }, [graph, dark, forceKey])
  useEffect(() => { refreshCosmetic() }, [settings.edgeWidth, settings.labelOpacity, settings.showLabels, settings.showArrows])
  // 固定/圈子聚焦/悬停高亮走局部节点合并,不整图重排。
  useEffect(() => { refreshDim() }, [pinnedIds, focusCommunity, hoverCommunity, hoverNodeId])
  // nodeScale/blurNodes 需逐节点更新,echarts 无法不重排;走全量(布局近似保持)。
  useEffect(() => { applyFull() }, [settings.nodeScale, settings.blurNodes])

  // Selection via ECharts highlight action — keeps the force layout stable.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.dispatchAction({ type: 'downplay', seriesIndex: 0 })
    if (selectedId) {
      const idx = idIndexRef.current.get(selectedId)
      if (idx !== undefined) {
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx })
      }
    }
  }, [selectedId])

  // Load avatars for displayed nodes; re-apply once they settle. Remounts restore
  // circular symbols from the in-memory cache (avoiding a reload) and still refresh.
  useEffect(() => {
    let alive = true
    const avatarIdOf = (n: GNode): string => (n.id === 'self' ? (selfUsername ?? '') : n.id)
    // 先从缓存回填 avatarsRef(重新进入时避免头像丢为纯色圆点),再对缺失的发起拉取。
    for (const n of graph.nodes) {
      const id = avatarIdOf(n)
      if (!id) continue
      const raw = avatarCache.get(id)
      if (!raw) continue
      const circular = circleCache.get(raw) ?? raw
      avatarsRef.current.set(n.id, circular)
    }
    // 仅加载权重最高的 60 个节点头像(与画布头像渲染预算一致),其余纯色圆点;
    // 大幅减少头像 RPC/内存占用,大图更快。
    const topAvatarIds = new Set(
      [...graph.nodes]
        // 知识节点没有头像：不排除的话它们会凭 weight 挤进前 60，
        // 然后对 'note:1' / 'kb:xxx' 这种伪用户名发起 getAvatar RPC（必然失败）。
        .filter(n => n.kind !== 'note' && n.kind !== 'stub' && n.stub !== true)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 60)
        .map(n => n.id),
    )
    topAvatarIds.add('self')
    const missing = graph.nodes.filter(n => topAvatarIds.has(n.id)).map(avatarIdOf).filter(id => id && !avatarCache.has(id))
    if (missing.length === 0) {
      refreshAvatars()
      return () => { alive = false }
    }
    void mapLimit(missing, AVATAR_CONCURRENCY, async (id) => {
      const url = await loadAvatar(id)
      if (url) {
        const circular = await circleAvatarUrl(url)
        avatarsRef.current.set(id === selfUsername ? 'self' : id, circular)
      }
    }).then(() => { if (alive) refreshAvatars() })
    return () => { alive = false }
  }, [graph, selfUsername])

  useImperativeHandle(ref, () => ({
    fitView: () => { applyFull() },
    centerOn: (id: string) => {
      const chart = chartRef.current
      if (!chart) return
      const pos = nodeLayout(chart, id, idIndexRef.current)
      if (pos) chart.setOption({ series: [{ center: pos, zoom: 1.1 }] })
      const idx = idIndexRef.current.get(id)
      if (idx !== undefined) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx })
    },
    runAnimation: () => { applyFull() },
    relayout: () => { applyFull() },
    exportSvg: () => {
      const p = propsRef.current
      return exportChartOffscreen(p.graph, p.settings, p.dark, avatarsRef.current, '1:1', p.dark ? 'dark' : 'light', 'svg')
    },
    exportPng: (ratio, style) => {
      const p = propsRef.current
      return exportChartOffscreen(p.graph, p.settings, p.dark, avatarsRef.current, ratio, style, 'canvas')
    },
    renderPoster: async (ratio, style) => {
      const p = propsRef.current
      const graph = p.graph
      const topFriends = [...graph.nodes]
        .filter(n => n.kind !== 'self')
        .sort((a, b) => (b.intimacy ?? 0) - (a.intimacy ?? 0) || b.weight - a.weight)
        .slice(0, 5)
      const topRelations: PosterRelation[] = []
      for (const n of topFriends) {
        const sprite = await dataUrlToSprite(avatarsRef.current.get(n.id) ?? '')
        topRelations.push({ name: n.label, msg: Math.round(n.intimacy ?? n.weight), sprite })
      }
      const communities: PosterCommunity[] = groupCommunities(graph).slice(0, 8).map(c => ({
        color: communityColor(c.id),
        count: c.members.length,
        names: c.members.slice(0, 2).map(m => m.label).join('、'),
      }))
      const stats: PosterStatItem[] = [
        { label: '节点', value: String(graph.nodes.length) },
        { label: '连线', value: String(graph.edges.length) },
        { label: '圈子', value: String(graph.communityCount) },
      ]
      const graphLayer = await renderGraphLayerCanvas(graph, p.settings, p.dark, avatarsRef.current, style)
      const input: PosterInput = {
        graphLayer,
        ratio,
        style,
        tag: '社交关系图谱',
        title: '我的微信社交圈',
        subtitle: '基于本地消息数据 · 圈子洞察',
        stats,
        topRelations,
        communities,
        blurNodes: p.settings.blurNodes,
        legend: '颜色 = 圈子 · 灰线 = 共同群数 · 蓝线 = 与我亲密度 · 半径 = 消息量',
        footer: `由 DSH 本地生成 · ${new Date().toLocaleDateString()}`,
        scale: 2,
      }
      const canvas = buildPoster(input)
      return posterToDataUrl(canvas, 'jpeg')
    },
  }), [dark])

  const gridBg = settings.showGrid
    ? (dark
      ? 'radial-gradient(circle at 1px 1px, rgba(150,170,190,0.12) 1px, transparent 0) 0 0 / 24px 24px'
      : 'radial-gradient(circle at 1px 1px, rgba(70,90,110,0.14) 1px, transparent 0) 0 0 / 24px 24px')
    : undefined

  return (
    <>
      <div ref={elRef} className={css.ecCanvas} style={gridBg ? { background: gridBg } : undefined} />
      <canvas ref={miniRef} className={css.minimap} aria-label="图谱小地图" onPointerDown={onMiniClick} onContextMenu={(ev) => { ev.preventDefault() }} />
    </>
  )
})
