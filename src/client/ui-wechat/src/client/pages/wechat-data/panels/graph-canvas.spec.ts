/**
 * 绘制层纯函数的行为锁定（`graph-canvas.ts`）。
 *
 * 为什么这些值得锁：它们全是「画错了也能出图、只是不对」的性质 ——
 * 相机换算反了会让点击偏一个缩放倍率、命中测试不按绘制顺序会让「点 A 选中被 A 压住的 B」、
 * 尺寸档位漂了会让各档 `nodeScale` 的相对大小关系变样（那是用户调过的手感）、
 * 标签筛选规则错了会让大图糊成一片字。这些都不会让页面报错，只会在使用中慢慢显形。
 *
 * 环境用 node：本模块只 import 类型与纯函数，`document` 仅出现在 circleSprite/decodeAvatar
 * 里（绘制与解码路径），本文件不调它们。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRAPH_SETTINGS, communityColor, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import {
  MAX_LABELS,
  REVEAL_MIN_SCALE,
  avatarBudget,
  avatarCandidates,
  buildRevealPlan,
  bubbleText,
  dimOpacity,
  docColors,
  edgeBudget,
  edgeStroke,
  estimateTextWidth,
  fitCamera,
  graphTheme,
  hasAvatar,
  labelCandidates,
  medianNearestDistance,
  nodeOpacity,
  nodeRadius,
  pickNode,
  relaxCollisions,
  revealProgressAt,
  revealProgressMap,
  sceneToSvg,
  screenToWorld,
  selectEdges,
  sizeCapFor,
  MAX_SPACING_SCALE,
  MIN_SPACING_SCALE,
  spacingScale,
  worldToScreen,
  zoomAt,
  type Camera,
  type Point,
} from './graph-canvas.ts'

const S: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS }

/** 造一个节点，只给关心的字段赋值。 */
function node(id: string, extra: Partial<GNode> = {}): GNode {
  return {
    id,
    label: id,
    kind: 'person',
    weight: 100,
    radius: 20,
    community: -1,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    ...extra,
  }
}

/** 造一条边。 */
function edge(source: string, target: string, kind: GEdge['kind'], weight = 1): GEdge {
  return { source, target, weight, dist: 100, kind }
}

const VIEW = { w: 800, h: 600 }

describe('节点尺寸：与改前 ECharts 版逐档一致', () => {
  it('sizeCapFor 的分档边界', () => {
    expect(sizeCapFor(1)).toBe(60)
    expect(sizeCapFor(120)).toBe(60)
    expect(sizeCapFor(121)).toBe(44)
    expect(sizeCapFor(300)).toBe(44)
    expect(sizeCapFor(301)).toBe(34)
    expect(sizeCapFor(800)).toBe(34)
    expect(sizeCapFor(801)).toBe(26)
    expect(sizeCapFor(2000)).toBe(26)
    expect(sizeCapFor(2001)).toBe(22)
  })

  it('半径 = max(8, 基础半径×nodeScale)，再夹到 [8, sizeCap/2]', () => {
    const big = node('a', { radius: 34 })
    // nodeScale 0.4 时 34×0.4 = 13.6 → 落在下限之上
    expect(nodeRadius(big, { ...S, nodeScale: 0.4 }, 100)).toBeCloseTo(13.6, 6)
    // 下限：很小的基础半径×很小的缩放也要看得见
    expect(nodeRadius(node('b', { radius: 5 }), { ...S, nodeScale: 0.4 }, 100)).toBe(8)
    // 上限：节点多时被 sizeCap 压住（100 节点的 cap 是 60 → 半径 30）
    expect(nodeRadius(node('c', { radius: 34 }), { ...S, nodeScale: 4 }, 100)).toBe(30)
  })

  it('nodeScale 决定相对大小，且在上限之内单调', () => {
    const n = node('a', { radius: 30 })
    // 100 节点的上限是 30（sizeCap 60 / 2），故意让两个档位都落在上限之下
    const small = nodeRadius(n, { ...S, nodeScale: 0.4 }, 100)
    const large = nodeRadius(n, { ...S, nodeScale: 0.6 }, 100)
    expect(small).toBeCloseTo(12, 6)
    expect(large).toBeCloseTo(18, 6)
    expect(large).toBeGreaterThan(small)
  })

  it('超过上限时被压平 —— 上限存在的意义就是防止节点互相盖住', () => {
    const n = node('a', { radius: 30 })
    const cap = sizeCapFor(1000) / 2
    expect(nodeRadius(n, { ...S, nodeScale: 4 }, 1000)).toBe(cap)
    expect(nodeRadius(n, { ...S, nodeScale: 20 }, 1000)).toBe(cap)
  })
})

describe('头像预算与适用范围', () => {
  it('小图全覆盖，大图封顶 320（默认「节点上限」是 250，必须落在全覆盖区间内）', () => {
    expect(avatarBudget(1)).toBe(1)
    expect(avatarBudget(250)).toBe(250)
    expect(avatarBudget(320)).toBe(320)
    expect(avatarBudget(321)).toBe(320)
    expect(avatarBudget(10000)).toBe(320)
  })

  it('笔记与未创建笔记没有头像，人/群/我都有', () => {
    expect(hasAvatar(node('a', { kind: 'person' }))).toBe(true)
    expect(hasAvatar(node('g', { kind: 'group' }))).toBe(true)
    expect(hasAvatar(node('self', { kind: 'self' }))).toBe(true)
    expect(hasAvatar(node('note:1', { kind: 'note' }))).toBe(false)
    expect(hasAvatar(node('kb:x', { kind: 'stub', stub: true }))).toBe(false)
  })

  it('候选顺序：自身永远最前，其余按权重降序', () => {
    const nodes = [
      node('a', { weight: 300 }),
      node('self', { kind: 'self', weight: 0 }),
      node('b', { weight: 500 }),
    ]
    expect(avatarCandidates(nodes, 10).map(n => n.id)).toEqual(['self', 'b', 'a'])
  })

  it('预算不够时「我」也留得住 —— 它的权重恒为 0，按权重排会被满图好友挤掉', () => {
    const nodes = [
      node('self', { kind: 'self', weight: 0 }),
      ...Array.from({ length: 300 }, (_, i) => node('p' + i, { weight: 1000 - i })),
    ]
    const picked = avatarCandidates(nodes, 240)
    expect(picked).toHaveLength(240)
    expect(picked[0]?.id).toBe('self')
    // 截掉的是权重最低的那批，不是自身
    expect(picked.some(n => n.id === 'p299')).toBe(false)
    expect(picked.some(n => n.id === 'p0')).toBe(true)
  })

  it('笔记与未创建笔记不进候选（拿 pseudo username 去查必然失败）', () => {
    const nodes = [node('note:1', { kind: 'note' }), node('kb:x', { kind: 'stub', stub: true }), node('a')]
    expect(avatarCandidates(nodes, 10).map(n => n.id)).toEqual(['a'])
    expect(avatarCandidates(nodes, 0)).toEqual([])
  })
})

