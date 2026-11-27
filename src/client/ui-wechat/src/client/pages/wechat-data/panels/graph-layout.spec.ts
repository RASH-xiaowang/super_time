/**
 * 力导向布局的档位、指纹、FA2 参数映射与「同一份输入 → 同一份坐标」这几条口径。
 *
 * 为什么值得锁：
 *   ① 迭代分档直接决定大图会不会卡（档位错一档就是几百毫秒）；
 *   ② 指纹算宽了会白算、算窄了会把旧布局当成新布局复用，两边都是「看起来只是有点怪」的问题；
 *   ③ 滑块 → FA2 的映射一旦在某个方向上反了（比如「斥力」拉大反而更挤），肉眼很难判定；
 *   ④ 确定性一旦破了，症状是「同一个图谱两次打开长得不一样」，人工点几下根本发现不了。
 *
 * 环境用 node：本文件只测纯逻辑。localStorage 与 Worker 在 node 里不存在，也刻意不碰
 * —— 它们分别属于持久化与调度两条旁路，不是布局本身的口径。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRAPH_SETTINGS, detectCommunities, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { fa2Settings, gatherIslands, graphDataKey, isolatedStripPositions, layoutIterations, packIslands, previewLayout, runLayout, seatIslands, spreadCommunities, warmLayoutIterations } from './graph-layout.ts'

/** 造一个节点：只写关心的字段，其余给中性默认。 */
function node(id: string, over: Partial<GNode> = {}): GNode {
  return {
    id, label: id, kind: 'person', weight: 100, radius: 10, community: -1,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    ...over,
  }
}

/** 造一条边。 */
function edge(source: string, target: string, weight = 1, kind: GEdge['kind'] = 'common'): GEdge {
  return { source, target, weight, dist: 100, kind }
}

/** 造一张链状小图：id 形如 `${prefix}0 …`，边权交替，便于做「改一处 → 指纹必须变」的对照。 */
function chainGraph(count: number, prefix = 'n'): BuiltGraph {
  const nodes = Array.from({ length: count }, (_, i) => node(`${prefix}${i}`))
  const edges = Array.from({ length: Math.max(0, count - 1) }, (_, i) =>
    edge(`${prefix}${i}`, `${prefix}${i + 1}`, 1 + (i % 3)))
  return { nodes, edges, communityCount: 0, kindCounts: {} }
}

/** 设置：默认值 + 覆盖。 */
function s(over: Partial<GraphSettings> = {}): GraphSettings {
  return { ...DEFAULT_GRAPH_SETTINGS, ...over }
}

/** 六个力度滑块在 GraphSettings 里的键名。 */
type ForceKey =
  | 'forceCentripetal' | 'forceRepulsion' | 'forceAttraction'
  | 'forceEdgeLength' | 'nodeGap' | 'communitySeparation'

/** 只改一个力度滑块，其余保持默认（用赋值而不是计算属性名，避免把键名写成字符串字面量）。 */
function withForce(key: ForceKey, value: number): GraphSettings {
  const out: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS }
  out[key] = value
  return out
}

/** 只取缩放比，让单调性断言短一些。 */
function scalingRatio(settings: GraphSettings, nodeCount = 100): number {
  return fa2Settings(settings, nodeCount).scalingRatio
}

describe('迭代分档', () => {
  it('档位边界：超过阈值才降档，边界值本身留在上一档', () => {
    expect(layoutIterations(0)).toBe(140)
    expect(layoutIterations(1)).toBe(140)
    expect(layoutIterations(250)).toBe(140)
    expect(layoutIterations(251)).toBe(90)
    expect(layoutIterations(600)).toBe(90)
    expect(layoutIterations(601)).toBe(65)
    expect(layoutIterations(1200)).toBe(65)
    expect(layoutIterations(1201)).toBe(40)
    expect(layoutIterations(2500)).toBe(40)
    expect(layoutIterations(2501)).toBe(28)
    expect(layoutIterations(100000)).toBe(28)
  })

  it('节点越多迭代越少（单调不增），且永远为正整数', () => {
    let previous = Number.POSITIVE_INFINITY
    for (const count of [1, 50, 120, 250, 251, 400, 600, 601, 900, 1200, 1201, 2000, 2500, 2501, 9000]) {
      const current = layoutIterations(count)
      expect(current).toBeLessThanOrEqual(previous)
      expect(Number.isInteger(current)).toBe(true)
      expect(current).toBeGreaterThan(0)
      previous = current
    }
  })

  it('非法节点数（负数）也落在最低档，不返回 NaN/undefined', () => {
    expect(layoutIterations(-5)).toBe(140)
  })
})

