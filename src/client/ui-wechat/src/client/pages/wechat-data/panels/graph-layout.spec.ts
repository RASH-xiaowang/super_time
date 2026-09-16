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
import { DEFAULT_GRAPH_SETTINGS, type BuiltGraph, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'
import { fa2Settings, graphDataKey, layoutIterations, runLayout } from './graph-layout.ts'

/** 造一个节点：只写关心的字段，其余给中性默认。 */
function node(id: string, over: Partial<GNode> = {}): GNode {
  return {
    id, label: id, kind: 'person', weight: 100, radius: 10, community: -1,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    ...over,
  }
}

/** 造一条边。 */
function edge(source: string, target: string, weight = 1): GEdge {
  return { source, target, weight, dist: 100, kind: 'common' }
}

/** 造一张链状小图：id 形如 `${prefix}0 …`，边权交替，便于做「改一处 → 指纹必须变」的对照。 */
function chainGraph(count: number, prefix = 'n'): BuiltGraph {
  const nodes = Array.from({ length: count }, (_, i) => node(`${prefix}${i}`))
  const edges = Array.from({ length: Math.max(0, count - 1) }, (_, i) =>
    edge(`${prefix}${i}`, `${prefix}${i + 1}`, 1 + (i % 3)))
  return { nodes, edges, communityCount: 0 }
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
    const sweep = [0, 0.1, 0.25, 0.5, 1, 2, 4, 10, 100].map(factor => scalingRatio(withForce('forceRepulsion', base * factor)))
    for (let i = 1; i < sweep.length; i++) {
      expect(sweep[i] as number).toBeGreaterThanOrEqual(sweep[i - 1] as number)
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
    const result = await runLayout({ graph: { nodes: [], edges: [], communityCount: 0 }, settings: s() })
    expect(result.positions.size).toBe(0)
    expect(result.engine).toBe('main')
  })

  it('≥200 节点走 Worker 分支：node 环境没有 Worker 构造器，回退主线程而不是卡住', async () => {
    const graph = chainGraph(200, 'big')
    const result = await runLayout({ graph, settings: s() })
    expect(result.engine).toBe('main')
    expect(result.positions.size).toBe(200)
  })
})