describe('出现动画：由一个节点逐个衍生出全部节点', () => {
  /** self → a → b（两跳）+ c（孤岛，谁也不连）。坐标按距离排开。 */
  const nodes = [
    node('self', { kind: 'self', weight: 0, x: 0, y: 0 }),
    node('a', { weight: 300, x: 10, y: 0 }),
    node('b', { weight: 200, x: 40, y: 0 }),
    node('c', { weight: 999, x: 500, y: 0 }),
  ]
  const edges = [edge('self', 'a', 'intimacy'), edge('a', 'b', 'common')]
  const pos = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y }]))

  it('层序走 BFS：起点最先、一跳次之、二跳再次；孤岛接在最后', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    expect(plan.order).toEqual(['self', 'a', 'b', 'c'])
    expect(plan.delayOf.get('self')).toBe(0)
    expect(plan.delayOf.get('a')!).toBeGreaterThan(plan.delayOf.get('self')!)
    expect(plan.delayOf.get('b')!).toBeGreaterThan(plan.delayOf.get('a')!)
    expect(plan.delayOf.get('c')!).toBeGreaterThan(plan.delayOf.get('b')!)
  })

  it('同层按到起点的距离升序 —— 从中心一圈圈向外，而不是按权重跳着亮', () => {
    const layer = [
      node('self', { kind: 'self', x: 0, y: 0 }),
      node('far', { weight: 9, x: 400, y: 0 }),
      node('near', { weight: 1, x: 20, y: 0 }),
    ]
    const p = new Map(layer.map(n => [n.id, { x: n.x, y: n.y }]))
    const es = [edge('self', 'far', 'intimacy'), edge('self', 'near', 'intimacy')]
    // 近的权重更低，也要先出现：顺序由距离决定，权重只在距离相同时兜底
    expect(buildRevealPlan(layer, es, 'self', p).order).toEqual(['self', 'near', 'far'])
  })

  it('连通的节点全部排进时间表 —— 漏掉谁，动画放完那张图就是不完整的', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    expect(plan.order).toHaveLength(nodes.length)
    expect(new Set(plan.order).size).toBe(nodes.length)
    for (const n of nodes) expect(plan.delayOf.has(n.id)).toBe(true)
  })

  it('总时长 = 最后出现者的时刻 + 淡入时长', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    const lastDelay = Math.max(...plan.delayOf.values())
    expect(plan.totalMs).toBe(lastDelay + plan.timing.fadeMs)
    expect(plan.totalMs).toBeGreaterThan(plan.timing.fadeMs)
  })

  it('进度：时刻未到为 0、淡入结束为 1、中间单调递增且落在 (0,1)', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    const c = plan.delayOf.get('c')!
    expect(revealProgressAt(plan, 'c', 0)).toBe(0)
    expect(revealProgressAt(plan, 'c', c - 1)).toBe(0)
    expect(revealProgressAt(plan, 'c', c + plan.timing.fadeMs)).toBe(1)
    expect(revealProgressAt(plan, 'c', plan.totalMs + 10_000)).toBe(1)
    const mid = revealProgressAt(plan, 'c', c + plan.timing.fadeMs / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    let prev = -1
    for (let t = c; t <= c + plan.timing.fadeMs; t += 10) {
      const v = revealProgressAt(plan, 'c', t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('不在时间表里的节点按 1（动画进行中新加的节点不该被藏起来）', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    expect(revealProgressAt(plan, '后来才有的节点', 0)).toBe(1)
  })

  it('进度表覆盖整个 order（paint 每帧读的就是它）', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    const map = revealProgressMap(plan, 0)
    expect(map.size).toBe(plan.order.length)
    expect([...map.values()].every(v => v === 0 || v === 1)).toBe(true)
    // 起点在 0 时刻就是「刚开始淡入」，不是已经完成
    expect(map.get('self')).toBe(0)
    expect(revealProgressMap(plan, plan.totalMs).get('c')).toBe(1)
  })

  it('起点不存在时退回权重最高的节点（知识图谱里没有「我」）', () => {
    const plan = buildRevealPlan(nodes, edges, 'self', pos)
    const kn = [node('note:1', { kind: 'note', weight: 3 }), node('note:2', { kind: 'note', weight: 9 })]
    const kp = new Map(kn.map(n => [n.id, { x: n.x, y: n.y }]))
    expect(buildRevealPlan(kn, [edge('note:1', 'note:2', 'wiki')], 'self', kp).order[0]).toBe('note:2')
    // 社交图谱的起点照旧
    expect(plan.order[0]).toBe('self')
  })

  it('空图给出 totalMs 0（调用方据此跳过动画）', () => {
    expect(buildRevealPlan([], [], 'self').totalMs).toBe(0)
    expect(buildRevealPlan([], [], 'self').order).toEqual([])
  })

  it('起始半径比例在 (0,1)：从 0 长出来看不出是头像，太大就只有淡入没有生长', () => {
    expect(REVEAL_MIN_SCALE).toBeGreaterThan(0)
    expect(REVEAL_MIN_SCALE).toBeLessThan(1)
  })

  it('确定性：同样的输入给出同样的时间表', () => {
    const a = buildRevealPlan(nodes, edges, 'self', pos)
    const b = buildRevealPlan(nodes, edges, 'self', pos)
    expect(a.order).toEqual(b.order)
    expect([...a.delayOf.entries()]).toEqual([...b.delayOf.entries()])
    expect(a.totalMs).toBe(b.totalMs)
  })
})

describe('相机数学', () => {
  const cam: Camera = { x: 120, y: -80, k: 1.75 }

  it('世界 ↔ 屏幕 互逆', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 120, y: -80 }, { x: -640, y: 480 }]) {
      const s = worldToScreen(cam, VIEW, p.x, p.y)
      const back = screenToWorld(cam, VIEW, s.x, s.y)
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })

  it('相机中心映射到视口正中', () => {
    const s = worldToScreen(cam, VIEW, cam.x, cam.y)
    expect(s.x).toBeCloseTo(VIEW.w / 2, 9)
    expect(s.y).toBeCloseTo(VIEW.h / 2, 9)
  })

  it('缩放锚点保持不动（滚轮缩放不会「跑」）', () => {
    const anchor = { x: 260, y: 410 }
    const worldBefore = screenToWorld(cam, VIEW, anchor.x, anchor.y)
    const next = zoomAt(cam, VIEW, anchor.x, anchor.y, 1.6)
    const worldAfter = screenToWorld(next, VIEW, anchor.x, anchor.y)
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6)
    expect(next.k).toBeCloseTo(cam.k * 1.6, 6)
  })

  it('缩放钳在 [0.4, 5]，到顶后再拉也不动', () => {
    let c: Camera = { x: 0, y: 0, k: 1 }
    for (let i = 0; i < 40; i++) c = zoomAt(c, VIEW, 100, 100, 1.3)
    expect(c.k).toBe(5)
    const capped = zoomAt(c, VIEW, 100, 100, 1.3)
    expect(capped).toBe(c)
    for (let i = 0; i < 80; i++) c = zoomAt(c, VIEW, 100, 100, 0.7)
    expect(c.k).toBe(0.4)
  })

  it('fitCamera 把所有节点（含半径）装进视口', () => {
    const nodes = [node('a', { radius: 30 }), node('b', { radius: 10 }), node('c', { radius: 20 })]
    const pos = new Map<string, Point>([['a', { x: -500, y: 0 }], ['b', { x: 500, y: 300 }], ['c', { x: 0, y: -400 }]])
    const fit = fitCamera(nodes, pos, n => n.radius, VIEW)
    expect(fit).not.toBeNull()
    for (const n of nodes) {
      const p = pos.get(n.id)
      if (!p || !fit) continue
      const s = worldToScreen(fit, VIEW, p.x, p.y)
      expect(s.x - n.radius * fit.k).toBeGreaterThanOrEqual(0)
      expect(s.x + n.radius * fit.k).toBeLessThanOrEqual(VIEW.w)
      expect(s.y - n.radius * fit.k).toBeGreaterThanOrEqual(0)
      expect(s.y + n.radius * fit.k).toBeLessThanOrEqual(VIEW.h)
    }
  })

  it('fitCamera 对空图/零尺寸返回 null（调用方保持原相机）', () => {
    expect(fitCamera([], new Map(), () => 10, VIEW)).toBeNull()
    expect(fitCamera([node('a')], new Map([['a', { x: 0, y: 0 }]]), () => 10, { w: 0, h: 0 })).toBeNull()
  })
})

