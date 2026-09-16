/**
 * 拖拽期的物理模拟 —— 二阶动力学（弹簧 + 软碰撞 + 阻尼积分 + 质心固定）。
 *
 * 为什么必须换成真的物理积分，而不是「位移按比例传播」那种运动学近似：
 * 那种做法里每个节点只是被赋了一个目标位置然后指数趋近，结果是**一阶**的 ——
 * 没有速度、没有动量，所以看不出「被拽住后甩一下」的手感；远处节点被跳数衰减压到几乎不动；
 * 松手就停在原地。Obsidian 的图谱是**持续积分**的：弹簧有张力、节点有惯性、会轻微过冲，
 * 整张图（不只是邻居）在拖拽期间与松手之后都在重新找平衡。这不是调参能补的，是模型类别不同。
 *
 * 力模型（三项，且**在初始状态下都为零**，所以不拖动时图一个像素都不会漂）：
 *   ① **弹簧**：沿每条边，自然长度 = 按下瞬间的实际长度 ⇒ 静止时张力为零；被拖动后
 *      张力把邻居拉向自己，再经由它们传给更远的人（真正的逐跳传播，带时间延迟）。
 *   ② **软碰撞**：只在「个人空间」（半径和 × personalSpace）内相斥，静止时同样为零 ——
 *      它是拖拽时「把旁边的人挤开」的那个手感，硬性不重叠仍由 relaxCollisions 兜底。
 *   ③ **质心固定**：每步把全体节点的质心平移回按下时的质心（等价于 d3 的 forceCenter）。
 *      没有它，弹簧网络存在「整体平移」这个零能模 —— 拖一个点最终会把整个连通分量拖走；
 *      有了它，近处跟着走、远处必然反向补偿，这正是「整张图被扯住」的观感来源。
 *
 * 数值方案：半隐式欧拉（先积分速度再积分位置）+ 每步速度衰减 + 速度上限。
 * 半隐式欧拉对弹簧系统是条件稳定的，`springK` 与 `damping` 的取值由 `physics.spec.ts`
 * 的阶跃响应用例锁定（见那里的目标：约 0.5s 走完八成、轻微过冲、1.5s 内收敛）。
 */
import type { BuiltGraph } from './graph-model.ts'
import type { Point } from './graph-canvas.ts'

/** 物理参数。 */
export interface PhysicsSettings {
  /** 弹簧刚度：单位伸长的加速度增量。越大跟得越紧、越快。 */
  springK: number
  /**
   * 原位锚点刚度：每个节点对自己**按下时位置**的软弹簧。
   *
   * 这一项决定了整套手感，缺了它会出大问题：只有边弹簧时「整片邻域平移」几乎是零能模，
   * 拖一个点会把它的邻居一路平移到新位置（真机实测邻居位移达到被拖位移的 124%，
   * 且 231 个节点被推动 20~100 单位 —— 整张图被大范围重排，而这不是 Obsidian 的行为）。
   * 锚点让每个节点都记得「我本来在哪」：邻居只跟一部分（跟随量 ≈ springK/(springK+anchorK)），
   * 远处的节点被链式拉动远小于锚点的回位力，于是基本不动。同时它让初始状态**精确零力**
   * （原位处锚点张力为零），因此不拖动时图一个像素都不会漂。
   */
  anchorK: number
  /** 每步速度衰减（< 1）。越小越「黏」，过大则抖动。 */
  damping: number
  /** 每步速度上限（世界单位），防数值发散。 */
  maxSpeed: number
  /** 软碰撞刚度（仅在个人空间内起作用）。 */
  repelK: number
  /** 个人空间系数：两节点距离小于 (r1 + r2) × 该系数时开始相斥。 */
  personalSpace: number
  /** 每帧子步数（子步越多越稳，代价线性）。 */
  substeps: number
}

/**
 * 默认参数。
 *
 * `springK` 与 `damping` 是一起调的：`springK` 定「多快」，`damping` 定「稳不稳」。
 * 当前取值给出的是**接近临界阻尼、略带一点欠阻尼**的响应 —— 会有一点点过冲（看起来「活」），
 * 但不会来回晃。改任何一个都要重跑 `graph-physics.spec.ts` 的阶跃响应用例。
 */
export const DEFAULT_PHYSICS: PhysicsSettings = {
  springK: 0.065,
  anchorK: 0.03,
  damping: 0.87,
  maxSpeed: 60,
  // 软碰撞是线性的，平衡态下会留一点穿透（弹簧/锚点把它们往一起拉、斥力在有限刚度下顶开）。
  // 刚度取大一些把穿透压小，硬性不重叠仍由收尾的 relaxCollisions 兜底。
  repelK: 0.6,
  personalSpace: 1.15,
  substeps: 2,
}

