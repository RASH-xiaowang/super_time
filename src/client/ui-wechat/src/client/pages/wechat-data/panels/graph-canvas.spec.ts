/**
 * 绘制层纯函数的行为锁定（`graph-canvas.ts`）—— **布局与几何**这一半。
 *
 * 为什么这些值得锁：它们全是「画错了也能出图、只是不对」的性质 ——
 * 相机换算反了会让点击偏一个缩放倍率、命中测试不按绘制顺序会让「点 A 选中被 A 压住的 B」、
 * 尺寸档位漂了会让各档 `nodeScale` 的相对大小关系变样（那是用户调过的手感）。
 * 这些都不会让页面报错，只会在使用中慢慢显形。
 *
 * M21：本文件原先 1096 行，按「几何 / 布局」与「视觉细节 / 文案」拆成两个 spec，
 * 两个文件共用 `graph-spec-fixtures.ts` 的夹具；断言一条没改。
 * 视觉那一半在 `graph-canvas-style.spec.ts`。
 *
 * 环境用 node：本模块只 import 类型与纯函数，`document` 仅出现在 circleSprite/decodeAvatar
 * 里（绘制与解码路径），本文件不调它们。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRAPH_SETTINGS } from './graph-model.ts'
import type { GEdge, GNode } from './graph-model.ts'
import {
  REVEAL_MIN_SCALE, avatarBudget, avatarCandidates, buildRevealPlan, edgeBudget, fitCamera, hasAvatar,
  medianNearestDistance, nodeRadius, pickNode, relaxCollisions, revealProgressAt, revealProgressMap, screenToWorld,
  selectEdges, sizeCapFor, MAX_SPACING_SCALE, MIN_SPACING_SCALE, spacingScale, worldToScreen, zoomAt, type Camera,
  type Point
} from './graph-canvas.ts'
import { S, node, edge, VIEW } from './graph-spec-fixtures.ts'

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
    expect(pickNode(nodes.slice(0, 1), pos, radiusOf, cam, 33, 0)).toBe('under')
    expect(pickNode(nodes.slice(0, 1), pos, radiusOf, cam, 36, 0)).toBeNull()
  })

  it('容差随缩放换算成世界单位（缩小后容差变大，而不是固定 4 个世界单位）', () => {
    const zoomedOut: Camera = { x: 0, y: 0, k: 0.5 }
    // k=0.5 时 4px 容差 = 8 世界单位 → 半径 30 的节点在 37 处仍可命中
    expect(pickNode(nodes.slice(0, 1), pos, radiusOf, zoomedOut, 37, 0)).toBe('under')
    expect(pickNode(nodes.slice(0, 1), pos, radiusOf, zoomedOut, 39, 0)).toBeNull()
  })

  it('没有坐标的节点不会命中（防空转：否则上一条可能只是「谁都没中」）', () => {
    expect(pickNode([node('ghost')], new Map(), () => 30, cam, 0, 0)).toBeNull()
    expect(pickNode(nodes, pos, radiusOf, cam, 8, 0)).not.toBeNull()
  })
})