describe('热启动与力度预览', () => {
  it('热启动档位明显低于首次布局，且随节点数单调不增', () => {
    let previous = Number.POSITIVE_INFINITY
    for (const count of [1, 100, 250, 251, 600, 601, 1200, 1201, 2500, 2501, 9000]) {
      const warm = warmLayoutIterations(count)
      expect(warm).toBeGreaterThan(0)
      expect(warm).toBeLessThanOrEqual(layoutIterations(count))
      expect(warm).toBeLessThanOrEqual(previous)
      previous = warm
    }
  })

  it('预览从当前坐标前进几轮 FA2，不修改输入坐标，也不返回孤立节点', () => {
    const graph = chainGraph(8, 'preview')
    const positions = new Map(graph.nodes.map((n, i) => [n.id, { x: i * 10, y: (i % 2) * 5 }]))
    const before = JSON.stringify([...positions])
    const next = previewLayout({ graph, settings: s(), positions })
    expect(next.size).toBe(8)
    expect(JSON.stringify([...positions])).toBe(before)
    for (const n of graph.nodes) {
      const pos = next.get(n.id)
      expect(Number.isFinite(pos?.x)).toBe(true)
      expect(Number.isFinite(pos?.y)).toBe(true)
    }
    // 预览必须真的动起来；否则滑杆按住时仍然没有反馈。
    expect([...next].some(([id, pos]) => {
      const old = positions.get(id)
      return !!old && (Math.abs(pos.x - old.x) > 1e-9 || Math.abs(pos.y - old.y) > 1e-9)
    })).toBe(true)
  })

  it('预览对无边节点不强行造坐标（由调用方保留它们当前的位置）', () => {
    const graph: BuiltGraph = {
      nodes: [node('a'), node('b'), node('lonely')],
      edges: [edge('a', 'b', 2)],
      communityCount: 0,
      kindCounts: {},
    }
    const next = previewLayout({
      graph,
      settings: s(),
      positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 20, y: 0 }], ['lonely', { x: 100, y: 100 }]]),
    })
    expect([...next.keys()].sort()).toEqual(['a', 'b'])
  })
})

describe('指纹 graphDataKey', () => {
  it('同一张图稳定：两次调用同一个键', () => {
    const graph = chainGraph(8, 'a')
    expect(graphDataKey(graph, s())).toBe(graphDataKey(graph, s()))
    expect(graphDataKey(graph, s()).length).toBeGreaterThan(0)
  })

  it('与数组顺序无关：节点/边打乱后键不变', () => {
    const graph = chainGraph(8, 'b')
    const reversed = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }
    expect(graphDataKey(reversed, s())).toBe(graphDataKey(graph, s()))
    // 不只是倒序：再挑一个真正的置换
    const nodeOrder = [3, 0, 7, 1, 5, 2, 6, 4]
    const edgeOrder = [4, 1, 6, 0, 3, 5, 2]
    const scrambled = {
      ...graph,
      nodes: nodeOrder.map(i => graph.nodes[i] as GNode),
      edges: edgeOrder.map(i => graph.edges[i] as GEdge),
    }
    expect(graphDataKey(scrambled, s())).toBe(graphDataKey(graph, s()))
  })

  it('节点变化敏感：增减节点、改 id 都要变', () => {
    const base = graphDataKey(chainGraph(5, 'c'), s())
    expect(graphDataKey(chainGraph(6, 'c'), s())).not.toBe(base)
    expect(graphDataKey(chainGraph(4, 'c'), s())).not.toBe(base)
    const graph = chainGraph(5, 'c')
    const renamed = { ...graph, nodes: graph.nodes.map(n => (n.id === 'c2' ? node('c2-renamed') : n)) }
    expect(graphDataKey(renamed, s())).not.toBe(base)
  })

  it('边变化敏感：增删边、改权重、改端点都要变', () => {
    const graph = chainGraph(5, 'd')
    const base = graphDataKey(graph, s())
    expect(graphDataKey({ ...graph, edges: graph.edges.slice(1) }, s())).not.toBe(base)
    expect(graphDataKey({ ...graph, edges: [...graph.edges, edge('d0', 'd4', 1)] }, s())).not.toBe(base)
    const heavier = { ...graph, edges: graph.edges.map((e, i) => (i === 0 ? edge(e.source, e.target, e.weight + 2) : e)) }
    expect(graphDataKey(heavier, s())).not.toBe(base)
    const rerouted = { ...graph, edges: graph.edges.map((e, i) => (i === 0 ? edge(e.source, 'd3', e.weight) : e)) }
    expect(graphDataKey(rerouted, s())).not.toBe(base)
  })

  it('权重只认到千分位：亚像素级的抖动不该触发重排', () => {
    const graph = chainGraph(4, 'e')
    const nudged = { ...graph, edges: graph.edges.map(e => ({ ...e, weight: e.weight + 0.0001 })) }
    expect(graphDataKey(nudged, s())).toBe(graphDataKey(graph, s()))
  })

  it('六个力度滑块逐个改动，键都要变', () => {
    const graph = chainGraph(6, 'f')
    const base = graphDataKey(graph, s())
    const changes: Array<Partial<GraphSettings>> = [
      { forceCentripetal: DEFAULT_GRAPH_SETTINGS.forceCentripetal + 1 },
      { forceRepulsion: DEFAULT_GRAPH_SETTINGS.forceRepulsion + 1 },
      { forceAttraction: DEFAULT_GRAPH_SETTINGS.forceAttraction + 0.1 },
      { forceEdgeLength: DEFAULT_GRAPH_SETTINGS.forceEdgeLength + 0.1 },
      { nodeGap: DEFAULT_GRAPH_SETTINGS.nodeGap + 0.1 },
      { communitySeparation: DEFAULT_GRAPH_SETTINGS.communitySeparation + 0.1 },
    ]
    for (const over of changes) {
      expect(graphDataKey(graph, s(over))).not.toBe(base)
    }
  })

  it('外观与过滤参数不进指纹：改它们不该触发重排', () => {
    const graph = chainGraph(6, 'g')
    const base = graphDataKey(graph, s())
    const cosmetic: Array<Partial<GraphSettings>> = [
      { nodeScale: 1.2 }, { labelOpacity: 0.2 }, { edgeWidth: 4 }, { showArrows: true },
      { showLabels: true }, { showGrid: false }, { blurNodes: 6 }, { lockLayout: true },
      { mode: 'knowledge' }, { nodeLimit: 20 }, { minCommon: 3 }, { friendsOnly: false }, { depth: 2 },
    ]
    for (const over of cosmetic) {
      expect(graphDataKey(graph, s(over))).toBe(base)
    }
  })
})

