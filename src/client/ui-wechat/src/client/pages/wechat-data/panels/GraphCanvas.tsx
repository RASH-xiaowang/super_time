/**
 * 图谱画布（React 壳）：接管 ResizeObserver / 指针交互 / 相机 / 头像加载 / 布局调度 / 导出。
 *
 * 分工：绘制与相机数学在 `graph-canvas.ts`（纯函数、可单测），布局在 `graph-layout.ts`
 * （FA2 + Worker + 指纹缓存），本文件只做「把两者接到 React 与事件上」。
 *
 * 对外契约（`GraphCanvasHandle` 与同名 props）与改前的 `EchartsGraphCanvas.tsx` 完全一致，
 * 面板 `Graph.tsx` 只换 import —— 换掉画布实现不该顺带改动面板的行为面。
 *
 * 四处**有意的**行为差异（原因都在对应代码处展开）：
 *   ① 头像是批量拉取（`apiGetAvatarsLocal` 一次请求）而不是逐节点 60 次 RPC；
 *   ② 「适应视图」只动相机，不重排布局；
 *   ③ 「重新布局」从确定性初值重算（`runLayout({fresh:true})`），否则按下去画面不会变；
 *   ④ 悬停命中测试在 rAF 帧里做一次，而不是每个 mousemove 事件都扫一遍节点。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { apiGetAvatarsLocal } from '../api.ts'
import { createRestartableTimer, type RestartableTimer } from './timers.ts'
import { loadSavedPositions, runLayout, savePositions, type GridPos } from './graph-layout.ts'
import { SELF_ID, communityColor, groupCommunities, neighboursOf, type BuiltGraph, type GNode, type GraphSettings } from './graph-model.ts'
import {
  avatarBudget,
  avatarCandidates,
  buildRevealPlan,
  decodeAvatar,
  drawHoverBubble,
  drawScene,
  fitCamera,
  graphTheme,
  hasAvatar,
  nodeRadius,
  pickNode,
  relaxCollisions,
  revealProgressMap,
  sceneToSvg,
  screenToWorld,
  spacingScale,
  zoomAt,
  type AvatarAsset,
  type Camera,
  type Point,
  type RevealPlan,
  type Scene,
  type ViewSize,
} from './graph-canvas.ts'
import {
  DEFAULT_PHYSICS,
  anchorNodes,
  createPhysicsWorld,
  physicsMaxStep,
  pinAt,
  stepPhysics,
  syncPhysicsToPositions,
  syncPositionsToPhysics,
  type PhysicsWorld,
} from './graph-physics.ts'
import { buildPoster, posterToDataUrl, type PosterCommunity, type PosterInput, type PosterRatio, type PosterRelation, type PosterStatItem, type PosterStyle } from './graph-poster.ts'
import css from './graph.module.css'

/**
 * 空集合常量。
 *
 * 必须提到模块级：`new Set()` 放在 JSX 或回调里会让 `pinnedIds` 每次渲染都是新引用，
 * 于是所有以它为依赖的 effect（重画、布局）每帧都触发一次 —— 表现为「什么都不做也在满帧重绘」。
 */
const EMPTY_SET: ReadonlySet<string> = new Set()

/** 布局输入的稳定指纹：只有六个力度滑杆变化才需要重排，其余设置只影响外观。 */
function forceKeyOf(s: GraphSettings): string {
  return [s.forceCentripetal, s.forceRepulsion, s.forceAttraction, s.forceEdgeLength, s.nodeGap, s.communitySeparation].join('|')
}

/** 布局重排的静默期：拖力度滑杆会连发几十次 change，合并到最后一次再算。 */
const RELAYOUT_SETTLE_MS = 120
/** 节点坐标落盘的静默期：拖拽节点时逐帧写 localStorage 会把主线程拖死（改前 L8 的老问题）。 */
const PERSIST_SETTLE_MS = 300
/**
 * 坐标表条数上限。社交图谱与知识图谱共用一份持久化坐标，落盘时不再按当前图裁剪
 * （见 `positionsForPersist` 的说明），因此需要一个上限防止长期使用后无限增长。
 */
const POSITION_CACHE_MAX = 6000

/** 导出画幅像素（按比例）。与改前一致。 */
const EXPORT_SIZES: Record<PosterRatio, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '16:9': { width: 1920, height: 1080 },
}

/** 导出背景色（按风格）。 */
const EXPORT_BG: Record<PosterStyle, string> = {
  light: '#fafafa',
  dark: '#0a1025',
  neon: '#05010f',
}

/**
 * 导出的主题明暗跟着**导出风格**走，而不是当前界面主题。
 *
 * 改前是「界面主题决定节点配色、导出风格只改背景」，于是「浅日背景 + 深色界面」会导出
 * 一张浅底浅字的图，几乎看不见。用户挑风格时想要的就是那个风格的成品。
 * @param style - 导出风格。
 * @returns 是否用深色主题。
 */
function styleIsDark(style: PosterStyle): boolean {
  return style !== 'light'
}

/**
 * 头像资源缓存：跨挂载共享（切走再切回不用重新拉取）。
 * 键是头像主人（username；「我」用真实 wxid），值是原始 data URL + 已裁圆的 sprite。
 */
const avatarAssets = new Map<string, AvatarAsset>()

/** 小地图的世界 → 小地图坐标映射（每帧刷新），供点击跳转使用。 */
type MiniTransform = { minX: number; minY: number; s: number; ox: number; oy: number }

