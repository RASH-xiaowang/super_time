/**
 * 拖拽物理模拟（`graph-physics.ts`）的行为锁定。
 *
 * 为什么这些性质必须钉住：它们是「Obsidian 那种手感」的全部内容，而且**退化时看不出错**——
 * 弹簧刚度写错会让邻居跟得太少/震荡不止、去掉逆质量会让枢纽被自己的两百多根线甩出去、
 * 去掉质心固定会让整张图跟着指针平移。以上任何一种都不会让页面报错，只会「手感不对」。
 *
 * 参数（springK / damping）也是被这里的阶跃响应用例锁住的：改任何一个都要重跑这一节。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { type BuiltGraph, type GEdge, type GNode } from './graph-model.ts'
import type { Point } from './graph-canvas.ts'
import {
  DEFAULT_PHYSICS,
  createPhysicsWorld,
  physicsEnergy,
  pinAt,
  stepPhysics,
  syncPhysicsToPositions,
  type PhysicsWorld,
} from './graph-physics.ts'

function node(id: string): GNode {
  return { id, label: id, kind: 'person', weight: 100, radius: 10, community: -1, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null }
}
function edge(source: string, target: string, weight = 1): GEdge {
  return { source, target, weight, dist: 100, kind: 'common', bidirectional: true }
}
function graphOf(nodes: GNode[], edges: GEdge[]): BuiltGraph {
  return { nodes, edges, communityCount: 0 }
}
const radiiOf = (g: BuiltGraph, r = 10): Map<string, number> => new Map(g.nodes.map(n => [n.id, r]))

/** 网格 + 连所有人的枢纽，规模接近真机。 */
function gridGraph(n = 120): { graph: BuiltGraph; positions: Map<string, Point> } {
  const nodes: GNode[] = []
  const positions = new Map<string, Point>()
  const side = Math.ceil(Math.sqrt(n))
  for (let i = 0; i < n; i++) {
    const id = `n${i}`
    nodes.push(node(id))
    positions.set(id, { x: (i % side) * 60, y: Math.floor(i / side) * 60 })
  }
  const edges: GEdge[] = []
  for (let i = 0; i < n; i++) {
    const x = i % side
    const y = Math.floor(i / side)
    if (x + 1 < side) edges.push(edge(`n${i}`, `n${i + 1}`))
    if (y + 1 < side && i + side < n) edges.push(edge(`n${i}`, `n${i + side}`))
  }
  for (let i = 1; i < n; i++) edges.push(edge('n0', `n${i}`, 500))
  return { graph: graphOf(nodes, edges), positions }
}

function stepN(world: PhysicsWorld, steps: number, settings = DEFAULT_PHYSICS): void {
  for (let i = 0; i < steps; i++) stepPhysics(world, settings)
}
function posOf(world: PhysicsWorld, id: string): Point {
  const n = world.nodes[world.index.get(id) ?? 0]
  return { x: n?.x ?? 0, y: n?.y ?? 0 }
}
function maxStep(world: PhysicsWorld): number {
  let m = 0
  for (const n of world.nodes) m = Math.max(m, Math.hypot(n.vx, n.vy))
  return m
}
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('物理模拟：静止状态必须是真正静止的', () => {
  it('刚建好的世界零力：不钉任何节点推进 200 步，坐标一个像素都不动', () => {
    const { graph, positions } = gridGraph()
    const before = new Map([...positions].map(([k, v]) => [k, { ...v }]))
    const world = createPhysicsWorld(graph, positions, radiiOf(graph))
    stepN(world, 200)
    let worst = 0
    for (const n of world.nodes) {
      const b = before.get(n.id)
      if (b) worst = Math.max(worst, dist(n, b))
    }
    // 弹簧自然长度 = 建世界时的实际长度、软碰撞只在个人空间内作用 ⇒ 初始状态是平衡点
    expect(worst).toBeLessThan(1e-6)
    expect(physicsEnergy(world)).toBeLessThan(1e-9)
  })

  it('弹簧自然长度取自按下瞬间：人为把两节点摆近/摆远都不会产生初始冲量', () => {
    const g = graphOf([node('a'), node('b')], [edge('a', 'b')])
    const positions = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: 37, y: 0 }]])
    const world = createPhysicsWorld(g, positions, radiiOf(g))
    // 半径 10、个人空间 1.15 ⇒ 间距 37 已在个人空间外，且弹簧是松弛的
    expect(world.edges[0]?.rest).toBeCloseTo(37, 6)
    stepN(world, 60)
    expect(dist(posOf(world, 'a'), posOf(world, 'b'))).toBeCloseTo(37, 3)
  })
})