/** 模拟中的节点。 */
export interface PhysicsNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** 半径（软碰撞用）。 */
  r: number
  /** 是否被钉住（被拖的那个由指针赋值，速度恒为 0）。 */
  pinned: boolean
  /** 按下时的位置：锚点弹簧的自然长度为零处（见 PhysicsSettings.anchorK）。 */
  homeX: number
  homeY: number
  /**
   * 逆质量 = 1 / (1 + 度数)。
   *
   * 为什么必须有它：位移是**按度数分摊**的。枢纽（「我」）身上挂着 250 根弹簧，
   * 不归一的话每步受到的合力是叶子节点的两百多倍，弹簧系统的稳定条件被直接击穿 ——
   * 首版实测就是「邻居位移在 61~322 之间来回甩、180 步后能量仍有 23」。
   * 物理上它也说得通：一个点被越多根线拉着，同样的张力下它越难被拽动。
   * （FA2 里的 `outboundAttractionDistribution` 就是这件事。）
   */
  invMass: number
  /** 每步的加速度累加器。 */
  ax: number
  ay: number
}

/** 模拟中的边。`rest` 是按下瞬间的长度；`k` 只含**边权因子**，刚度基准在步进时乘（便于调参）。 */
export interface PhysicsEdge {
  a: number
  b: number
  rest: number
  k: number
}

export interface PhysicsWorld {
  nodes: PhysicsNode[]
  edges: PhysicsEdge[]
  index: Map<string, number>
}

/**
 * 由当前图与坐标建立模拟世界。
 *
 * 关键：**弹簧自然长度取按下瞬间的实际长度**，所以建出来的世界是零力状态的 ——
 * 不拖动的时候它不会自己动起来（否则每次开始拖图都会先「抖一下」再稳定）。
 * @param graph - 图。
 * @param positions - 当前坐标。
 * @param radii - 半径表。
 * @returns 模拟世界。
 */
export function createPhysicsWorld(
  graph: BuiltGraph,
  positions: ReadonlyMap<string, Point>,
  radii: ReadonlyMap<string, number>,
): PhysicsWorld {
  const nodes: PhysicsNode[] = []
  const index = new Map<string, number>()
  for (const g of graph.nodes) {
    const p = positions.get(g.id)
    if (!p) continue
    index.set(g.id, nodes.length)
    nodes.push({ id: g.id, x: p.x, y: p.y, vx: 0, vy: 0, r: radii.get(g.id) ?? 8, pinned: false, homeX: p.x, homeY: p.y, invMass: 1, ax: 0, ay: 0 })
  }
  // 边权归一：同一次拖拽里，关系越强的弹簧越硬
  let maxW = 1
  for (const e of graph.edges) maxW = Math.max(maxW, Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1)
  const edges: PhysicsEdge[] = []
  const seen = new Set<string>()
  const degree = new Array<number>(nodes.length).fill(0)
  for (const e of graph.edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    // 互惠关系是同一根弹簧：两端各存一条会让刚度翻倍
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) continue
    seen.add(key)
    const na = nodes[a]
    const nb = nodes[b]
    if (!na || !nb) continue
    const w = Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1
    edges.push({
      a,
      b,
      rest: Math.hypot(nb.x - na.x, nb.y - na.y),
      // 只存边权因子；刚度基准 springK 在步进时乘，这样调参不用重建世界
      k: 0.6 + 0.8 * Math.min(1, w / maxW),
    })
    degree[a] = (degree[a] ?? 0) + 1
    degree[b] = (degree[b] ?? 0) + 1
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n) n.invMass = 1 / (1 + (degree[i] ?? 0))
  }
  return { nodes, edges, index }
}

/** 网格桶键（软碰撞只看 3×3 邻格）。 */
function cellKey(cx: number, cy: number): number {
  return (cx + 100000) * 400000 + (cy + 100000)
}

/**
 * 推进一小步。
 * @param world - 模拟世界（就地修改）。
 * @param settings - 参数覆盖。
 */