export interface GraphCanvasHandle {
  fitView: () => void
  centerOn: (id: string) => void
  runAnimation: () => void
  relayout: () => void
  exportSvg: () => Promise<string>
  exportPng: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
  renderPoster: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
}

interface GraphCanvasProps {
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

/** 指针拖拽状态：节点拖拽与画布平移共用一条状态机，免得两套事件处理互相打架。 */
interface DragState {
  kind: 'node' | 'pan'
  /** 节点拖拽的目标节点 id（kind === 'node' 时必有）。 */
  id?: string
  /** 按下时指针相对于节点中心的世界坐标偏移，保证拖动时节点不「跳」到指针下。 */
  grabDx: number
  grabDy: number
  /** 按下时的相机位置（平移用）。 */
  camX: number
  camY: number
  /** 按下时的指针屏幕位置（用来区分「点击」与「拖拽」）。 */
  startX: number
  startY: number
  /** 是否已真正移动过。 */
  moved: boolean
}

/**
 * 拖拽期的物理模拟状态（模型说明见 `graph-physics.ts`）。
 *
 * 与上一版「位移按比例传播」的本质区别：坐标由**物理积分**拥有 —— 弹簧有张力、节点有惯性，
 * 松手之后整张图还会自己继续收敛。所以这里保存的是世界本身，而不是一份「目标位移」。
 */
interface DragSimState {
  world: PhysicsWorld
  /** 被拖节点。 */
  id: string
  /** 指针换算出的目标世界坐标（含按下时的抓取偏移）。 */
  target: Point
  /** 松手时刻（performance.now()）；0 = 仍在拖。 */
  releasedAt: number
}

/**
 * 松手后的收敛窗口。
 *
 * 期间阻尼逐渐加重，让图**平滑**停下来 —— 到点硬停会让「图还在自己慢慢挪」变成
 * 「时间一到突然定住」，那一眼就看得出是假的。
 */
const SETTLE_MS = 1600
/** 判定「已经静止」的每步最大位移（世界单位/子步）。0.08 ≈ 5 单位/秒，肉眼不可辨。 */
const REST_STEP = 0.08

/**
 * 渲染图谱画布。
 * @param props - graph / settings / 交互回调。
 * @param ref - 命令式句柄（适应视图 / 居中 / 重排 / 导出）。
 * @returns 画布 + 小地图。
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(props, ref): React.JSX.Element {
  const { graph, dark = false, selectedId, settings, selfUsername, pinnedIds, focusCommunity, hoverCommunity, hoverNodeId } = props

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const miniRef = useRef<HTMLCanvasElement | null>(null)
  /** rAF 与事件回调里读最新 props：避免每个回调都随 props 重建（那会连锁触发所有 effect）。 */
  const propsRef = useRef(props)
  propsRef.current = props