describe('FA2 参数 fa2Settings', () => {
  it('返回值全是有限数，缩放比与引力为正', () => {
    for (const count of [1, 50, 120, 250, 3000]) {
      const params = fa2Settings(s(), count)
      for (const [key, value] of Object.entries(params)) {
        expect(Number.isFinite(value), `${key} @ ${count} = ${value}`).toBe(true)
      }
      expect(params.scalingRatio).toBeGreaterThan(0)
      expect(params.gravity).toBeGreaterThan(0)
      expect(params.slowDown).toBeGreaterThan(0)
    }
  })

  it('斥力/间距/圈子分离/连线长度越大，缩放比越大（严格单调）', () => {
    const d = DEFAULT_GRAPH_SETTINGS
    for (const key of ['forceRepulsion', 'nodeGap', 'communitySeparation', 'forceEdgeLength'] as const) {
      let previous = 0
      // 0.5 ~ 2 倍都落在钳制窗口内，因此是严格递增而不是「不变」
      for (const factor of [0.5, 0.75, 1, 1.5, 2]) {
        const current = scalingRatio(withForce(key, d[key] * factor))
        expect(current, `${key} × ${factor}`).toBeGreaterThan(previous)
        previous = current
      }
    }
  })

  it('吸引力越大：连线越短（缩放比越小）、强边影响越大', () => {
    const base = DEFAULT_GRAPH_SETTINGS.forceAttraction
    let previousRatio = Number.POSITIVE_INFINITY
    let previousInfluence = 0
    for (const factor of [0.5, 0.75, 1, 1.5, 2]) {
      const params = fa2Settings(s({ forceAttraction: base * factor }), 100)
      expect(params.scalingRatio).toBeLessThan(previousRatio)
      expect(params.edgeWeightInfluence).toBeGreaterThan(previousInfluence)
      previousRatio = params.scalingRatio
      previousInfluence = params.edgeWeightInfluence
    }
  })

  it('向心越大引力越大（严格单调）', () => {
    const base = DEFAULT_GRAPH_SETTINGS.forceCentripetal
    let previous = 0
    for (const factor of [0.5, 0.75, 1, 1.5, 2]) {
      const gravity = fa2Settings(s({ forceCentripetal: base * factor }), 100).gravity
      expect(gravity).toBeGreaterThan(previous)
      previous = gravity
    }
  })

  it('拉到极端只停在钳制窗口上，不会掉头', () => {
    const base = DEFAULT_GRAPH_SETTINGS.forceRepulsion
    // 与相邻两条同样的「previous 跟踪」写法：不按下标回读 sweep，就不需要 `as number` 断言。
    let previous = Number.NEGATIVE_INFINITY
    for (const factor of [0, 0.1, 0.25, 0.5, 1, 2, 4, 10, 100]) {
      const ratio = scalingRatio(withForce('forceRepulsion', base * factor))
      expect(ratio).toBeGreaterThanOrEqual(previous)
      previous = ratio
    }
  })

  it('节点越多布局越铺开（缩放比随节点数单调不降）', () => {
    const counts = [1, 60, 120, 240, 480, 960, 2500]
    let previous = 0
    for (const count of counts) {
      const current = fa2Settings(s(), count).scalingRatio
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
    expect(fa2Settings(s(), 960).scalingRatio).toBeGreaterThan(fa2Settings(s(), 120).scalingRatio)
  })

  it('外观/过滤参数不进布局参数：力度无关的设置改了，FA2 档位不变', () => {
    const base = fa2Settings(s(), 100)
    const cosmetic = fa2Settings(s({
      mode: 'groups', nodeLimit: 10, minCommon: 5, friendsOnly: false, depth: 3,
      nodeScale: 1.5, labelOpacity: 0.1, edgeWidth: 4, showArrows: true, showLabels: true,
      showGrid: false, blurNodes: 8, lockLayout: true,
    }), 100)
    expect(cosmetic).toEqual(base)
  })

  it('滑块是 NaN 时按默认处理，不把 NaN 喂给 FA2', () => {
    const params = fa2Settings({ ...DEFAULT_GRAPH_SETTINGS, forceRepulsion: Number.NaN }, 100)
    expect(Number.isFinite(params.scalingRatio)).toBe(true)
    expect(Number.isFinite(params.gravity)).toBe(true)
  })
})

describe('runLayout（不碰 localStorage 与 Worker）', () => {
  it('小图走主线程同步路径，坐标覆盖全部节点且为有限数', async () => {
    const graph = chainGraph(6, 'small')
    const result = await runLayout({ graph, settings: s() })
    expect(result.engine).toBe('main')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.positions.size).toBe(6)
    for (const n of graph.nodes) {
      const pos = result.positions.get(n.id)
      expect(pos, n.id).toBeDefined()
      expect(Number.isFinite(pos?.x)).toBe(true)
      expect(Number.isFinite(pos?.y)).toBe(true)
    }
  })

  it('同指纹第二次不再重算（engine: cache），坐标逐位一致', async () => {
    const graph = chainGraph(6, 'cache')
    const first = await runLayout({ graph, settings: s() })
    expect(first.engine).toBe('main')
    const second = await runLayout({ graph, settings: s() })
    expect(second.engine).toBe('cache')
    expect(second.positions).toEqual(first.positions)
  })

  it('确定性初值：同一张图重算得到完全相同的坐标', async () => {
    const target = chainGraph(6, 'determ')
    const other = chainGraph(5, 'determ-other')
    const first = await runLayout({ graph: target, settings: s() })
    expect(first.engine).toBe('main')
    // 用另一张图把「最后一张图」挤掉，让下一次真的重算（Math.random 初值会在这里露馅）
    const middle = await runLayout({ graph: other, settings: s() })
    expect(middle.engine).toBe('main')
    const again = await runLayout({ graph: target, settings: s() })
    expect(again.engine).toBe('main')
    expect(again.positions).toEqual(first.positions)
  })

  it('节点顺序换了但指纹没变 → 复用坐标（不会因为上游换个排序就重排）', async () => {
    const graph = chainGraph(6, 'order')
    const first = await runLayout({ graph, settings: s() })
    const shuffled = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }
    const second = await runLayout({ graph: shuffled, settings: s() })
    expect(second.engine).toBe('cache')
    expect(second.positions).toEqual(first.positions)
  })

  it('返回的坐标是独立副本：调用方改了不会污染缓存', async () => {
    const graph = chainGraph(5, 'copy')
    const first = await runLayout({ graph, settings: s() })
    const pos = first.positions.get('copy0')
    expect(pos).toBeDefined()
    if (pos) pos.x = 123456
    const second = await runLayout({ graph, settings: s() })
    expect(second.engine).toBe('cache')
    expect(second.positions.get('copy0')?.x).not.toBe(123456)
  })

  it('历史坐标只当作初值：坏值被忽略，好值不改变「覆盖全部节点」的承诺', async () => {
    const graph = chainGraph(5, 'saved')
    const saved = new Map([
      ['saved0', { x: 5, y: 6 }],
      ['saved1', { x: Number.NaN, y: 0 }],
      ['saved2', { x: 0, y: Number.POSITIVE_INFINITY }],
    ])
    const result = await runLayout({ graph, settings: s(), saved })
    expect(result.engine).toBe('main')
    expect(result.positions.size).toBe(5)
    for (const n of graph.nodes) {
      const pos = result.positions.get(n.id)
      expect(Number.isFinite(pos?.x), n.id).toBe(true)
      expect(Number.isFinite(pos?.y), n.id).toBe(true)
    }
  })

  it('空图不炸：返回空坐标表', async () => {
    const result = await runLayout({ graph: { nodes: [], edges: [], communityCount: 0, kindCounts: {} }, settings: s() })
    expect(result.positions.size).toBe(0)
    expect(result.engine).toBe('main')
  })

  it('≥200 节点走 Worker 分支：node 环境没有 Worker 构造器，回退主线程而不是卡住', async () => {
    const graph = chainGraph(200, 'big')
    const result = await runLayout({ graph, settings: s() })
    expect(result.engine).toBe('main')
    expect(result.positions.size).toBe(200)
  })

  /**
   * W2-7.3：主线程冷算**没有悬崖**（阈值定档用的那一条量测）。
   *
   * 量测背景（2026-10-11，本机 node 环境实测，图 = 每节点连到后面 4 个的环形稠密图）：
   *
   * | 节点 | 冷算 | 每节点 |
   * |---|---|---|
   * | 50  | 8ms  | 0.169ms |
   * | 100 | 28ms | 0.276ms |
   * | 200 | 45ms | 0.226ms |
   * | 300 | 40ms | 0.134ms |
   * | 400 | 55ms | 0.139ms |
   * | 600 | 93ms | 0.154ms |
   * | 800 | 100ms| 0.125ms |
   *
   * 结论是**没有悬崖**：每节点成本随节点数不升反降（迭代分档在起作用），800 节点也只 100ms。
   * 所以「300+ 节点切增量」这个计划前提不成立 —— 该切的时候早就切了（`WORKER_NODE_THRESHOLD`）。
   * 但源码注释里「200 以下只占几毫秒」那句是错的（实测 45ms），已改成本表。
   *
   * 这里的上界故意放到实测值的 **30 倍**：它是「别变成 O(n²) 大病」的哨兵，不是性能门禁 ——
   * 写成贴着实测值的那种会在 CI 共享 runner 上假红。
   */
  it('800 节点冷算仍在「不卡」的量级（没有悬崖，也不是 O(n²) 大病）', async () => {
    const dense = (count: number): BuiltGraph => {
      const nodes = Array.from({ length: count }, (_, i) => node('d' + String(i)))
      const edges: GEdge[] = []
      for (let i = 0; i < count; i += 1) {
        for (let d = 1; d <= 4; d += 1) edges.push(edge('d' + String(i), 'd' + String((i + d) % count), 1 + (i % 3)))
      }
      return { nodes, edges, communityCount: 0, kindCounts: {} }
    }
    const t0 = performance.now()
    const r = await runLayout({ graph: dense(800), settings: { ...s(), nodeGap: 1.5 }, fresh: true })
    const ms = performance.now() - t0
    expect(r.positions.size, '坐标没覆盖全部节点').toBe(800)
    expect(ms, `800 节点冷算 ${Math.round(ms)}ms（实测 ~100ms，上界 3000ms）⇒ 布局复杂度退化了`).toBeLessThan(3000)
  }, 120_000)
})