describe('间距归一：把 FA2 的无量纲坐标对齐到节点半径', () => {
  const radii = new Map<string, number>()
  const positions = new Map<string, Point>()

  it('medianNearestDistance：等距点阵的中位最近邻距离就是那个间距', () => {
    const nodes: GNode[] = []
    const pos = new Map<string, Point>()
    for (let i = 0; i < 4; i++) {
      nodes.push(node(`n${i}`))
      pos.set(`n${i}`, { x: i * 50, y: 0 })
    }
    expect(medianNearestDistance(nodes, pos)).toBeCloseTo(50, 6)
  })

  it('少节点也能算出（真机实测的 2 节点案例：FA2 只给出 ±6 的量级）', () => {
    const nodes = [node('a'), node('b')]
    const pos = new Map<string, Point>([['a', { x: -6, y: 5 }], ['b', { x: 6, y: -5 }]])
    const d = medianNearestDistance(nodes, pos)
    expect(d).toBeCloseTo(Math.hypot(12, 10), 6)
  })

  it('spacingScale：会重叠时放大到「nodeGap × 两倍中位半径」（受 8× 上限约束）', () => {
    const nodes: GNode[] = []
    const pos = new Map<string, Point>()
    for (let i = 0; i < 6; i++) {
      nodes.push(node(`n${i}`))
      pos.set(`n${i}`, { x: i * 3, y: 0 })
      radii.set(`n${i}`, 10)
    }
    // 间距 3 < 两倍半径 20 ⇒ 必然相交。期望放大到 2×20 = 40，即 40/3 ≈ 13.3×，
    // 但倍率上限是 8 ⇒ 取 8，结果间距 24 —— 关键性质是「不再相交」，不是精确命中目标值。
    const scale = spacingScale(nodes, radii, pos, 2)
    expect(scale).toBe(8)
    for (const p of pos.values()) { p.x *= scale; p.y *= scale }
    expect(medianNearestDistance(nodes, pos)).toBeGreaterThan(20)
  })

  it('间距偏松时按目标压缩（「紧凑」就来自这一步，改前只放大所以松是永久的）', () => {
    const nodes: GNode[] = []
    const pos = new Map<string, Point>()
    const radii = new Map<string, number>()
    for (let i = 0; i < 6; i++) {
      nodes.push(node(`n${i}`))
      pos.set(`n${i}`, { x: i * 60, y: 0 })
      radii.set(`n${i}`, 10)
    }
    // 目标 = nodeGap 1.7 × 两倍中位半径 20 = 34；当前 60 ⇒ 压到 34/60
    const scale = spacingScale(nodes, radii, pos, 1.7)
    expect(scale).toBeCloseTo(34 / 60, 6)
    for (const p of pos.values()) { p.x *= scale; p.y *= scale }
    expect(medianNearestDistance(nodes, pos)).toBeCloseTo(34, 6)
  })

  it('真机那条对照：群组网络的间距是好友网络的 2.2 倍，归一后两者同为 34', () => {
    // 实测数据：好友网络 最近邻/中位半径 = 3.44（间距 27.5 / 半径 8），群组网络 = 7.61（60.8 / 8）。
    // 同一个界面里两种密度，群组网络看上去就是「几个小点撒在一大片空地上」。
    const pair = (d0: number): number => {
      const nodes = [node('a'), node('b')]
      const pos = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: d0, y: 0 }]])
      const r = new Map([['a', 10], ['b', 10]])
      return d0 * spacingScale(nodes, r, pos, 1.7)
    }
    expect(pair(27.5)).toBeCloseTo(34, 1)
    expect(pair(60.8)).toBeCloseTo(34, 1)
  })

  it('压缩有下限（极端稀疏的坐标不会把整图压成一个点）', () => {
    const nodes = [node('a'), node('b')]
    const far = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: 5000, y: 0 }]])
    const r = new Map([['a', 10], ['b', 10]])
    expect(spacingScale(nodes, r, far, 1.7)).toBe(MIN_SPACING_SCALE)
  })

  it('真机那条 2 节点用例：归一后圆心间距大于两半径之和（不再叠在一起）', () => {
    const nodes = [node('note', { kind: 'note' }), node('kb:x', { kind: 'stub', stub: true })]
    const pos = new Map<string, Point>([['note', { x: -6, y: 5 }], ['kb:x', { x: 6, y: -5 }]])
    const r = new Map<string, number>([['note', 21], ['kb:x', 12]])
    const scale = spacingScale(nodes, r, pos, DEFAULT_GRAPH_SETTINGS.nodeGap)
    const a = pos.get('note')
    const b = pos.get('kb:x')
    expect(a && b).toBeTruthy()
    if (!a || !b) return
    const d = Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale)
    expect(d).toBeGreaterThan(21 + 12)
  })

  it('算不出来时返回 1（不缩放），而不是 0 或 NaN 把整图压成一个点', () => {
    expect(spacingScale([node('a')], new Map(), new Map(), 1.7)).toBe(1)
    expect(spacingScale([], new Map(), new Map(), 1.7)).toBe(1)
    // 只有一个有效坐标
    const pos = new Map<string, Point>([['a', { x: 0, y: 0 }]])
    expect(spacingScale([node('a'), node('b')], new Map(), pos, 1.7)).toBe(1)
  })

  it('缩放系数被夹在 [1/8, 8]（两端都夹：既不拉成噪点，也不压成一个点）', () => {
    const nodes = [node('a'), node('b')]
    const tiny = new Map<string, Point>([['a', { x: 0, y: 0 }], ['b', { x: 1e-7, y: 0 }]])
    const s = spacingScale(nodes, new Map([['a', 10], ['b', 10]]), tiny, 1.7)
    expect(s).toBeGreaterThanOrEqual(MIN_SPACING_SCALE)
    expect(s).toBeLessThanOrEqual(MAX_SPACING_SCALE)
    expect(s).toBe(MAX_SPACING_SCALE)
  })

  it('nodeGap 拉大 → 放大倍率随之变大（间距滑杆在安全网里也生效）', () => {
    const nodes: GNode[] = []
    const pos = new Map<string, Point>()
    for (let i = 0; i < 5; i++) { nodes.push(node(`n${i}`)); pos.set(`n${i}`, { x: i * 4, y: 0 }) }
    const r = new Map<string, number>(nodes.map(n => [n.id, 10]))
    expect(spacingScale(nodes, r, pos, 3)).toBeGreaterThan(spacingScale(nodes, r, pos, 1))
  })

  it('大图的近似路径也给得出合理值（避免 10000 节点的 O(n²) 精确解）', () => {
    const nodes: GNode[] = []
    const pos = new Map<string, Point>()
    const n = 1600
    for (let i = 0; i < n; i++) {
      nodes.push(node(`n${i}`))
      // 网格铺开：真实最近邻距离是 10
      pos.set(`n${i}`, { x: (i % 40) * 10, y: Math.floor(i / 40) * 10 })
    }
    const d = medianNearestDistance(nodes, pos)
    expect(d).toBeGreaterThan(5)
    expect(d).toBeLessThan(20)
  })
})

