/**
 * 图谱设置、默认值与力度滑杆口径。
 *
 * 本模块不依赖图构建逻辑；`graph-model.ts` 继续转发全部公开名称，现有 import
 * 路径保持不变。
 *
 * @module graph-settings
 */

export interface GraphSettings {
  /** `knowledge` = 知识网络（节点全部来自笔记库）；没有「融合」档 —— 见文件头注释。 */
  mode: 'people' | 'groups' | 'all' | 'knowledge'
  /** 节点上限：**初始默认 = 社交候选总人数 × 30%**（见 `defaultNodeLimit`）；用户拖过滑杆后以用户值为准。 */
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
  /** 头像模糊强度(px,0=关闭):只对**头像位图**做高斯模糊;名字/圆点/描边环/连线保持清晰 */
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
  // `250` 是「自动」哨兵：载入数据后由 Graph.tsx 替换为「候选总人数 × 30%」
  // （见 defaultNodeLimit；用户拖动滑杆后不再覆盖）。保留 250 而不是 0 是为了
  // 兼容已持久化的旧设置与 `nodeLimit === DEFAULT_GRAPH_SETTINGS.nodeLimit` 判断。
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

/**
 * 力度滑杆的安全倍率窗口。底层 FA2 映射与 UI 范围共用这两个数：
 * 以前 UI 的原始值范围比这里宽，滑杆两端会出现“数值继续变、图谱完全不动”的死区。
 */
export const GRAPH_FORCE_FACTOR_MIN = 0.25
export const GRAPH_FORCE_FACTOR_MAX = 4

/** 会触发布局变化的六个力度参数。 */
export const GRAPH_FORCE_KEYS = [
  'forceCentripetal',
  'forceRepulsion',
  'forceAttraction',
  'forceEdgeLength',
  'nodeGap',
  'communitySeparation',
] as const

export type GraphForceKey = typeof GRAPH_FORCE_KEYS[number]

export interface GraphForceControl {
  min: number
  max: number
  step: number
}

/**
 * 六个力度滑杆的取值范围。
 *
 * 范围直接由 `默认值 × 安全倍率窗口` 得来，所以拖动时每一档都会真实改变 FA2，
 * 而显示值统一格式化为「相对默认力度的倍率」——滑杆上的 `1.00×` 就是默认力度。
 */
export const GRAPH_FORCE_CONTROLS: Record<GraphForceKey, GraphForceControl> = {
  forceCentripetal: { min: DEFAULT_GRAPH_SETTINGS.forceCentripetal * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.forceCentripetal * GRAPH_FORCE_FACTOR_MAX, step: 0.05 },
  forceRepulsion: { min: DEFAULT_GRAPH_SETTINGS.forceRepulsion * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.forceRepulsion * GRAPH_FORCE_FACTOR_MAX, step: 0.04 },
  forceAttraction: { min: DEFAULT_GRAPH_SETTINGS.forceAttraction * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.forceAttraction * GRAPH_FORCE_FACTOR_MAX, step: 0.0025 },
  forceEdgeLength: { min: DEFAULT_GRAPH_SETTINGS.forceEdgeLength * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.forceEdgeLength * GRAPH_FORCE_FACTOR_MAX, step: 0.0105 },
  nodeGap: { min: DEFAULT_GRAPH_SETTINGS.nodeGap * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.nodeGap * GRAPH_FORCE_FACTOR_MAX, step: 0.017 },
  communitySeparation: { min: DEFAULT_GRAPH_SETTINGS.communitySeparation * GRAPH_FORCE_FACTOR_MIN, max: DEFAULT_GRAPH_SETTINGS.communitySeparation * GRAPH_FORCE_FACTOR_MAX, step: 0.016 },
}

/**
 * 原始力度值 → 相对默认值的倍率。
 * @param key - 力度参数。
 * @param value - 设置里的原始值。
 * @returns 默认值对应 1。
 */
export function graphForceMultiplier(key: GraphForceKey, value: number): number {
  const base = DEFAULT_GRAPH_SETTINGS[key]
  if (!(base > 0) || !Number.isFinite(value)) return 1
  return value / base
}

/**
 * 力度滑杆的显示文本。
 * @param key - 力度参数。
 * @param value - 设置里的原始值。
 * @returns 形如 `1.00×` 的文本。
 */
export function formatGraphForceMultiplier(key: GraphForceKey, value: number): string {
  return graphForceMultiplier(key, value).toFixed(2) + '×'
}