/**
 * 「没有任何连线」的节点单独成区。
 *
 * 为什么值得锁死：这些节点在力导向里只受斥力 + 向心力，会被甩到很远、彼此又没有任何约束，
 * 于是散成一片稀疏的点 —— 画面出现大片空白，而且 `fitCamera` 按包围盒取景，**几个散点就能
 * 把整个取景框撑大**，主簇被缩成中间一小团。所以它们的安置必须是确定性网格，而不是仿真结果。
 */
describe('单独展示区：无边节点不进力导向', () => {
  /** 一条边都没有的节点。 */
  function loners(count: number, prefix = 'iso'): GNode[] {
    return Array.from({ length: count }, (_, i) => node(`${prefix}${i}`, { radius: 10 }))
  }
  /** 已定好位的主簇（用它算包围盒）。 */
  function cluster(): Map<string, { x: number; y: number }> {
    return new Map([
      ['core0', { x: -100, y: -50 }],
      ['core1', { x: 100, y: 50 }],
      ['core2', { x: 0, y: 0 }],
    ])
  }
  const RS = (): number => 10

  it('没有无边节点时什么都不做', () => {
    expect(isolatedStripPositions([], RS, cluster(), 1.7).size).toBe(0)
  })

  it('确定性：同样的输入两次给出同样的坐标（否则「重新布局」会把它们洗牌一遍）', () => {
    const a = isolatedStripPositions(loners(7), RS, cluster(), 1.7)
    const b = isolatedStripPositions(loners(7), RS, cluster(), 1.7)
    expect([...a]).toEqual([...b])
  })

  it('★ 任意两个槽位都不重叠（槽距按最大半径算，含 nodeGap 的呼吸空间）', () => {
    const list = loners(40)
    const pos = isolatedStripPositions(list, RS, cluster(), 1.7)
    const pts = list.map(n => pos.get(n.id)).filter((p): p is { x: number; y: number } => !!p)
    expect(pts.length).toBe(40)
    let minGap = Infinity
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]
        const b = pts[j]
        if (!a || !b) continue
        minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y))
      }
    }
    // 圆心距必须大于两半径之和（10+10=20），实测槽距 = 10*2*1.7 + 6 = 40
    expect(minGap).toBeGreaterThan(20)
    expect(minGap).toBeCloseTo(40, 6)
  })

  it('整块落在主簇下方（是「单独一区」，不是混进主图里）', () => {
    const list = loners(5)
    const pos = isolatedStripPositions(list, RS, cluster(), 1.7)
    // 主簇最大 y = 50，槽距 40，空档 1.6×40 = 64 ⇒ 起点 y = 114
    for (const n of list) expect(pos.get(n.id)?.y ?? -Infinity).toBeGreaterThan(50)
  })

  it('槽距跟着 nodeGap 走（间距滑杆是疏密参数，对它同样有效）', () => {
    const tight = isolatedStripPositions(loners(4), RS, cluster(), 1)
    const loose = isolatedStripPositions(loners(4), RS, cluster(), 3)
    const x2 = (m: Map<string, { x: number; y: number }>): number => (m.get('iso1')?.x ?? 0) - (m.get('iso0')?.x ?? 0)
    expect(x2(loose)).toBeGreaterThan(x2(tight))
  })

  it('半径大的节点得到更大的槽距（不会因为半径差异而互相压住）', () => {
    const small = isolatedStripPositions(loners(3), () => 6, cluster(), 1.7)
    const big = isolatedStripPositions(loners(3), () => 24, cluster(), 1.7)
    const pitch = (m: Map<string, { x: number; y: number }>): number => (m.get('iso1')?.x ?? 0) - (m.get('iso0')?.x ?? 0)
    expect(pitch(big)).toBeGreaterThan(pitch(small))
  })
})