describe('物理模拟：拖一个节点的联动特征（Obsidian 那种「蜘蛛网」手感）', () => {
  /** 拖网格角落的叶子，它只有 3 条边；测量一跳、二跳与枢纽。 */
  function dragLeaf(): PhysicsWorld {
    const { graph, positions } = gridGraph()
    const world = createPhysicsWorld(graph, positions, radiiOf(graph))
    const p = positions.get('n119') ?? { x: 0, y: 0 }
    pinAt(world, 'n119', p.x + 200, p.y)
    return world
  }

  it('一跳邻居被弹簧拉着走，且是**单调**逼近（不来回甩）', () => {
    const world = dragLeaf()
    const start = posOf(world, 'n118')
    const samples: number[] = []
    for (let i = 0; i < 6; i++) {
      stepN(world, 30)
      samples.push(dist(posOf(world, 'n118'), start))
    }
    // 单调递增（允许极小回落：这里是「不来回甩」的量化判据）
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual((samples[i - 1] ?? 0) - 1)
    }
    // 60 步（约 0.5s）内跟到 55 以上（被拖位移 200 ⇒ 约三成，明显可见）
    expect(samples[1]!).toBeGreaterThan(55)
    // 稳态约 72（200 位移的三成六）—— 既跟得动、又不会整片平移过去
    expect(samples[4]!).toBeGreaterThan(70)
    expect(samples[4]!).toBeLessThan(190)
  })

  it('传播是逐跳的：二跳也在动，但明显少于一跳', () => {
    const world = dragLeaf()
    const s1 = posOf(world, 'n118')
    const s2 = posOf(world, 'n117')
    stepN(world, 150)
    const d1 = dist(posOf(world, 'n118'), s1)
    const d2 = dist(posOf(world, 'n117'), s2)
    expect(d2).toBeGreaterThan(10)   // 远处确实被带动（不是「只有邻居动」）
    expect(d2).toBeLessThan(d1 * 0.8) // 但比一跳少
  })

  it('枢纽几乎不动：逆质量 = 1/(1+度数) 让它不被自己那两百多根弹簧甩出去', () => {
    const { graph, positions } = gridGraph()
    const world = createPhysicsWorld(graph, positions, radiiOf(graph))
    const hubBefore = posOf(world, 'n0')
    // 拉动一个叶子（它与枢纽直接相连）
    const p = positions.get('n119') ?? { x: 0, y: 0 }
    pinAt(world, 'n119', p.x + 200, p.y)
    stepN(world, 150)
    const hubMoved = dist(posOf(world, 'n0'), hubBefore)
    const leafMoved = dist(posOf(world, 'n118'), positions.get('n118') ?? { x: 0, y: 0 })
    expect(hubMoved).toBeLessThan(15)      // 度 120 的枢纽基本焊住
    expect(leafMoved).toBeGreaterThan(55)  // 而叶子跟着走（约被拖位移的三成）
  })

  it('原位锚点：邻居只跟一部分、远处基本不动、且图不会被整片搬走', () => {
    const world = dragLeaf()
    const before = new Map(world.nodes.map(n => [n.id, { x: n.x, y: n.y }]))
    stepN(world, 150)
    const moved = (id: string) => {
      const b = before.get(id)
      const n = world.nodes[world.index.get(id) ?? 0]
      return b && n ? dist(n, b) : 0
    }
    const near = moved('n118')   // 一跳
    const far = moved('n60')     // 远离被拖节点
    // 一跳跟了相当一部分，但**没有**跟着位移 200 整片平移过去
    expect(near).toBeGreaterThan(60)
    expect(near).toBeLessThan(190)
    // 远处节点几乎不动（锚点把链式传播的拉力顶住了）—— 这是「整张图不会被搬走」的判据
    expect(far).toBeLessThan(near * 0.35)
  })

  it('松手之后朝原位回缩：把钉住的节点放开，图会自己收回去', () => {
    const { graph, positions } = gridGraph()
    const world = createPhysicsWorld(graph, positions, radiiOf(graph))
    const home = positions.get('n119') ?? { x: 0, y: 0 }
    pinAt(world, 'n119', home.x + 200, home.y)
    stepN(world, 120)
    const pulled = dist(posOf(world, 'n118'), positions.get('n118') ?? { x: 0, y: 0 })
    expect(pulled).toBeGreaterThan(50)
    // 放开被拖节点（不再钉住）⇒ 邻居的边弹簧不再被拉伸，锚点把它们拉回原位
    const dragged = world.nodes[world.index.get('n119') ?? 0]
    if (dragged) dragged.pinned = false
    stepN(world, 400)
    const settled = dist(posOf(world, 'n118'), positions.get('n118') ?? { x: 0, y: 0 })
    expect(settled).toBeLessThan(pulled * 0.5)
  })

  it('数值稳定：速度被钳住、坐标不出 NaN、能量随时间收敛', () => {
    const world = dragLeaf()
    // 极端拖动：一步跳 5000 单位
    pinAt(world, 'n119', 5000, 5000)
    for (let i = 0; i < 200; i++) {
      stepPhysics(world)
      for (const n of world.nodes) {
        expect(Number.isFinite(n.x)).toBe(true)
        expect(Number.isFinite(n.y)).toBe(true)
        expect(Math.hypot(n.vx, n.vy)).toBeLessThanOrEqual(DEFAULT_PHYSICS.maxSpeed + 1e-6)
      }
    }
    const afterJump = physicsEnergy(world)
    stepN(world, 300)
    expect(physicsEnergy(world)).toBeLessThan(afterJump)
  })

  it('确定性：同一份输入两次模拟得到逐位相同的坐标', () => {
    const a = dragLeaf()
    const b = dragLeaf()
    stepN(a, 90)
    stepN(b, 90)
    for (const n of a.nodes) {
      const m = b.nodes[b.index.get(n.id) ?? 0]
      expect(n.x).toBe(m?.x)
      expect(n.y).toBe(m?.y)
    }
  })
})