describe('连线挑选：骨架保底，且互惠边不被「我→对方」的辐条挤掉', () => {
  /**
   * 真机形态的好友网络：251 个渲染节点（self + p0..p249），250 条辐条 + commonN 条互惠边。
   *
   * 刻意让互惠边**两端都在渲染集合里** —— 改前那种「a_i—b_i 是边表里才有的假节点」的夹具
   * 会让骨架数远大于节点数，把预算算歪，测出一条现实中不存在的曲线。
   */
  function friendNetwork(commonN: number): { edges: GEdge[]; nodes: GNode[] } {
    const nodes = [node('self'), ...Array.from({ length: 250 }, (_, i) => node(`p${i}`))]
    const edges: GEdge[] = []
    for (let i = 0; i < 250; i++) edges.push(edge('self', `p${i}`, 'intimacy', 500 - i))
    for (let i = 0; i < commonN; i++) {
      const a = `p${i % 250}`
      const b = `p${(i * 7 + 11) % 250}`
      if (a !== b) edges.push(edge(a, b, 'common', 1 + (i % 9)))
    }
    return { edges, nodes }
  }

  /** 群组网络形态：65 个渲染节点（self + g0..g63），64 条辐条 + 互惠边。 */
  function groupNetwork(commonN: number): { edges: GEdge[]; nodes: GNode[] } {
    const nodes = [node('self'), ...Array.from({ length: 64 }, (_, i) => node(`g${i}`, { kind: 'group' }))]
    const edges: GEdge[] = []
    for (let i = 0; i < 64; i++) edges.push(edge('self', `g${i}`, 'intimacy', 300 - i))
    for (let i = 0; i < commonN; i++) {
      const a = `g${i % 64}`
      const b = `g${(i * 5 + 7) % 64}`
      if (a !== b) edges.push(edge(a, b, 'common', 1 + (i % 5)))
    }
    return { edges, nodes }
  }

  /**
   * 「本来有边、画完之后一条线都没有」的节点数 —— 这就是用户看到的「节点缺少连线」。
   * 刻意把「全量里就没有边」的节点排除掉：那种节点是真·孤立点，不是丢线。
   */
  function orphans(all: readonly GEdge[], drawn: readonly GEdge[], nodes: readonly GNode[]): number {
    const count = (edges: readonly GEdge[]): Map<string, number> => {
      const deg = new Map<string, number>(nodes.map(n => [n.id, 0]))
      for (const e of edges) {
        if (deg.has(e.source)) deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
        if (deg.has(e.target)) deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
      }
      return deg
    }
    const before = count(all)
    const after = count(drawn)
    let lost = 0
    for (const n of nodes) if ((before.get(n.id) ?? 0) > 0 && (after.get(n.id) ?? 0) === 0) lost++
    return lost
  }

  it('★ 回归点：251 节点 / 998 边的好友网络，画完之后不能有「有边却没画」的节点', () => {
    // 改前实测：预算 226，250 条辐条被截到 113 条 —— 137 个节点在画面上一条线都没有。
    const { edges: all, nodes: ns } = friendNetwork(748)
    const picked = selectEdges(all, ns)
    expect(orphans(all, picked, ns)).toBe(0)
    // 全部辐条都在（骨架 = 每个节点最强的那条边，这里每条辐条都是对应 p_i 的唯一/最强边）
    expect(picked.filter(e => e.kind === 'intimacy').length).toBe(250)
    // 互惠边仍然被画出来（上一轮的回归点：不能被辐条挤光）
    expect(picked.filter(e => e.kind === 'common').length).toBeGreaterThan(0)
    // 额度改成「节点数 × 5」之后，默认规模（998 / 251 = 3.98 条/节点）已经**全画** ——
    // 这正是修「同群成员之间没有链接」要的结果，所以这里断言的是「一条不裁」而不是「仍有裁」。
    expect(picked.length).toBe(all.length)
    expect(picked.length).toBe(edgeBudget(ns.length, all.length, 250))
  })

  it('额度仍然管用：更密的图照样按权重截断（不是把预算变成摆设）', () => {
    const nodes = [node('self'), ...Array.from({ length: 300 }, (_, i) => node(`p${i}`))]
    const all: GEdge[] = []
    for (let i = 0; i < 300; i++) all.push(edge('self', `p${i}`, 'intimacy', 900 - i))
    // 5000 条同群边 / 301 节点 ⇒ 额度 1505 明显不够
    for (let i = 0; i < 5000; i++) all.push(edge(`p${i % 300}`, `p${(i * 7 + 11) % 300}`, 'common', 999 - (i % 999)))
    const picked = selectEdges(all, nodes)
    expect(picked.length).toBe(edgeBudget(nodes.length, all.length, 300))
    expect(picked.length).toBeLessThan(all.length)
  })

  it('群组网络：辐条全留，其余预算给互惠边', () => {
    const { edges: all, nodes: ns } = groupNetwork(627)
    const picked = selectEdges(all, ns)
    expect(orphans(all, picked, ns)).toBe(0)
    expect(picked.filter(e => e.kind === 'intimacy').length).toBe(64)
    expect(picked.length).toBe(edgeBudget(ns.length, all.length, 64))
    expect(picked.filter(e => e.kind === 'common').length).toBe(picked.length - 64)
  })

  it('骨架不会把预算顶穿（总边数就是预算值，不会多画）', () => {
    const { edges: all, nodes: ns } = friendNetwork(4000)
    expect(selectEdges(all, ns).length).toBe(edgeBudget(ns.length, all.length, 250))
  })

  it('边数不超过预算时原样返回（防空转：上面几条得有被截断的对象）', () => {
    const { edges: all, nodes: ns } = friendNetwork(3)
    expect(selectEdges(all, ns).length).toBe(all.length)
  })

  it('骨架认「最强边」：辐条权重更高时骨架全落在辐条上', () => {
    const nodes = [node('self'), ...Array.from({ length: 400 }, (_, i) => node(`p${i}`))]
    const all: GEdge[] = []
    // 辐条权重（5000+）刻意全部高于互惠边（1000-）⇒ 每个 p_i 的最强边就是它自己的辐条
    for (let i = 0; i < 400; i++) all.push(edge('self', `p${i}`, 'intimacy', 5000 + i))
    // 2400 条同群边 / 401 节点 ⇒ 额度 2005 < 2800，必须真的截断才有观测对象
    for (let i = 0; i < 2400; i++) all.push(edge(`p${i % 400}`, `p${(i * 7 + 11) % 400}`, 'common', 1000 - i))
    const picked = selectEdges(all, nodes)
    const intimacy = picked.filter(e => e.kind === 'intimacy')
    const common = picked.filter(e => e.kind === 'common')
    expect(intimacy.length).toBe(400)
    expect(orphans(all, picked, nodes)).toBe(0)
    expect(picked.length).toBe(edgeBudget(nodes.length, all.length, 400))
    expect(picked.length).toBeLessThan(all.length)
    // 互惠边内部仍按权重降序取前 N：被丢掉的都不如留下的
    const dropped = all.filter(e => e.kind === 'common' && !common.includes(e))
    expect(common.length).toBeGreaterThan(0)
    expect(dropped.length).toBeGreaterThan(0)
    expect(Math.min(...common.map(e => e.weight))).toBeGreaterThan(Math.max(...dropped.map(e => e.weight)))
  })

  it('保持输入顺序（绘制顺序稳定，便于逐帧比较）', () => {
    const { edges: all, nodes: ns } = friendNetwork(30)
    const picked = selectEdges(all, ns)
    const keys = picked.map(e => e.source + '|' + e.target)
    const sorted = [...keys].sort((a, b) => all.findIndex(e => e.source + '|' + e.target === a) - all.findIndex(e => e.source + '|' + e.target === b))
    expect(keys).toEqual(sorted)
  })

  it('没有边就没有线，且不报错', () => {
    const nodes = [node('a'), node('b')]
    expect(selectEdges([], nodes)).toEqual([])
  })

  /**
   * 真机默认规模的**同群关系**图：251 节点、250 条辐条 + 750 条同群边（= 3.98 条/节点，
   * 与真机实测的 998 边 / 251 节点同档）。
   *
   * 用户报的问题是「同一群组内成员之间没有生成双向链接」。实测下来**生成侧一条不缺**
   * （748 条同群边全部 bidirectional=true，与 group_codes 独立推出的关系逐条相等），
   * 缺的是**画出来**：预算 0.9 条/节点只放得下 226 条，251 个人里 103 个的同群伙伴
   * 在画面上一条线都没有。这一组断言守的就是「不许再退回去」。
   */
  function sameGroupNetwork(): { edges: GEdge[]; nodes: GNode[] } {
    const nodes = [node('self'), ...Array.from({ length: 250 }, (_, i) => node(`p${i}`))]
    const edges: GEdge[] = []
    for (let i = 0; i < 250; i++) edges.push(edge('self', `p${i}`, 'intimacy', 500 - i))
    // 每个群给每人配 3 个同群伙伴（错开 1/2/3），合成 750 条互不重复的同群边
    for (let ring = 1; ring <= 3; ring++) {
      for (let i = 0; i < 250; i++) edges.push(edge(`p${i}`, `p${(i + ring) % 250}`, 'common', 1 + (i % 4)))
    }
    return { edges, nodes }
  }

  it('★ 同群关系一条都不许被裁：默认规模下 750 条同群边全部画出', () => {
    const { edges: all, nodes: ns } = sameGroupNetwork()
    const picked = selectEdges(all, ns)
    const allCommon = all.filter(e => e.kind === 'common')
    const pickedCommon = picked.filter(e => e.kind === 'common')
    expect(allCommon.length).toBe(750)
    expect(pickedCommon.length).toBe(allCommon.length)
    expect(picked.length).toBe(all.length)
  })

  it('★ 每个节点的同群伙伴在画面上都连得上（改前 251 个里有 103 个连不上）', () => {
    const { edges: all, nodes: ns } = sameGroupNetwork()
    const picked = selectEdges(all, ns)
    const drawn = new Set(picked.map(e => `${e.source}|${e.target}`))
    const wanted = new Map<string, Set<string>>()
    for (const e of all) {
      if (e.kind !== 'common') continue
      if (!wanted.has(e.source)) wanted.set(e.source, new Set())
      if (!wanted.has(e.target)) wanted.set(e.target, new Set())
      wanted.get(e.source)?.add(e.target)
      wanted.get(e.target)?.add(e.source)
    }
    let broken = 0
    for (const n of ns) {
      for (const other of wanted.get(n.id) ?? []) {
        if (!drawn.has(`${n.id}|${other}`) && !drawn.has(`${other}|${n.id}`)) broken++
      }
    }
    expect(broken).toBe(0)
  })

})