describe('岛要收拢', () => {
  it('散开的同岛成员收到一起，左右上下关系不变', () => {
    const nodes = [
      node('a', { community: 0 }),
      node('b', { community: 0 }),
      node('c', { community: 0 }),
    ]
    const pos = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 300, y: 0 }],
      ['c', { x: 0, y: 300 }],
    ])
    packIslands(nodes, pos)
    const a = pos.get('a')
    const b = pos.get('b')
    const c = pos.get('c')
    expect(b && a ? b.x : 0).toBeGreaterThan(a?.x ?? 0)
    expect(c && a ? c.y : 0).toBeGreaterThan(a?.y ?? 0)
    expect(Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0))).toBeLessThan(80)
    expect(Math.hypot((c?.x ?? 0) - (a?.x ?? 0), (c?.y ?? 0) - (a?.y ?? 0))).toBeLessThan(80)
  })

  it('没有坐标的同岛成员补进这座岛', () => {
    const nodes = [node('a', { community: 0 }), node('b', { community: 0 })]
    const pos = new Map<string, { x: number; y: number }>([['a', { x: 40, y: 40 }]])
    packIslands(nodes, pos)
    const b = pos.get('b')
    expect(Math.hypot((b?.x ?? 0) - 40, (b?.y ?? 0) - 40)).toBeLessThan(80)
  })

  it('小岛在上、大岛在下，排成金字塔', () => {
    const nodes = [
      node('self', { id: 'self', kind: 'self' }),
      node('a1', { community: 0 }),
      node('b1', { community: 1 }),
      node('b2', { community: 1 }),
      node('c1', { community: 2 }),
      node('c2', { community: 2 }),
      node('c3', { community: 2 }),
    ]
    const pos = new Map<string, { x: number; y: number }>([['self', { x: 80, y: 80 }]])
    seatIslands(nodes, pos, () => 10, 1.7)
    const yOf = (id: string): number => pos.get(id)?.y ?? 0
    expect(yOf('self')).toBeLessThan(yOf('a1'))
    expect(yOf('a1')).toBeLessThan(yOf('b1'))
    expect(yOf('a1')).toBeLessThan(yOf('c1'))
    expect(pos.get('self')?.x ?? 1).toBeCloseTo(0)
    const base = [pos.get('b1'), pos.get('b2'), pos.get('c1'), pos.get('c2'), pos.get('c3')]
    const xs = base.map((point) => point?.x ?? 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.abs((pos.get('a1')?.x ?? 0)))
  })

  it('圆圈形状把「我」放在中心，圈子绕在四周', () => {
    const nodes = [
      node('self', { id: 'self', kind: 'self' }),
      node('a1', { community: 0 }),
      node('b1', { community: 1 }),
      node('b2', { community: 1 }),
    ]
    const pos = new Map<string, { x: number; y: number }>([['self', { x: 40, y: 40 }]])
    seatIslands(nodes, pos, () => 10, 1.7, 'circle')
    expect(pos.get('self')).toEqual({ x: 0, y: 0 })
    const ay = pos.get('a1')?.y ?? 0
    const by = pos.get('b1')?.y ?? 0
    expect(ay * by).toBeLessThan(0)
  })

  it('圆圈分成几层，小岛靠近「我」，不会拉成一条大圆环', () => {
    const nodes = [node('self', { id: 'self', kind: 'self' })]
    for (let i = 0; i < 12; i++) nodes.push(node('p' + String(i), { community: i }))
    const pos = new Map<string, { x: number; y: number }>([['self', { x: 40, y: 40 }]])
    seatIslands(nodes, pos, () => 10, 1.7, 'circle')
    const dist = (id: string): number => Math.hypot(pos.get(id)?.x ?? 0, pos.get(id)?.y ?? 0)
    const distances = Array.from({ length: 12 }, (_, i) => dist('p' + String(i)))
    const near = Math.min(...distances)
    const far = Math.max(...distances)
    expect(pos.get('self')).toEqual({ x: 0, y: 0 })
    expect(far).toBeLessThan(100)
    expect(near).toBeGreaterThan(10)
  })

  it('离得远的岛会靠拢，谁在右边不变', () => {
    const nodes = [
      node('a', { community: 0 }),
      node('b', { community: 0 }),
      node('c', { community: 1 }),
      node('d', { community: 1 }),
    ]
    const pos = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 20, y: 0 }],
      ['c', { x: 900, y: 0 }],
      ['d', { x: 920, y: 0 }],
    ])
    gatherIslands(nodes, pos)
    const left = ((pos.get('a')?.x ?? 0) + (pos.get('b')?.x ?? 0)) / 2
    const right = ((pos.get('c')?.x ?? 0) + (pos.get('d')?.x ?? 0)) / 2
    expect(right).toBeGreaterThan(left)
    expect(right - left).toBeLessThan(400)
    expect((pos.get('b')?.x ?? 0) - (pos.get('a')?.x ?? 0)).toBeCloseTo(20)
  })
})