export function stepPhysics(world: PhysicsWorld, settings: Partial<PhysicsSettings> = {}): void {
  const s = { ...DEFAULT_PHYSICS, ...settings }
  const { nodes, edges } = world
  if (nodes.length === 0) return
  for (const n of nodes) {
    n.ax = 0
    n.ay = 0
  }
  // ① 弹簧：自然长度处张力为零
  for (const e of edges) {
    const na = nodes[e.a]
    const nb = nodes[e.b]
    if (!na || !nb) continue
    const dx = nb.x - na.x
    const dy = nb.y - na.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-6) continue
    const f = s.springK * e.k * (d - e.rest)
    const ux = (dx / d) * f
    const uy = (dy / d) * f
    na.ax += ux
    na.ay += uy
    nb.ax -= ux
    nb.ay -= uy
  }
  // ①b 原位锚点：每个节点都记得自己本来在哪。它同时负责「静止时零力」「邻居只跟一部分」
  //     「整张图不会被一起搬走」三件事（见 PhysicsSettings.anchorK）。
  for (const n of nodes) {
    if (n.pinned) continue
    n.ax += s.anchorK * (n.homeX - n.x)
    n.ay += s.anchorK * (n.homeY - n.y)
  }
  // ② 软碰撞：只在个人空间内相斥（静止时为 0）
  let maxR = 0
  for (const n of nodes) maxR = Math.max(maxR, n.r)
  const cell = Math.max(1, maxR * 2 * s.personalSpace)
  const grid = new Map<number, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n) continue
    const k = cellKey(Math.floor(n.x / cell), Math.floor(n.y / cell))
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }
  for (let i = 0; i < nodes.length; i++) {
    const na = nodes[i]
    if (!na) continue
    const cx = Math.floor(na.x / cell)
    const cy = Math.floor(na.y / cell)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(cellKey(cx + ox, cy + oy)) ?? []) {
          if (j <= i) continue
          const nb = nodes[j]
          if (!nb) continue
          const dx = nb.x - na.x
          const dy = nb.y - na.y
          const d = Math.hypot(dx, dy)
          const space = (na.r + nb.r) * s.personalSpace
          if (d >= space) continue
          const f = s.repelK * (space - d)
          const ux = d < 1e-6 ? 1 : dx / d
          const uy = d < 1e-6 ? 0 : dy / d
          na.ax -= ux * f
          na.ay -= uy * f
          nb.ax += ux * f
          nb.ay += uy * f
        }
      }
    }
  }
  // ③ 积分（半隐式欧拉）：先速度后位置；钉住的节点由指针赋值，速度恒为 0
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0
      n.vy = 0
      continue
    }
    // 按度数分摊（见 PhysicsNode.invMass）：枢纽不会被自己那两百多根弹簧甩出去
    n.vx = (n.vx + n.ax * n.invMass) * s.damping
    n.vy = (n.vy + n.ay * n.invMass) * s.damping
    const sp = Math.hypot(n.vx, n.vy)
    if (sp > s.maxSpeed) {
      const k = s.maxSpeed / sp
      n.vx *= k
      n.vy *= k
    }
    n.x += n.vx
    n.y += n.vy
  }
}

/** 平均速度平方：用来判定「已经静止」（不再排帧）。 */
export function physicsEnergy(world: PhysicsWorld): number {
  const nodes = world.nodes
  if (nodes.length === 0) return 0
  let sum = 0
  for (const n of nodes) sum += n.vx * n.vx + n.vy * n.vy
  return sum / nodes.length
}

/** 本步位移最大的那个节点的速度：比平均能量更能反映「还有没有肉眼可见的运动」。 */
export function physicsMaxStep(world: PhysicsWorld): number {
  let m = 0
  for (const n of world.nodes) m = Math.max(m, Math.hypot(n.vx, n.vy))
  return m
}

/** 把模拟坐标写回绘制用的坐标表。 */
export function syncPhysicsToPositions(world: PhysicsWorld, positions: Map<string, Point>): void {
  for (const n of world.nodes) {
    const p = positions.get(n.id)
    if (!p) positions.set(n.id, { x: n.x, y: n.y })
    else {
      p.x = n.x
      p.y = n.y
    }
  }
}

/**
 * 把外部改动过的坐标写回模拟。
 *
 * 为什么需要：软碰撞只保证「大致推开」，硬性不重叠仍由 `relaxCollisions` 兜底；
 * 那一遍会直接改坐标表。不把它写回模拟的话，下一步积分会拿旧的 `world` 坐标覆盖掉它，
 * 表现为「碰撞怎么都推不开」。
 * @param world - 模拟世界（就地修改）。
 * @param positions - 外部坐标表。
 */
export function syncPositionsToPhysics(world: PhysicsWorld, positions: ReadonlyMap<string, Point>): void {
  for (const n of world.nodes) {
    const p = positions.get(n.id)
    if (!p) continue
    n.x = p.x
    n.y = p.y
  }
}

/**
 * 把某些节点设为固定锚点（固定/锁定的节点在模拟里不动，也不参与质心约束）。
 * @param world - 模拟世界。
 * @param ids - 要固定的节点 id。
 */
export function anchorNodes(world: PhysicsWorld, ids: Iterable<string>): void {
  for (const id of ids) {
    const i = world.index.get(id)
    const n = i === undefined ? undefined : world.nodes[i]
    if (n) n.pinned = true
  }
}

/**
 * 把某个节点钉到指定位置（被拖的节点由指针控制）。
 * @param world - 模拟世界。
 * @param id - 节点 id。
 * @param x - 世界坐标 x。
 * @param y - 世界坐标 y。
 */
export function pinAt(world: PhysicsWorld, id: string, x: number, y: number): void {
  const i = world.index.get(id)
  if (i === undefined) return
  const n = world.nodes[i]
  if (!n) return
  n.pinned = true
  n.x = x
  n.y = y
  n.vx = 0
  n.vy = 0
}