describe('碰撞松弛：圆心距不小于 (r1+r2)×gap', () => {
  /** n 个等半径圆，坐标由调用方给。 */
  function collideFixture(points: Point[], radius: number) {
    const nodes = points.map((_, i) => node(`n${i}`))
    const positions = new Map<string, Point>(points.map((p, i) => [`n${i}`, { ...p }]))
    const radii = new Map<string, number>(points.map((_, i) => [`n${i}`, radius]))
    return { nodes, positions, radii }
  }

  it('重叠的两个圆被推开到相切之外', () => {
    const { nodes, positions, radii } = collideFixture([{ x: 0, y: 0 }, { x: 4, y: 0 }], 10)
    relaxCollisions(nodes, positions, radii, { gap: 1, iterations: 6 })
    const a = positions.get('n0')!
    const b = positions.get('n1')!
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(20 - 1e-6)
  })

  it('本来就不重叠的不动（防空转：松弛不能把排好的图推散）', () => {
    const { nodes, positions, radii } = collideFixture([{ x: 0, y: 0 }, { x: 200, y: 0 }], 10)
    const before = JSON.stringify([...positions])
    relaxCollisions(nodes, positions, radii, { iterations: 6 })
    expect(JSON.stringify([...positions])).toBe(before)
  })

  it('skip 的节点自己不动，但会把别人推开（固定节点是障碍）', () => {
    const { nodes, positions, radii } = collideFixture([{ x: 0, y: 0 }, { x: 4, y: 0 }], 10)
    relaxCollisions(nodes, positions, radii, { gap: 1, iterations: 6, skip: new Set(['n0']) })
    expect(positions.get('n0')!.x).toBe(0)
    expect(positions.get('n0')!.y).toBe(0)
    expect(Math.abs(positions.get('n1')!.x)).toBeGreaterThanOrEqual(20 - 1e-6)
  })

  it('确定性：同输入两次结果一致（分离方向不引入随机数）', () => {
    const first = collideFixture([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], 12)
    relaxCollisions(first.nodes, first.positions, first.radii, { iterations: 6 })
    const a = JSON.stringify([...first.positions])
    const second = collideFixture([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], 12)
    relaxCollisions(second.nodes, second.positions, second.radii, { iterations: 6 })
    expect(JSON.stringify([...second.positions])).toBe(a)
  })

  it('gap 系数生效：gap 越大推得越开', () => {
    const tight = collideFixture([{ x: 0, y: 0 }, { x: 4, y: 0 }], 10)
    relaxCollisions(tight.nodes, tight.positions, tight.radii, { gap: 1, iterations: 8 })
    const loose = collideFixture([{ x: 0, y: 0 }, { x: 4, y: 0 }], 10)
    relaxCollisions(loose.nodes, loose.positions, loose.radii, { gap: 1.5, iterations: 8 })
    const d = (m: Map<string, Point>) => {
      const a = m.get('n0')!
      const b = m.get('n1')!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    expect(d(loose.positions)).toBeGreaterThan(d(tight.positions))
  })
})

describe('命中测试', () => {
  const nodes = [node('under', { radius: 30 }), node('over', { radius: 30 })]
  const pos = new Map<string, Point>([['under', { x: 0, y: 0 }], ['over', { x: 10, y: 0 }]])
  const cam: Camera = { x: 0, y: 0, k: 1 }
  const radiusOf = (n: GNode): number => n.radius

  it('重叠区命中的是叠在上面的那个（数组靠后 = 后画）', () => {
    expect(pickNode(nodes, pos, radiusOf, cam, 8, 0)).toBe('over')
  })

  it('只在半径 + 容差之外 → 不命中', () => {
    expect(pickNode(nodes, pos, radiusOf, cam, 100, 0)).toBeNull()
    // 容差 4px：半径 30 的节点在 33 处仍可命中，在 36 处不可
    expect(pickNode([nodes[0]], pos, radiusOf, cam, 33, 0)).toBe('under')
    expect(pickNode([nodes[0]], pos, radiusOf, cam, 36, 0)).toBeNull()
  })

  it('容差随缩放换算成世界单位（缩小后容差变大，而不是固定 4 个世界单位）', () => {
    const zoomedOut: Camera = { x: 0, y: 0, k: 0.5 }
    // k=0.5 时 4px 容差 = 8 世界单位 → 半径 30 的节点在 37 处仍可命中
    expect(pickNode([nodes[0]], pos, radiusOf, zoomedOut, 37, 0)).toBe('under')
    expect(pickNode([nodes[0]], pos, radiusOf, zoomedOut, 39, 0)).toBeNull()
  })

  it('没有坐标的节点不会命中（防空转：否则上一条可能只是「谁都没中」）', () => {
    expect(pickNode([node('ghost')], new Map(), () => 30, cam, 0, 0)).toBeNull()
    expect(pickNode(nodes, pos, radiusOf, cam, 8, 0)).not.toBeNull()
  })
})

describe('淡出规则', () => {
  it('社区聚焦：圈内保持，圈外几乎隐形；仅悬停预览时只轻度淡出', () => {
    expect(dimOpacity(1, null, null)).toBe(1)
    expect(dimOpacity(1, 1, null)).toBe(1)
    expect(dimOpacity(2, 1, null)).toBe(0.12)
    expect(dimOpacity(2, null, 1)).toBe(0.35)
    // 聚焦优先于悬停
    expect(dimOpacity(2, 1, 2)).toBe(0.12)
  })

  it('有悬停节点时只留它与其一阶邻居', () => {
    const view = { hoverNodeId: 'a', hoverNeighbours: new Set(['b']), focusCommunity: null, hoverCommunity: null }
    expect(nodeOpacity(node('a'), view)).toBe(1)
    expect(nodeOpacity(node('b'), view)).toBe(1)
    expect(nodeOpacity(node('c'), view)).toBe(0.15)
    // 「我」是 self 节点、community -1：悬停模式下也一样按邻居规则处理（不享受特例）
    expect(nodeOpacity(node('self', { kind: 'self' }), view)).toBe(0.15)
  })

  it('没有悬停时回落到社区规则', () => {
    const view = { hoverNodeId: null, hoverNeighbours: null, focusCommunity: 0, hoverCommunity: null }
    expect(nodeOpacity(node('a', { community: 0 }), view)).toBe(1)
    expect(nodeOpacity(node('b', { community: 3 }), view)).toBe(0.12)
  })
})

describe('边的线型', () => {
  const theme = graphTheme(true)
  const stubIds = new Set(['kb:x'])

  it('五种边各有自己的颜色，与图例一致', () => {
    expect(edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).color).toBe(theme.edgeCommon)
    expect(edgeStroke(edge('a', 'b', 'intimacy'), theme, S, stubIds).color).toBe(theme.edgeIntimacy)
    expect(edgeStroke(edge('a', 'b', 'wiki'), theme, S, stubIds).color).toBe(theme.edgeWiki)
    expect(edgeStroke(edge('a', 'b', 'source'), theme, S, stubIds).color).toBe(theme.edgeSource)
    expect(edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).color).toBe(theme.edgeClass)
  })

  it('粗细：亲密度 > 共同群 > 沉淀来源 > 同备注编号，wiki 单独一档', () => {
    const intimacy = edgeStroke(edge('a', 'b', 'intimacy'), theme, S, stubIds).width
    const common = edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).width
    const source = edgeStroke(edge('a', 'b', 'source'), theme, S, stubIds).width
    const cls = edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).width
    expect(intimacy).toBeGreaterThan(common)
    expect(common).toBeGreaterThan(source)
    // 同班级是「从备注结构推断」出来的关系，画得比任何观测到的边都细
    expect(source).toBeGreaterThan(cls)
    expect(cls).toBeGreaterThan(0)
    expect(intimacy).toBeGreaterThan(0)
  })

  it('虚线给「还不存在的笔记」与全部推断层（class / initial / mention / suggest）', () => {
    expect(edgeStroke(edge('note:1', 'kb:x', 'wiki'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('note:1', 'note:2', 'wiki'), theme, S, stubIds).dashed).toBe(false)
    expect(edgeStroke(edge('note:1', 'kb:x', 'source'), theme, S, stubIds).dashed).toBe(false)
    // 同班级边是推断出来的，虚线让它自解释（不必只靠颜色区分）
    expect(edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('a', 'b', 'initial'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).dashed).toBe(false)
    // 知识侧同理：mention（笔记标题出现在正文里）与 suggest（模型抽出的实体）都是猜的，
    // 而 contain（这一节确实在这份文件里）是结构事实 —— 虚实这条线不能画错，
    // 否则用户会把一次模型幻觉当成文档里写着的引用关系去转述。
    expect(edgeStroke(edge('note:1', 'file:37', 'mention'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('file:37', 'ent:张三', 'suggest'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('file:37', 'doc:里程碑', 'contain'), theme, S, stubIds).dashed).toBe(false)
    expect(edgeStroke(edge('file:37', 'doc:里程碑', 'contain'), theme, S, stubIds).width)
      .toBe(edgeStroke(edge('note:1', 'note:2', 'wiki'), theme, S, stubIds).width)
    expect(edgeStroke(edge('file:37', 'ent:张三', 'suggest'), theme, S, stubIds).width)
      .toBe(edgeStroke(edge('a', 'b', 'mention'), theme, S, stubIds).width)
  })

  it('edgeWidth 拉大时线跟着变粗（滑杆生效）', () => {
    const thin = edgeStroke(edge('a', 'b', 'intimacy'), theme, { ...S, edgeWidth: 0.5 }, stubIds).width
    const thick = edgeStroke(edge('a', 'b', 'intimacy'), theme, { ...S, edgeWidth: 4 }, stubIds).width
    expect(thick).toBeGreaterThan(thin)
  })

  it('edgeBudget：下限 300、按节点数给额度、且不超过实际边数', () => {
    expect(edgeBudget(10, 5)).toBe(5)
    // 下限 300（不是 180）：见 graph-budget 里 MIN_EDGE_BUDGET 的推导 ——
    // 180 会把「19 人同处一个群」（亲密度 19 + 同群 171 = 190 条）切掉 10 条。
    expect(edgeBudget(10, 5000)).toBe(300)
    // 下限之上必须仍由「节点数 × 5」接管：60 节点 → 300，61 节点 → 305（不是被 300 顶住）
    expect(edgeBudget(60, 5000)).toBe(300)
    expect(edgeBudget(61, 5000)).toBe(305)
    // 1000 节点 × 5 = 5000 ≥ 实际 5000 ⇒ 全画
    expect(edgeBudget(1000, 5000)).toBe(5000)
    expect(edgeBudget(10000, 5000)).toBe(5000)
  })

  it('edgeBudget：额度是「节点数 × 5」，真机默认规模下够画全同群关系', () => {
    // 真机实测：默认好友视图 998 边 / 251 节点 = 3.98 条/节点 ⇒ 额度 1255 > 998
    expect(edgeBudget(251, 998, 250)).toBe(998)
    // 群组网络 691 边 / 65 节点 = 10.63 条/节点 ⇒ 额度 325 < 691，仍按权重截断
    expect(edgeBudget(65, 691, 64)).toBe(325)
  })

  it('edgeBudget：超大图由绝对上限兜住（比例额度会随节点数线性膨胀）', () => {
    // 10000 节点 × 5 = 50000，但绝对上限 24000
    expect(edgeBudget(10000, 100000)).toBe(24000)
    expect(edgeBudget(10000, 100000, 9000)).toBe(24000)
  })

  it('edgeBudget：骨架是一条**下限**，不是额外额度（不会被重复计一次）', () => {
    // 骨架 600 > 节点数×5=500 ⇒ 以骨架为准；不是 500+600
    expect(edgeBudget(100, 100000, 600)).toBe(600)
    // 骨架小于额度时以额度为准
    expect(edgeBudget(100, 100000, 30)).toBe(500)
  })
})

describe('标签筛选：开关即权威', () => {
  const view = { hoverNodeId: null as string | null, selectedId: null as string | null, pinnedIds: new Set<string>() }

  /**
   * 这条是用户报回来的：「没开「全部标签」，为什么有些节点还有标签」。
   * 曾经有一条「枢纽常显」规则（权重 ≥ 最大值 15% 无条件带标签，继承自改前 ECharts 版的
   * 「权重前 12 名 + 我」），在 251 节点的图上会让四十来个节点常显 —— 与开关的字面语义冲突。
   */
  it('关闭时**一个自动标签都不画**（不再有「枢纽常显」）', () => {
    const nodes = [node('hub', { weight: 1000 }), node('mid', { weight: 200 }), node('leaf', { weight: 100 })]
    expect(labelCandidates(nodes, S, view)).toEqual([])
  })

  it('关闭时只保留交互必需的三类：悬停 / 选中 / 固定', () => {
    const nodes = [node('a', { weight: 1000 }), node('b', { weight: 1 }), node('c', { weight: 1 })]
    const ids = labelCandidates(nodes, S, { hoverNodeId: 'a', selectedId: 'b', pinnedIds: new Set(['c']) }).map(n => n.id)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('打开时所有节点参与，超过 MAX_LABELS 才截断', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`, { weight: 1000 - i }))
    expect(labelCandidates(nodes, { ...S, showLabels: true }, view).length).toBe(200)
    const many = Array.from({ length: MAX_LABELS + 50 }, (_, i) => node(`m${i}`, { weight: 1000 - i }))
    expect(labelCandidates(many, { ...S, showLabels: true }, view).length).toBe(MAX_LABELS)
  })

  it('悬停/选中/固定的标签一定在里面，且排在最前（用户当下在看的东西不该被挤掉）', () => {
    const nodes = [node('hub', { weight: 1000 }), node('leaf', { weight: 1 }), node('sel', { weight: 1 })]
    const ids = labelCandidates(nodes, S, { hoverNodeId: 'leaf', selectedId: 'sel', pinnedIds: new Set() }).map(n => n.id)
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining(['leaf', 'sel']))
  })

  it('强制项不被上限截掉（即使它在权重排序里排在很后面）', () => {
    const nodes = Array.from({ length: MAX_LABELS + 50 }, (_, i) => node(`n${i}`, { weight: 1000 - i }))
    const picked = labelCandidates(nodes, { ...S, showLabels: true }, view)
    expect(picked.length).toBe(MAX_LABELS)
    const forced = labelCandidates(nodes, { ...S, showLabels: true }, { ...view, selectedId: `n${MAX_LABELS + 40}` })
    expect(forced.some(n => n.id === `n${MAX_LABELS + 40}`)).toBe(true)
  })
})

describe('主题与文案', () => {
  it('深浅两套主题字段齐全且互不相同', () => {
    const dark = graphTheme(true)
    const light = graphTheme(false)
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    for (const [key, value] of Object.entries(dark)) {
      expect(typeof value, `主题字段 ${key} 必须是颜色字符串`).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
    expect(dark.bg).not.toBe(light.bg)
    expect(dark.label).not.toBe(light.label)
  })

  it('悬停气泡按物种给不同副标题', () => {
    expect(bubbleText(node('n', { kind: 'note', outLinks: 2, backLinks: 5 })).sub).toContain('出链 2')
    expect(bubbleText(node('s', { kind: 'stub', stub: true, backLinks: 3 })).sub).toContain('尚未创建')
    expect(bubbleText(node('g', { kind: 'group', intimacy: 42 })).sub).toContain('群聊')
    expect(bubbleText(node('f', { isFriend: true, intimacy: 42 })).sub).toContain('好友')
    expect(bubbleText(node('o', { isOfficial: true, intimacy: 1 })).sub).toContain('公众号')
    expect(bubbleText(node('self', { kind: 'self' })).sub).toContain('我')
  })

  it('estimateTextWidth：中日韩比同长度拉丁更宽', () => {
    expect(estimateTextWidth('中文四个', 11)).toBeGreaterThan(estimateTextWidth('abcd', 11))
    expect(estimateTextWidth('', 11)).toBe(0)
  })

  it('占位：社区色盘对未分组节点回落到中性灰（画布与面板侧取色一致）', () => {
    expect(communityColor(-1)).toBe('#9aa0a6')
    expect(communityColor(0)).toBe(communityColor(0))
  })
})

/**
 * 节点形状守卫：笔记与「人/群」统一为圆盘。
 *
 * 病根：笔记本体曾画成**内切于外接圆的圆角方块**，而描边环与选中光环无条件按
 * `ctx.arc(sr + …)` 画圆 —— 圆内切于方块、四角戳出环外，观感是「方块里套了个圈」。
 * 改回方块会让这个错位立刻复发，且**不报错、不崩溃、其余测试全绿**，只有人眼看得见。
 */
describe('节点形状：笔记也是圆盘，描边环才贴得住', () => {
  /** 造一个最小场景；导出路径（sceneToSvg）只碰纯函数，node 环境可直接调用。 */
  function sceneOf(nodes: GNode[]): Parameters<typeof sceneToSvg>[0] {
    const radius = 30
    return {
      nodes,
      edges: [],
      positions: new Map(nodes.map(n => [n.id, { x: 0, y: 0 }])),
      radii: new Map(nodes.map(n => [n.id, radius])),
      sprites: new Map(),
      avatarIdOf: () => '',
      camera: { x: 0, y: 0, k: 1 },
      size: VIEW,
      dark: true,
      settings: S,
      selectedId: null,
      hoverNodeId: null,
      hoverNeighbours: null,
      pinnedIds: new Set<string>(),
      focusCommunity: null,
      hoverCommunity: null,
    }
  }

  const note = (): GNode => node('note:1', { kind: 'note', community: -1, radius: 30 })

  it('导出 SVG 里笔记节点本体是 <circle>，不是圆角方块', () => {
    const svg = sceneToSvg(sceneOf([note()]), () => '')
    // 世界 (0,0) 在 800×600 视口正中 → 屏幕 (400,300)；k=1、radius=30 → sr=30
    expect(svg).toContain('<circle cx="400.00" cy="300.00" r="30.00" fill="#6d5bd0"')
    // 方块形态必须消失：只允许背景那一块 <rect width=...>
    expect(svg).not.toContain('<rect x=')
  })

  it('描边环仍在（笔记不是 stub，必须继续走 !isStub 那一支）', () => {
    const svg = sceneToSvg(sceneOf([note()]), () => '')
    expect(svg).toContain('cx="400.00" cy="300.00" r="30.75"')
  })

  it('浅色主题换浅紫，形状不变', () => {
    const sc = sceneOf([note()])
    const svg = sceneToSvg({ ...sc, dark: false }, () => '')
    expect(svg).toContain('fill="#8b7ff0"')
    expect(svg).not.toContain('<rect x=')
  })

  it('对照：人节点仍走社区色圆盘（改动没有波及其他物种）', () => {
    const person = node('u1', { kind: 'person', community: 0, isFriend: true, radius: 30 })
    const svg = sceneToSvg(sceneOf([person]), () => '')
    expect(svg).toContain(`fill="${communityColor(0)}"`)
    expect(svg).not.toContain('<rect x=')
  })

  it('源码层：两个 isNote 分支都不许出现 rect，圆角半径系数必须绝迹', () => {
    // drawScene 要真跑需要 2D context，node 环境没有 —— 按仓库既有做法用源码断言补位
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph-canvas.ts'), 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

    expect(code, 'sr * 0.32 是当初的圆角方块系数，笔记改圆后不该再有').not.toContain('sr * 0.32')

    // 逐个摘出 `} else if (isNote) {` 到同层闭合花括号的分支
    const branches: string[] = []
    let from = 0
    for (;;) {
      const at = code.indexOf('} else if (isNote) {', from)
      if (at < 0) break
      const braceAt = code.indexOf('{', at)
      let depth = 0
      let end = -1
      for (let i = braceAt; i < code.length; i++) {
        if (code[i] === '{') depth++
        else if (code[i] === '}') {
          depth--
          if (depth === 0) { end = i + 1; break }
        }
      }
      expect(end, 'isNote 分支花括号不配对').toBeGreaterThan(-1)
      branches.push(code.slice(at, end))
      from = end
    }
    // 画布一支 + SVG 一支，缺一个说明有人把分支删了/改名了
    expect(branches.length, '应恰好有两个 isNote 分支（drawScene 与 sceneToSvg）').toBe(2)
    for (const b of branches) {
      expect(b, '笔记节点本体不许用矩形（会与外圈描边错位）').not.toMatch(/rect/i)
    }
    // 画布那一支必须真的画圆
    expect(branches.some(b => b.includes('ctx.arc('))).toBe(true)
  })
})

/* ── 文档层三类节点（file / section / entity）────────────────────────────
 *
 * 这一层是「把用户登记的资料画进图里」，2026-09-19 加文件与章节、2026-09-20 加模型实体。
 * 三处容易静默画错、且**只有人眼看得见**的地方：
 *   ① 屏幕与导出 SVG 必须共用一份取色（`docColors`）。各写一份的话，分享到外的图
 *      与本人在画布上看到的是两张图 —— 颜色正是这一层唯一的身份信息（青=资料、
 *      灰蓝=结构、琥珀=模型说的）。
 *   ② 三类都不许去要头像。`avatarCandidates` 会按 username 去 `head_image.db` 找，
 *      拿文件名当 username 请求是纯浪费，而且哪天真撞上一个同名 wxid 就会画出
 *      「一个叫《项目计划书.docx》的人脸」。
 *   ③ entity 是**推断**，气泡必须自己说出来。只写「实体 · 3 份文件」会被读成
 *      「文档里明确写了三处」—— 这正是模型幻觉变成用户引用的那条路。
 */
describe('文档层三类节点的取色、头像与气泡', () => {
  /** 最小场景：导出路径只碰纯函数，node 环境可直接调用。 */
  function sceneOf(nodes: GNode[]): Parameters<typeof sceneToSvg>[0] {
    return {
      nodes,
      edges: [],
      positions: new Map(nodes.map(n => [n.id, { x: 0, y: 0 }])),
      radii: new Map(nodes.map(n => [n.id, 30])),
      sprites: new Map(),
      avatarIdOf: () => '',
      camera: { x: 0, y: 0, k: 1 },
      size: VIEW,
      dark: true,
      settings: S,
      selectedId: null,
      hoverNodeId: null,
      hoverNeighbours: null,
      pinnedIds: new Set<string>(),
      focusCommunity: null,
      hoverCommunity: null,
    }
  }

  it('三类各有自己的颜色，且深浅两套都齐（缺一个就会 fallback 成无色）', () => {
    for (const dark of [true, false]) {
      const f = docColors('file', dark)
      const s = docColors('section', dark)
      const e = docColors('entity', dark)
      const fills = [f.fill, s.fill, e.fill]
      expect(new Set(fills).size, '三类同色就等于三类不可区分').toBe(3)
      for (const c of [...fills, f.stroke, s.stroke, e.stroke]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i)
      }
      expect(f.fill).not.toBe(s.fill)
    }
    // 未知 kind 落到章节那一档（中性灰蓝），不是 undefined / 抛错
    expect(docColors('whatever', true)).toEqual(docColors('section', true))
  })

  it('导出 SVG 与屏幕同源：节点本体的 fill 就是 docColors 给的那个', () => {
    for (const kind of ['file', 'section', 'entity'] as const) {
      for (const dark of [true, false]) {
        const svg = sceneToSvg({ ...sceneOf([node(`x:${kind}`, { kind, radius: 30 })]), dark }, () => '')
        const { fill, stroke } = docColors(kind, dark)
        expect(svg, `${kind}/${dark ? 'dark' : 'light'} 的填充`).toContain(`fill="${fill}" stroke="${stroke}"`)
      }
    }
  })

  it('三类都不去要头像（人/群/self 照旧要 —— 防空转）', () => {
    for (const kind of ['file', 'section', 'entity'] as const) {
      expect(hasAvatar(node('d', { kind })), kind).toBe(false)
    }
    expect(hasAvatar(node('u1', { kind: 'person' }))).toBe(true)
    expect(hasAvatar(node('note:1', { kind: 'note' }))).toBe(false)
  })

  it('entity 的气泡自报是模型推断，而不是「文档里写着的」', () => {
    const b = bubbleText(node('ent:张三', { kind: 'entity', label: '张三', sectionFileIds: [37, 38] }))
    expect(b.title).toBe('张三')
    expect(b.sub).toContain('模型推断')
    expect(b.sub).toContain('虚线')
    expect(b.sub).toContain('2 份文件')
    // 章节是观测层，措辞不能与实体混成一种
    const s = bubbleText(node('doc:里程碑', { kind: 'section', label: '里程碑', sectionFileIds: [37, 38], backLinks: 3 }))
    expect(s.sub).not.toContain('模型')
  })

  it('源码层：docColors 只有一处定义，且 drawScene 与 sceneToSvg 两支都调用它', () => {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph-canvas.ts'), 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
    expect([...code.matchAll(/function docColors\(/g)]).toHaveLength(1)
    // 两处调用 = 屏幕一支 + 导出支；谁把某一支改回硬编码色值，这条就红
    expect([...code.matchAll(/docColors\(/g)]).toHaveLength(3)
  })
})