describe('圈子要分开', () => {
  it('只通过「我」连着的两组人，会分成两个圈子', () => {
    const nodes = [
      node('self', { kind: 'self' }),
      node('a'), node('b'), node('c'), node('d'),
    ]
    const edges = [
      edge('self', 'a', 20, 'intimacy'),
      edge('self', 'b', 20, 'intimacy'),
      edge('self', 'c', 20, 'intimacy'),
      edge('self', 'd', 20, 'intimacy'),
      edge('a', 'b', 2, 'common'),
      edge('c', 'd', 2, 'common'),
    ]
    detectCommunities(nodes, edges)
    expect(nodes.find(n => n.id === 'a')?.community).toBe(nodes.find(n => n.id === 'b')?.community)
    expect(nodes.find(n => n.id === 'c')?.community).toBe(nodes.find(n => n.id === 'd')?.community)
    expect(nodes.find(n => n.id === 'a')?.community).not.toBe(nodes.find(n => n.id === 'c')?.community)
    expect(nodes.find(n => n.id === 'a')?.community).toBeGreaterThanOrEqual(0)
  })

  it('两个圈子整团拉开，圈里的相对位置不变', () => {
    const nodes = [
      node('self'),
      node('a1', { community: 0 }),
      node('a2', { community: 0 }),
      node('b1', { community: 1 }),
      node('b2', { community: 1 }),
    ]
    const pos = new Map<string, { x: number; y: number }>([
      ['self', { x: 0, y: 0 }],
      ['a1', { x: 10, y: 0 }],
      ['a2', { x: 20, y: 0 }],
      ['b1', { x: 14, y: 6 }],
      ['b2', { x: 24, y: 6 }],
    ])
    spreadCommunities(nodes, pos, 1.6)
    expect((pos.get('a2')?.x ?? 0) - (pos.get('a1')?.x ?? 0)).toBeCloseTo(10)
    expect((pos.get('b2')?.x ?? 0) - (pos.get('b1')?.x ?? 0)).toBeCloseTo(10)
    const ax = ((pos.get('a1')?.x ?? 0) + (pos.get('a2')?.x ?? 0)) / 2
    const ay = ((pos.get('a1')?.y ?? 0) + (pos.get('a2')?.y ?? 0)) / 2
    const bx = ((pos.get('b1')?.x ?? 0) + (pos.get('b2')?.x ?? 0)) / 2
    const by = ((pos.get('b1')?.y ?? 0) + (pos.get('b2')?.y ?? 0)) / 2
    expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(40)
    expect(Math.hypot(ax - bx, ay - by)).toBeLessThan(100)
  })

  it('同一备注的人在同一座岛，共同群不会把别的单位卷进来', () => {
    const nodes = [
      node('a1', { remarkGroup: '宜州一中404', label: '甲' }),
      node('a2', { remarkGroup: '宜州一中404', label: '乙' }),
      node('b1', { label: '工商银行_南宁分行_张三' }),
      node('b2', { label: '工商银行_南宁分行_李四' }),
      node('mix', { label: '路人' }),
    ]
    detectCommunities(nodes, [
      edge('a1', 'a2', 1, 'class'),
      edge('b1', 'b2', 1, 'class'),
      edge('a1', 'b1', 3, 'common'),
      edge('a1', 'mix', 2, 'common'),
    ])
    expect(nodes.find(n => n.id === 'a1')?.community).toBe(nodes.find(n => n.id === 'a2')?.community)
    expect(nodes.find(n => n.id === 'b1')?.community).toBe(nodes.find(n => n.id === 'b2')?.community)
    expect(nodes.find(n => n.id === 'a1')?.community).not.toBe(nodes.find(n => n.id === 'b1')?.community)
    expect(nodes.find(n => n.id === 'mix')?.community).toBe(-1)
  })

  it('直接来往的人成组，过大的共同群不再单独成岛', () => {
    const friends = [node('p'), node('q')]
    detectCommunities(friends, [edge('p', 'q', 1, 'social')])
    expect(friends[0]?.community).toBe(friends[1]?.community)
    expect(friends[0]?.community).toBeGreaterThanOrEqual(0)
    const crowd = Array.from({ length: 9 }, (_, index) => node(`c${index}`))
    const links = Array.from({ length: 8 }, (_, index) => edge(`c${index}`, `c${index + 1}`, 1, 'common'))
    detectCommunities(crowd, links)
    expect(crowd.every((person) => person.community < 0)).toBe(true)
  })

  it('人多的分行各自成岛，落单的分行才并到上一级', () => {
    const split = [
      node('n1', { label: '工商银行_南宁分行_甲' }),
      node('n2', { label: '工商银行_南宁分行_乙' }),
      node('y1', { label: '工商银行_玉林分行_丙' }),
    ]
    detectCommunities(split, [])
    expect(split.find(n => n.id === 'n1')?.community).toBe(split.find(n => n.id === 'n2')?.community)
    expect(split.find(n => n.id === 'y1')?.community).toBe(-1)
    const merged = [
      node('n1', { label: '工商银行_南宁分行_甲' }),
      node('y1', { label: '工商银行_玉林分行_丙' }),
    ]
    detectCommunities(merged, [])
    expect(merged[0]?.community).toBe(merged[1]?.community)
    expect(merged[0]?.community).toBeGreaterThanOrEqual(0)
    const courts = [
      node('c1', { label: '法院_梧州万秀_甲' }),
      node('c2', { label: '法院_来宾市区_乙' }),
    ]
    detectCommunities(courts, [])
    expect(courts[0]?.community).toBe(-1)
    expect(courts[1]?.community).toBe(-1)
  })
})