  /** 节点坐标（可变：拖拽直接改它）。初值取上次落盘的布局，进面板即原地恢复。 */
  const positionsRef = useRef<Map<string, Point>>(new Map(loadSavedPositions()))
  const radiiRef = useRef<Map<string, number>>(new Map())
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 })
  const sizeRef = useRef<ViewSize>({ w: 0, h: 0 })
  const dprRef = useRef(1)
  const frameRef = useRef(0)
  /** 指针位置（canvas 本地 CSS 像素）；命中测试在 rAF 帧里做一次，而不是每个 move 事件都扫节点。 */
  const pointerRef = useRef<Point | null>(null)
  const dragRef = useRef<DragState | null>(null)
  /** 拖拽物理状态：松手后仍会保留一段时间用于收敛，因此与 `dragRef` 分开存。 */
  const simRef = useRef<DragSimState | null>(null)
  /** 首次布局完成后自动适应视图；之后不再抢用户的视角。 */
  const needsFitRef = useRef(true)
  const animRef = useRef<{ from: Camera; to: Camera; t0: number; dur: number } | null>(null)
  /** 进行中的出现动画（时间表 + 起点时刻）；`null` 表示没有动画，节点全亮。 */
  const revealRef = useRef<{ plan: RevealPlan; t0: number } | null>(null)
  const layoutTimerRef = useRef<RestartableTimer | null>(null)
  const persistTimerRef = useRef<RestartableTimer | null>(null)
  /** 已发出过头像请求的 username（含请求中）：避免重复拉取。 */
  const avatarAskedRef = useRef(new Set<string>())
  /** 组件是否仍挂载。头像解码是异步的，回来时组件可能已经切走了（见头像 effect 的说明）。 */
  const mountedRef = useRef(true)
  const minimapRef = useRef<MiniTransform | null>(null)
  /**
   * 布局请求序号：每次发起 +1，回来时对不上就丢弃。
   *
   * 为什么不用「比较 graph 引用」：连续改两次力度参数时，第二次的请求可能先回来，
   * 于是第一次的陈旧结果会盖掉新的 —— 表现是「滑杆拖回去之后图又跳回上一档的形状」。
   */
  const layoutSeqRef = useRef(0)

  const nodeCount = graph.nodes.length

  /** 半径表：随图与 nodeScale 变；画布逐节点读取，所以拖「节点大小」滑杆不必重建整张图。 */
  const radii = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of graph.nodes) m.set(n.id, nodeRadius(n, settings, nodeCount))
    return m
  }, [graph, settings.nodeScale, nodeCount])
  radiiRef.current = radii

  /** 节点 → 头像主人。知识节点没有头像（拿 'note:1' 这种伪用户名去查必然失败）。 */
  const avatarIdOf = useCallback((n: GNode): string => {
    if (!hasAvatar(n)) return ''
    return n.id === 'self' ? (selfUsername ?? '') : n.id
  }, [selfUsername])

  const hoverNeighbours = useMemo(
    () => (hoverNodeId ? neighboursOf(graph, hoverNodeId) : null),
    [graph, hoverNodeId],
  )
  /**
   * 悬停邻居通过 ref 交给 `buildScene` 读取，而**不是**作为它的 useCallback 依赖。
   *
   * 这是一处必须刻意断开的数据依赖：`paint → scheduleFrame → fitView → relayoutNow`
   * 是一条 useCallback 依赖链，而 relayoutNow 挂在「布局重排」的 effect 上。
   * 只要链上任何一环依赖了悬停/选中这类高频 state，**鼠标扫过节点就会触发整图重排** ——
   * 症状是「拖到一半的节点被 120ms 后的重排结果冲回原位」，而且看起来像拖拽功能坏了。
   * （真机探针实测过：拖拽后 localStorage 里 0 个坐标变化，就是这条链导致的。）
   */
  const hoverNeighboursRef = useRef<ReadonlySet<string> | null>(null)
  hoverNeighboursRef.current = hoverNeighbours

  /** 已解码的 sprite 表（键为头像主人）。 */
  const spriteMap = useCallback((): Map<string, HTMLCanvasElement> => {
    const out = new Map<string, HTMLCanvasElement>()
    for (const [username, asset] of avatarAssets) {
      if (asset.sprite) out.set(username, asset.sprite)
    }
    return out
  }, [])

  /** 组装场景：屏幕绘制、SVG 导出、离屏导出共用同一份口径。 */
  const buildScene = useCallback((opts: {
    positions: ReadonlyMap<string, Point>
    radii: ReadonlyMap<string, number>
    sprites: ReadonlyMap<string, HTMLCanvasElement>
    camera: Camera
    size: ViewSize
    isDark: boolean
    /** 是否带上悬停状态（导出时关掉，避免把「导出时鼠标正好停在某个节点上」烘进成品） */
    interactive: boolean
    /**
     * 出现动画的当前进度。**导出路径一律不传** —— 成品图必须是完整的，
     * 不能有「还没长出来」的节点（默认 `null` 即全部按 1 画）。
     */
    reveal?: ReadonlyMap<string, number> | null
  }): Scene => {
    const p = propsRef.current
    return {
      nodes: p.graph.nodes,
      edges: p.graph.edges,
      positions: opts.positions,
      radii: opts.radii,
      sprites: opts.sprites,
      avatarIdOf,
      camera: opts.camera,
      size: opts.size,
      dark: opts.isDark,
      settings: p.settings,
      selectedId: p.selectedId,
      hoverNodeId: opts.interactive ? (p.hoverNodeId ?? null) : null,
      hoverNeighbours: opts.interactive ? hoverNeighboursRef.current : null,
      pinnedIds: p.pinnedIds ?? EMPTY_SET,
      focusCommunity: opts.interactive ? (p.focusCommunity ?? null) : null,
      hoverCommunity: opts.interactive ? (p.hoverCommunity ?? null) : null,
      reveal: opts.reveal ?? null,
    }
  }, [avatarIdOf])

  /**
   * 落盘用的坐标快照（形状与改前一致：`Record<id, {x,y}>`）。
   *
   * 为什么**不**剔除「当前图里没有的节点」：社交图谱与知识图谱是两个并列面板，共用这一份
   * localStorage。改前（以及本次重写的第一版）会在落盘时按当前图裁剪，于是「进一次知识图谱」
   * 就把 251 个好友的坐标全删了 —— 回到社交图谱时布局从零重算，用户手动拖过的位置也一并丢掉。
   * 代价是坐标表会随浏览过的图累积，因此按条数封顶（Map 的插入顺序即先后，超限时丢最早的那批）。
   */
  const positionsForPersist = useCallback((): Map<string, GridPos> => {
    const out = new Map<string, GridPos>()
    const all = [...positionsRef.current]
    const keep = all.length > POSITION_CACHE_MAX ? all.slice(all.length - POSITION_CACHE_MAX) : all
    // 坐标取整再落盘：节点坐标是逻辑单位，小数位对画面没有任何影响（相机把它们缩放到像素，
    // 亚像素差异看不出来），但一条记录能从 `{"x":-1234.5678901234567,"y":1234.5678901234567}`
    // 的 ~50 字符压到 ~20 字符 —— 真机实测渲染进程的 localStorage 会被消息缓存占到写不进新键，
    // 这层压缩直接决定了「节点上限拉到全部」之后布局还能不能存下来。
    for (const [id, p] of keep) out.set(id, { x: Math.round(p.x), y: Math.round(p.y) })
    return out
  }, [])

  /**
   * 小地图：把全部坐标按比例缩进右下角的小画布，并画出**当前视口矩形**。
   *
   * 改前的小地图只有节点点阵、没有视口框 —— 用户看不出「我现在在图谱的哪一块」，
   * 而那恰是小地图存在的理由；补上视口框后点击跳转才有参照。
   */
  const drawMinimap = useCallback((scene: Scene): void => {
    const mini = miniRef.current
    const mctx = mini?.getContext('2d')
    if (!mini || !mctx) return
    const dpr = dprRef.current
    const W = mini.width / dpr
    const H = mini.height / dpr
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    mctx.clearRect(0, 0, W, H)
    const nodes = scene.nodes
    if (nodes.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      const p = scene.positions.get(n.id)
      if (!p) continue
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    if (!Number.isFinite(minX)) return
    const pad = 6
    const spanX = Math.max(1e-6, maxX - minX)
    const spanY = Math.max(1e-6, maxY - minY)
    const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
    const ox = pad + (W - pad * 2 - spanX * s) / 2
    const oy = pad + (H - pad * 2 - spanY * s) / 2
    minimapRef.current = { minX, minY, s, ox, oy }
    const px = (x: number): number => ox + (x - minX) * s
    const py = (y: number): number => oy + (y - minY) * s
    mctx.globalAlpha = 0.8
    for (const n of nodes) {
      const p = scene.positions.get(n.id)
      if (!p) continue
      mctx.beginPath()
      mctx.arc(px(p.x), py(p.y), Math.max(1, Math.min(3, (scene.radii.get(n.id) ?? 8) * s)), 0, Math.PI * 2)
      mctx.fillStyle = n.community >= 0 ? communityColor(n.community) : 'rgba(150,160,180,0.7)'
      mctx.fill()
    }
    mctx.globalAlpha = 1
    // 视口框：当前相机看到的世界矩形
    const cam = scene.camera
    const halfW = scene.size.w / 2 / cam.k
    const halfH = scene.size.h / 2 / cam.k
    mctx.strokeStyle = 'rgba(34,211,238,0.85)'
    mctx.lineWidth = 1
    mctx.strokeRect(px(cam.x - halfW), py(cam.y - halfH), halfW * 2 * s, halfH * 2 * s)
  }, [])

  /** 指针下的节点（世界坐标命中测试）。拖拽过程中不做命中，避免悬停状态跟着手抖。 */
  const hoverHit = useCallback((): string | null => {
    const lp = pointerRef.current
    if (!lp || dragRef.current) return null
    const p = propsRef.current
    const world = screenToWorld(camRef.current, sizeRef.current, lp.x, lp.y)
    return pickNode(p.graph.nodes, positionsRef.current, n => radiiRef.current.get(n.id) ?? 8, camRef.current, world.x, world.y)
  }, [])

  /**
   * 画一帧：清屏 → 场景 → 悬停气泡 → 小地图。
   *
   * 悬停命中测试放在这里（而不是 pointermove 回调）的理由：一帧只算一次；移动事件一秒
   * 可以来几百条，逐条扫节点在几千节点的图上会明显掉帧。命中结果变化时才回调 React，
   * 因此这个「帧里 setState」会在一两帧内收敛，不会自激。
   */
  const paint = useCallback((): void => {
    frameRef.current = 0
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { w, h } = sizeRef.current
    if (w <= 0 || h <= 0) return
    const p = propsRef.current
    // 拖拽跟随 + 碰撞都放在 rAF 帧里推进（不在 pointermove 里做）：
    // 高采样率鼠标一秒几百次 move，逐次做既白烧主线程，又让手感随鼠标轮询率变化。
    const sim = simRef.current
    if (sim) {
      const now = performance.now()
      // 被拖节点钉在指针上（速度恒 0）；固定节点在建世界时已锚定
      pinAt(sim.world, sim.id, sim.target.x, sim.target.y)
      // 松手后阻尼逐渐加重：让图平滑停下来，而不是到点硬停（硬停一眼看得出是假的）
      let damping = DEFAULT_PHYSICS.damping
      if (sim.releasedAt > 0) {
        const progress = Math.min(1, (now - sim.releasedAt) / SETTLE_MS)
        damping = DEFAULT_PHYSICS.damping * (1 - 0.7 * progress)
      }
      for (let i = 0; i < DEFAULT_PHYSICS.substeps; i++) stepPhysics(sim.world, { damping })
      syncPhysicsToPositions(sim.world, positionsRef.current)
      // 软碰撞只保证「大致推开」，硬性不重叠由 relaxCollisions 兜底；它改的是坐标表，
      // 必须再写回世界 —— 否则下一步的积分会拿旧坐标把碰撞结果覆盖掉（表现为怎么都推不开）。
      relaxCollisions(p.graph.nodes, positionsRef.current, radiiRef.current, { iterations: 2, skip: p.pinnedIds })
      syncPositionsToPhysics(sim.world, positionsRef.current)
      if (sim.releasedAt > 0) {
        const elapsed = now - sim.releasedAt
        if (physicsMaxStep(sim.world) < REST_STEP || elapsed > SETTLE_MS) {
          // 收敛完成：收掉残余重叠再落盘 —— 存下来的必须是不重叠的最终态。
          // 轮数给足：密集区里节点可能被夹在中间，雅可比松弛要好几轮才解得开
          // （真机实测 8 轮不够，收尾后仍有一对被挤在 7 单位处）。
          relaxCollisions(p.graph.nodes, positionsRef.current, radiiRef.current, { iterations: 24, skip: p.pinnedIds })
          simRef.current = null
          persistTimerRef.current?.restart()
        } else {
          scheduleFrame()
        }
      }
    }
    const nextHover = hoverHit()
    if (nextHover !== (p.hoverNodeId ?? null)) p.onHoverNode?.(nextHover)
    const dpr = dprRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // 出现动画的当前进度：每帧现算（250 个节点一次 Map 写入），不做缓存也没必要 ——
    // 「按 id 缓存 + 失效」在这一处会引入比它省下的开销更多的一致性风险。
    const rev = revealRef.current
    const scene = buildScene({
      positions: positionsRef.current,
      radii: radiiRef.current,
      sprites: spriteMap(),
      camera: camRef.current,
      size: sizeRef.current,
      isDark: p.dark ?? false,
      interactive: true,
      reveal: rev ? revealProgressMap(rev.plan, performance.now() - rev.t0) : null,
    })
    const drawn = drawScene(ctx, scene)
    const hovered = nextHover ? p.graph.nodes.find(n => n.id === nextHover) : undefined
    if (hovered && positionsRef.current.has(hovered.id)) drawHoverBubble(ctx, scene, hovered)
    drawMinimap(scene)
    // 实际画出的标签数：标签有贪心避重叠（密集图上多余的标签会被挤掉），
    // 因此「全部标签」开关是否真的多画了东西，只能看这个数（见 graph-canvas.spec.ts 的说明）。
    canvas.dataset.labels = String(drawn.labels.size)
    // 真正用头像位图画出来的节点数：用来区分「头像没拉到/被预算截掉」与「本地就没有头像数据」
    canvas.dataset.avatars = String(drawn.avatars)
    // 实际绘制的节点数：邻域深度过滤作用在传给画布的图上，而面板的统计条统计的是**完整**图，
    // 因此「深度过滤是否生效」只能看这个数（见 graph-canvas.wiring.spec.ts 的说明）。
    canvas.dataset.nodes = String(scene.nodes.length)
  }, [buildScene, drawMinimap, hoverHit, spriteMap])

  const scheduleFrame = useCallback((): void => {
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => { paint() })
  }, [paint])

  /** 适应视图（只动相机）。 */
  const fitView = useCallback((): void => {
    const cam = fitCamera(propsRef.current.graph.nodes, positionsRef.current, n => radiiRef.current.get(n.id) ?? 8, sizeRef.current)
    if (cam) camRef.current = cam
    scheduleFrame()
  }, [scheduleFrame])

  /**
   * 跑一次布局并把结果并进坐标表。
   *
   * 两个易漏点：
   *   ① 固定节点必须在布局后**按原位置还原**。布局模块只接收一份坐标表，没有「固定」的概念；
   *      不还原的话「📌 固定」按下去、再动一下力度滑杆就白按了（改前 ECharts 版靠 `fixed:true` 做到了）。
   *   ② 结构变化后要清掉已消失节点的坐标，否则 localStorage 会随浏览过的图单调膨胀。
   * @param fresh - 是否从确定性初值重算（「重新布局」按钮）。
   */
  const relayoutNow = useCallback(async (fresh: boolean): Promise<void> => {
    const p = propsRef.current
    if (p.graph.nodes.length === 0) return
    const seq = ++layoutSeqRef.current
    const pinned = p.pinnedIds ?? EMPTY_SET
    const pinnedSnapshot = new Map<string, Point>()
    for (const id of pinned) {
      const pos = positionsRef.current.get(id)
      if (pos) pinnedSnapshot.set(id, { x: pos.x, y: pos.y })
    }
    const result = await runLayout({
      graph: p.graph,
      settings: p.settings,
      ...(fresh ? { fresh: true } : { saved: positionsRef.current }),
    })
    // 期间又发起了新的布局（或组件已切走）：这份结果已经过期，丢掉 —— 否则会把更新的布局盖回旧形状
    if (seq !== layoutSeqRef.current) return
    for (const n of p.graph.nodes) {
      const pos = result.positions.get(n.id)
      if (pos) positionsRef.current.set(n.id, { x: pos.x, y: pos.y })
    }
    // 把坐标尺度校准到「按节点半径表达的间距」。FA2 的坐标是无量纲的：节点少时自然尺度极小
    // （2 个节点约 ±6 单位），而节点半径是 5~23px，两个圆会直接叠住，画布的自适应缩放又有上限补不回来。
    // 这一步必须在还原固定节点**之前**做，否则固定节点会与其余节点失去相对一致性。
    const scale = spacingScale(p.graph.nodes, radiiRef.current, positionsRef.current, p.settings.nodeGap)
    if (Math.abs(scale - 1) > 1e-6) {
      for (const n of p.graph.nodes) {
        const pos = positionsRef.current.get(n.id)
        if (!pos) continue
        pos.x *= scale
        pos.y *= scale
      }
    }
    for (const [id, pos] of pinnedSnapshot) positionsRef.current.set(id, pos)
    // 布局落定后再松弛一次：FA2 只保证「不挤成一团」，不保证圆不相交；
    // 固定节点在上面已经还原到位，这里让它们作为障碍把别人推开而自己不动。
    relaxCollisions(p.graph.nodes, positionsRef.current, radiiRef.current, { iterations: 4, skip: p.pinnedIds })
    if (needsFitRef.current) {
      needsFitRef.current = false
      fitView()
    }
    persistTimerRef.current?.restart()
    scheduleFrame()
  }, [fitView, scheduleFrame])

  // 布局调度：结构（图 / 六个力度参数）变了才重排，并合并连续变化。
  const forceKey = forceKeyOf(settings)
  useEffect(() => {
    if (!layoutTimerRef.current) {
      layoutTimerRef.current = createRestartableTimer({
        delayMs: RELAYOUT_SETTLE_MS,
        run: () => { void relayoutNow(false) },
      })
    }
    layoutTimerRef.current.restart()
  }, [graph, forceKey, relayoutNow])
  useEffect(() => () => { layoutTimerRef.current?.dispose() }, [])

  // 坐标落盘：走静默期合并；卸载时兜住最后一笔（布局落定/拖拽结束后立刻切走的情形）。
  useEffect(() => {
    const persist = createRestartableTimer({
      delayMs: PERSIST_SETTLE_MS,
      run: () => { savePositions(positionsForPersist()) },
    })
    persistTimerRef.current = persist
    return () => {
      if (persist.pending()) {
        persist.cancel()
        savePositions(positionsForPersist())
      }
      persist.dispose()
    }
  }, [positionsForPersist])

  // 尺寸变化：按 DPR 调 backing store，并重画（相机不动，只换视口大小）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const apply = (): void => {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
      dprRef.current = dpr
      sizeRef.current = { w, h }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const mini = miniRef.current
      if (mini) {
        const mw = 148
        const mh = 96
        mini.width = Math.round(mw * dpr)
        mini.height = Math.round(mh * dpr)
        mini.style.width = `${mw}px`
        mini.style.height = `${mh}px`
      }
      scheduleFrame()
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(canvas)
    return () => { ro.disconnect() }
  }, [scheduleFrame])

  useEffect(() => () => { if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current) }, [])

  // 挂载标志：进 effect 时置回 true，是为了兼容 StrictMode 的「挂载 → 卸载 → 再挂载」
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /**
   * 头像加载：批量一次请求，而不是逐节点 60 次 RPC。
   *
   * 改前是 `apiGetAvatar` + 并发 6 + 上限 60 个节点；换成 `apiGetAvatarsLocal`（本地
   * head_image.db 优先，未命中再由后端用 contact 表 URL 兜底）之后 RPC 从 60 次降到 1 次，
   * 预算也从 60 提到「小图全覆盖、大图前 240」—— 更快也更完整。
   *
   * 重画守卫用 `mountedRef` 而**不是** effect 作用域里的 `alive`：effect 依赖 `graph`
   * （每次 buildGraph 都重建引用），重跑时 cleanup 会把上一轮的 `alive` 置 false ——
   * 而这一轮请求的头像解码还在进行中，于是「解码完成 → 重画」这一步永远等不到，
   * 画布停在「先解码完的那一批」上（真机实测：240 个头像只画出 131 个，等 20 秒也不动，
   * 且与视口无关）。只有组件**卸载**才该放弃重画，重跑 effect 不算。
   */
  useEffect(() => {
    const wanted: string[] = []
    for (const n of avatarCandidates(graph.nodes, avatarBudget(nodeCount))) {
      const id = avatarIdOf(n)
      if (!id || avatarAskedRef.current.has(id)) continue
      avatarAskedRef.current.add(id)
      wanted.push(id)
    }
    if (wanted.length === 0) {
      // 全都拉过了（切走再切回、或这批节点已有缓存）：只需重画，让 sprite 生效
      scheduleFrame()
      return
    }
    void apiGetAvatarsLocal({ usernames: wanted })
      .then(async (map) => {
        const decodes: Promise<void>[] = []
        for (const username of wanted) {
          const url = map[username] ?? ''
          if (!url) {
            avatarAssets.set(username, { url: '', sprite: null })
            continue
          }
          decodes.push(decodeAvatar(username, url, avatarAssets))
        }
        await Promise.all(decodes)
        if (mountedRef.current) scheduleFrame()
      })
      .catch(() => {
        // 批量接口不可用（后端未就绪等）：把标记还回去，下次数据刷新后重试
        for (const username of wanted) {
          if (!avatarAssets.has(username)) avatarAskedRef.current.delete(username)
        }
      })
  }, [graph, nodeCount, avatarIdOf, scheduleFrame])

  // 外观与状态变化只重画，不重排布局
  useEffect(() => { scheduleFrame() }, [settings, graph, dark, selectedId, hoverNodeId, focusCommunity, hoverCommunity, pinnedIds, scheduleFrame])

  // 图的结构/数据一变，进行中的出现动画立刻作废：旧时间表里的节点 id 可能已经不在图里，
  // 继续按它算进度会留下「永远不亮」的节点。
  useEffect(() => { revealRef.current = null }, [graph])

  /* ── 指针交互 ──────────────────────────────────────────────────────── */

  /** 指针在 canvas 本地坐标系（CSS 像素）中的位置。 */
  const localPoint = (ev: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }
  }

  const hitAt = (lp: Point): string | null => {
    const p = propsRef.current
    const world = screenToWorld(camRef.current, sizeRef.current, lp.x, lp.y)
    return pickNode(p.graph.nodes, positionsRef.current, n => radiiRef.current.get(n.id) ?? 8, camRef.current, world.x, world.y)
  }

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const p = propsRef.current
    const lp = localPoint(ev)
    pointerRef.current = lp
    const hit = hitAt(lp)
    const lock = p.settings.lockLayout
    if (hit && !lock) {
      const pos = positionsRef.current.get(hit)
      const world = screenToWorld(camRef.current, sizeRef.current, lp.x, lp.y)
      dragRef.current = {
        kind: 'node',
        id: hit,
        grabDx: pos ? world.x - pos.x : 0,
        grabDy: pos ? world.y - pos.y : 0,
        camX: camRef.current.x,
        camY: camRef.current.y,
        startX: lp.x,
        startY: lp.y,
        moved: false,
      }
      // 建物理世界：弹簧自然长度取**按下瞬间的实际长度** ⇒ 此刻是零力状态，
      // 所以不拖动时图不会自己动起来（否则每次开始拖都会先抖一下再稳定）。
      const simWorld = createPhysicsWorld(p.graph, positionsRef.current, radiiRef.current)
      // 固定/锁定节点当锚点：在模拟里不动，也不参与质心约束
      anchorNodes(simWorld, p.pinnedIds ?? [])
      simRef.current = { world: simWorld, id: hit, target: { x: pos?.x ?? 0, y: pos?.y ?? 0 }, releasedAt: 0 }
    } else {
      dragRef.current = {
        kind: 'pan',
        grabDx: 0,
        grabDy: 0,
        camX: camRef.current.x,
        camY: camRef.current.y,
        startX: lp.x,
        startY: lp.y,
        moved: false,
      }
    }
    if (hit) p.onSelect(hit)
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const lp = localPoint(ev)
    pointerRef.current = lp
    const drag = dragRef.current
    if (!drag) {
      scheduleFrame()
      return
    }
    const moved = drag.moved || Math.abs(lp.x - drag.startX) > 3 || Math.abs(lp.y - drag.startY) > 3
    drag.moved = moved
    if (!moved) return
    if (drag.kind === 'node' && drag.id) {
      const world = screenToWorld(camRef.current, sizeRef.current, lp.x, lp.y)
      // 这里只更新「指针目标」；坐标由物理积分推进（在 paint 里逐帧做）。
      // 不在 pointermove 里推进：高采样率鼠标一秒几百次 move，等于把物理步进绑在
      // 轮询率上（145Hz 鼠标的模拟速度会是 60Hz 的两倍多），逐帧才是稳定手感。
      const sim = simRef.current
      if (sim && sim.id === drag.id) sim.target = { x: world.x - drag.grabDx, y: world.y - drag.grabDy }
      scheduleFrame()
      return
    }
    // 平移：屏幕位移除以 k 换回世界位移
    const k = camRef.current.k
    camRef.current = {
      k,
      x: drag.camX - (lp.x - drag.startX) / k,
      y: drag.camY - (lp.y - drag.startY) / k,
    }
    scheduleFrame()
  }

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    ev.currentTarget.releasePointerCapture?.(ev.pointerId)
    if (!drag) return
    if (drag.kind === 'node') {
      // 拖拽结束才落盘：拖拽过程中逐帧写 localStorage 正是改前 L8 的问题
      if (drag.moved) {
        // 松手不是「停住」而是「开始收敛」：物理世界继续积分 SETTLE_MS 毫秒，
        // 期间阻尼逐渐加重让图平滑停下，收敛完成后才写最终态（存下来必须是不重叠的）。
        const sim = simRef.current
        if (sim && sim.id === drag.id) sim.releasedAt = performance.now()
        // 兜底落盘：万一用户在收敛途中关掉面板，至少有一份状态被写下（收敛完还会再写一次）
        persistTimerRef.current?.restart()
        scheduleFrame()
      } else {
        // 只是点了一下没拖动：没有要收敛的东西，把世界丢掉（否则它会一直挂在 ref 上）
        simRef.current = null
      }
    } else if (!drag.moved) {
      // 点空白处清除选中（改前 ECharts 版只在点中节点时回调，点空白什么都不做）
      propsRef.current.onSelect(null)
    }
    scheduleFrame()
  }

  const onPointerLeave = (): void => {
    pointerRef.current = null
    if (propsRef.current.hoverNodeId != null) propsRef.current.onHoverNode?.(null)
    scheduleFrame()
  }

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>): void => {
    const lp = localPoint(ev)
    camRef.current = zoomAt(camRef.current, sizeRef.current, lp.x, lp.y, Math.pow(0.999, ev.deltaY))
    scheduleFrame()
  }

  const onDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const hit = hitAt(localPoint(ev))
    if (hit) propsRef.current.onFocusNode?.(hit)
  }

  const onMiniClick = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const t = minimapRef.current
    if (!t) return
    const rect = miniRef.current?.getBoundingClientRect()
    const mx = ev.clientX - (rect?.left ?? 0)
    const my = ev.clientY - (rect?.top ?? 0)
    camRef.current = { k: camRef.current.k, x: (mx - t.ox) / t.s + t.minX, y: (my - t.oy) / t.s + t.minY }
    scheduleFrame()
  }

  /* ── 导出 ──────────────────────────────────────────────────────────── */

  /** 在离屏画布上按目标画幅与风格重绘（PNG 导出与海报图层共用）。 */
  const renderOffscreen = useCallback((opts: { w: number; h: number; style: PosterStyle }): HTMLCanvasElement => {
    const p = propsRef.current
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(opts.w * scale))
    canvas.height = Math.max(1, Math.round(opts.h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建导出画布')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.fillStyle = EXPORT_BG[opts.style]
    ctx.fillRect(0, 0, opts.w, opts.h)
    const size = { w: opts.w, h: opts.h }
    const cam = fitCamera(p.graph.nodes, positionsRef.current, n => radiiRef.current.get(n.id) ?? 8, size) ?? { x: 0, y: 0, k: 1 }
    drawScene(ctx, buildScene({
      positions: positionsRef.current,
      radii: radiiRef.current,
      sprites: spriteMap(),
      camera: cam,
      size,
      isDark: styleIsDark(opts.style),
      interactive: false,
    }))
    return canvas
  }, [buildScene, spriteMap])

  useImperativeHandle(ref, () => ({
    fitView,
    centerOn: (id: string) => {
      const pos = positionsRef.current.get(id)
      if (!pos) return
      camRef.current = { k: Math.max(camRef.current.k, 1.1), x: pos.x, y: pos.y }
      scheduleFrame()
    },
    /**
     * 「播放动画」= **由一个节点逐个衍生出全部节点**。
     *
     * 起点取 `self`（社交图谱是「我」—— 整张图的枢纽）；知识图谱没有「我」，
     * `buildRevealPlan` 会退回权重最高的那张笔记。节点按 BFS 层序、层内按到起点的
     * 距离依次淡入并放大（半径 0.35 → 1），边在两端都出现后才跟着淡入。
     *
     * 相机同时平滑适应全图：不推的话，刚衍生出来的节点很可能在视野外，等于白放。
     * 改前这个按钮只是推一次 550ms 的镜头，看不出一点「动画」。
     */
    runAnimation: () => {
      const p = propsRef.current
      if (p.graph.nodes.length === 0) return
      const plan = buildRevealPlan(p.graph.nodes, p.graph.edges, SELF_ID, positionsRef.current)
      if (plan.totalMs <= 0) return
      const to = fitCamera(p.graph.nodes, positionsRef.current, n => radiiRef.current.get(n.id) ?? 8, sizeRef.current)
      const t0 = performance.now()
      revealRef.current = { plan, t0 }
      if (frameRef.current !== 0) { cancelAnimationFrame(frameRef.current); frameRef.current = 0 }
      animRef.current = to ? { from: camRef.current, to, t0, dur: 550 } : null
      const step = (): void => {
        const anim = animRef.current
        if (anim) {
          const t = Math.min(1, (performance.now() - anim.t0) / anim.dur)
          // easeOutCubic：起步快、收尾稳，比线性更像「推镜头」
          const e = 1 - Math.pow(1 - t, 3)
          camRef.current = {
            k: anim.from.k + (anim.to.k - anim.from.k) * e,
            x: anim.from.x + (anim.to.x - anim.from.x) * e,
            y: anim.from.y + (anim.to.y - anim.from.y) * e,
          }
          if (t >= 1) animRef.current = null
        }
        paint()
        if (performance.now() - t0 < plan.totalMs) {
          frameRef.current = requestAnimationFrame(step)
        } else {
          // 收尾：清掉进度再画一帧，确保停在「完整图」上（别让最后一帧的半亮状态留在屏上）
          revealRef.current = null
          animRef.current = null
          frameRef.current = 0
          paint()
        }
      }
      frameRef.current = requestAnimationFrame(step)
    },
    relayout: () => { void relayoutNow(true) },
    exportSvg: () => {
      const p = propsRef.current
      const scene = buildScene({
        positions: positionsRef.current,
        radii: radiiRef.current,
        sprites: spriteMap(),
        camera: camRef.current,
        size: sizeRef.current,
        isDark: p.dark ?? false,
        interactive: false,
      })
      return Promise.resolve(sceneToSvg(scene, (n) => {
        const id = avatarIdOf(n)
        return id ? (avatarAssets.get(id)?.url ?? '') : ''
      }))
    },
    exportPng: (ratio, style) => {
      const { width, height } = EXPORT_SIZES[ratio]
      return Promise.resolve(renderOffscreen({ w: width, h: height, style }).toDataURL('image/png'))
    },
    renderPoster: async (ratio, style) => {
      const p = propsRef.current
      const g = p.graph
      const topFriends = [...g.nodes]
        .filter(n => n.kind !== 'self')
        .sort((a, b) => (b.intimacy ?? 0) - (a.intimacy ?? 0) || b.weight - a.weight)
        .slice(0, 5)
      const topRelations: PosterRelation[] = topFriends.map(n => ({
        name: n.label,
        msg: Math.round(n.intimacy ?? n.weight),
        sprite: avatarAssets.get(avatarIdOf(n))?.sprite ?? null,
      }))
      const communities: PosterCommunity[] = groupCommunities(g).slice(0, 8).map(c => ({
        color: communityColor(c.id),
        count: c.members.length,
        names: c.members.slice(0, 2).map(m => m.label).join('、'),
      }))
      const stats: PosterStatItem[] = [
        { label: '节点', value: String(g.nodes.length) },
        { label: '连线', value: String(g.edges.length) },
        { label: '圈子', value: String(g.communityCount) },
      ]
      // 海报里的图谱层按 16:9 的图谱框尺寸渲染（内部再乘 2 倍抗锯齿）
      const layer = renderOffscreen({ w: 1184, h: 360, style })
      const input: PosterInput = {
        graphLayer: layer,
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
      return posterToDataUrl(buildPoster(input), 'jpeg')
    },
  }), [avatarIdOf, buildScene, fitView, paint, relayoutNow, renderOffscreen, scheduleFrame, spriteMap])

  /** 网格底纹仍由 CSS 画（与改前一致），画布本身透出它。 */
  const gridBg = settings.showGrid
    ? (dark
      ? 'radial-gradient(circle at 1px 1px, rgba(150,170,190,0.12) 1px, transparent 0) 0 0 / 24px 24px'
      : 'radial-gradient(circle at 1px 1px, rgba(70,90,110,0.14) 1px, transparent 0) 0 0 / 24px 24px')
    : undefined

  return (
    <>
      <canvas
        ref={canvasRef}
        className={css.graphCanvas}
        style={gridBg ? { background: gridBg } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(ev) => { ev.preventDefault() }}
        data-locked={settings.lockLayout || undefined}
        // 把交互状态暴露成 data 属性：画布内容是位图，e2e 无法从 DOM 断言「悬停/选中是否生效」，
        // 只能靠截图逐字节比较（噪音大、失败时说不清是检测坏了还是绘制坏了）。
        data-hover={hoverNodeId ?? undefined}
        data-selected={selectedId ?? undefined}
        aria-label="社交关系图谱画布"
      />
      <canvas
        ref={miniRef}
        className={css.minimap}
        aria-label="图谱小地图"
        onPointerDown={onMiniClick}
        onContextMenu={(ev) => { ev.preventDefault() }}
      />
    </>
  )
})
