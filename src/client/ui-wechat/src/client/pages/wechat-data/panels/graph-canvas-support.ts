/**
 * `GraphCanvas.tsx` 的「类型与共享状态：道具/拖拽状态、头像资源缓存、小地图映射、静止判定常量」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module graph-canvas-support
 */

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

/**
 * 空集合常量。
 *
 * 必须提到模块级：`new Set()` 放在 JSX 或回调里会让 `pinnedIds` 每次渲染都是新引用，
 * 于是所有以它为依赖的 effect（重画、布局）每帧都触发一次 —— 表现为「什么都不做也在满帧重绘」。
 */
export const EMPTY_SET: ReadonlySet<string> = new Set()

/** 布局输入的稳定指纹：只有六个力度滑杆变化才需要重排，其余设置只影响外观。 */
export function forceKeyOf(s: GraphSettings): string {
  return [s.forceCentripetal, s.forceRepulsion, s.forceAttraction, s.forceEdgeLength, s.nodeGap, s.communitySeparation].join('|')
}

/** 布局重排的静默期：拖力度滑杆会连发几十次 change，合并到最后一次再算。 */
export const RELAYOUT_SETTLE_MS = 120
/** 节点坐标落盘的静默期：拖拽节点时逐帧写 localStorage 会把主线程拖死（改前 L8 的老问题）。 */
export const PERSIST_SETTLE_MS = 300
/**
 * 坐标表条数上限。社交图谱与知识图谱共用一份持久化坐标，落盘时不再按当前图裁剪
 * （见 `positionsForPersist` 的说明），因此需要一个上限防止长期使用后无限增长。
 */
export const POSITION_CACHE_MAX = 6000

/** 导出画幅像素（按比例）。与改前一致。 */
export const EXPORT_SIZES: Record<PosterRatio, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '16:9': { width: 1920, height: 1080 },
}

/** 导出背景色（按风格）。 */
export const EXPORT_BG: Record<PosterStyle, string> = {
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
export function styleIsDark(style: PosterStyle): boolean {
  return style !== 'light'
}

/**
 * 头像资源缓存：跨挂载共享（切走再切回不用重新拉取）。
 * 键是头像主人（username；「我」用真实 wxid），值是原始 data URL + 已裁圆的 sprite。
 */
export const avatarAssets = new Map<string, AvatarAsset>()

/** 小地图的世界 → 小地图坐标映射（每帧刷新），供点击跳转使用。 */
export type MiniTransform = { minX: number; minY: number; s: number; ox: number; oy: number }

export interface GraphCanvasHandle {
  fitView: () => void
  centerOn: (id: string) => void
  runAnimation: () => void
  relayout: () => void
  exportSvg: () => Promise<string>
  exportPng: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
  renderPoster: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>
}

export interface GraphCanvasProps {
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
  /**
   * 坐标落盘的作用域（`'social'` 或 `'kb:<id>'`）—— 由调用方给，画布不自己猜。
   *
   * 为什么不在这里从 graph 推：画布拿到的是 `BuiltGraph`，里面**没有库标识**
   * （节点 id 刻意不带库前缀，见设计稿 §4.4）；而社交图谱与知识图谱共用这一个组件，
   * 只有 `Graph.tsx` 知道当前是哪一个作用域。
   */
  positionScope: string
}

/** 指针拖拽状态：节点拖拽与画布平移共用一条状态机，免得两套事件处理互相打架。 */
export interface DragState {
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
export interface DragSimState {
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
export const SETTLE_MS = 1600
/** 判定「已经静止」的每步最大位移（世界单位/子步）。0.08 ≈ 5 单位/秒，肉眼不可辨。 */
export const REST_STEP = 0.08