describe('物理模拟：软碰撞与数据写入', () => {
  it('进入个人空间的节点被推开（静止时为零，动了才作用）', () => {
    const g = graphOf([node('a'), node('b')], [])
    // 半径 10 ⇒ 个人空间 = 20 × 1.15 = 23；初始 12 已经重叠
    const positions = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: 12, y: 0 }]])
    const world = createPhysicsWorld(g, positions, radiiOf(g))
    stepN(world, 120)
    expect(dist(posOf(world, 'a'), posOf(world, 'b'))).toBeGreaterThan(20)
  })

  it('syncPhysicsToPositions 写回坐标表，且能补齐坐标表里缺的节点', () => {
    const g = graphOf([node('a'), node('b')], [edge('a', 'b')])
    const positions = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]])
    const world = createPhysicsWorld(g, positions, radiiOf(g))
    pinAt(world, 'a', 40, 0)
    stepN(world, 30)
    const target = new Map<string, Point>([['a', { x: -1, y: -1 }]])
    syncPhysicsToPositions(world, target)
    expect(target.get('a')?.x).toBeCloseTo(40, 6)
    // b 原本不在表里 ⇒ 应当被补进去
    expect(target.has('b')).toBe(true)
  })

  it('缺失坐标的节点不进模拟（防空转：那些节点没有可模拟的位置）', () => {
    const g = graphOf([node('a'), node('b')], [edge('a', 'b')])
    const positions = new Map<string, Point>([['a', { x: 0, y: 0 }]])
    const world = createPhysicsWorld(g, positions, radiiOf(g))
    expect(world.nodes.map(n => n.id)).toEqual(['a'])
    expect(world.edges).toHaveLength(0)
  })
})