describe('runLayout：没有分组的人不另成一座岛', () => {
  /** 一个「我 + 4 个互连好友」的核，外加 n 个无边节点。 */
  function graphWithLoners(n: number): BuiltGraph {
    const nodes = [node('self'), node('a'), node('b'), node('c'), node('d'), ...Array.from({ length: n }, (_, i) => node(`iso${i}`))]
    const edges = [
      edge('self', 'a', 5), edge('self', 'b', 4), edge('self', 'c', 3), edge('self', 'd', 2),
      edge('a', 'b', 3), edge('b', 'c', 2), edge('c', 'd', 1), edge('a', 'd', 1),
    ]
    return { nodes, edges, communityCount: 0, kindCounts: {} }
  }

  it('没有分组的人没有坐标，不会被画成一座岛', async () => {
    const g = graphWithLoners(6)
    const r = await runLayout({ graph: g, settings: s(), fresh: true })
    for (const id of ['self', 'a', 'b', 'c', 'd']) expect(r.positions.has(id)).toBe(true)
    for (let i = 0; i < 6; i++) expect(r.positions.has(`iso${i}`)).toBe(false)
  })

  it('只和我相连、跟别人没有来往的人也不进岛', async () => {
    const g = graphWithLoners(0)
    g.nodes.push(node('only-me'))
    g.edges.push(edge('self', 'only-me', 1))
    const r = await runLayout({ graph: g, settings: s(), fresh: true })
    expect(r.positions.has('only-me')).toBe(false)
    for (const id of ['self', 'a', 'b', 'c', 'd']) expect(r.positions.has(id)).toBe(true)
  })

  it('力度滑杆不会把没有分组的人再排出来', async () => {
    const g = graphWithLoners(9)
    for (const settings of [s({ forceRepulsion: 1 }), s({ forceRepulsion: 11 }), s({ forceCentripetal: 0.2, communitySeparation: 4 })]) {
      const r = await runLayout({ graph: g, settings, fresh: true })
      for (let i = 0; i < 9; i++) expect(r.positions.has(`iso${i}`)).toBe(false)
    }
  })

  it('没有无边节点时行为不变（不会凭空多出坐标或挪动已有节点）', async () => {
    const g = graphWithLoners(0)
    const r = await runLayout({ graph: g, settings: s(), fresh: true })
    expect(r.positions.size).toBe(g.nodes.length)
  })

  it('全是没有分组的人也不炸，不会凭空排出一座岛', async () => {
    const g: BuiltGraph = { nodes: [node('x'), node('y')], edges: [], communityCount: 0, kindCounts: {} }
    const r = await runLayout({ graph: g, settings: s(), fresh: true })
    expect(r.positions.size).toBe(0)
  })
})
