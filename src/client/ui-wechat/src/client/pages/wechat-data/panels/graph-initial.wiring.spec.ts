/**
 * 「首字相同连边」的**接线**守卫（源码级）。
 *
 * 为什么必须看源码：本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），
 * 图例、开关渲染不起来。而这四处的退化**界面照样能用**，只是少一层信息：
 *   ① 图例少了蓝虚线 —— 用户看到一批蓝线却不知道是什么，还会把它读成「亲密度」（同为蓝色系）；
 *   ② 设置里漏了 `firstChar` 开关 —— 这层推断关系再也关不掉；
 *   ③ `useMemo` 依赖漏掉 `settings.firstChar` —— 开关点了没反应（静默失效）；
 *   ④ 主题里少定义一套 `edgeInitial` —— 浅色/深色其中一边的线退化成 `undefined`（画不出线），
 *      构建与既有用例都不报错。
 *
 * 另外钉几条**语义**约束：
 *   - 蓝虚线必须与「与我亲密度」的蓝**实线**在图例措辞上区分开（否则两种蓝线混淆）；
 *   - 建模层与绘制层必须用**同一个** `edgeBudget`（首字层靠 `edgeHeadroom` 定量），
 *     各写一份就会退化成「模型里有边、图上没画」——审计里量化过这个缺陷；
 *   - **观测层与推断层必须分开夹额度**：老代码把两类合在一起 `slice(0, 6000 - intimacy)`，
 *     真机全量视图（2606 节点 / 原始共同群点对 34953 条）实测首字层因此 **+0 条** ——
 *     观测层独占满 6000，共用那道切片把推断层整批切掉；而那一帧绘制层本来能画 13030 条。
 *     分开之后还有一条可断言的不变量：模型边总数 ≤ `edgeDensityCap(n)` ≤ 绘制层额度。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)

const panel = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')
const css = readFileSync(join(HERE, 'graph.module.css'), 'utf8')
const model = ['graph-model.ts', 'graph-settings.ts']
  .map((file) => readFileSync(join(HERE, file), 'utf8'))
  .join('\n')
const canvas = readdirSync(HERE).filter((f) => /^graph-canvas(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
const budget = readFileSync(join(HERE, 'graph-budget.ts'), 'utf8')

describe('首字连边：图例 / 开关 / 依赖三处都在', () => {
  it('社交图谱不再把线型说明铺在画面上', () => {
    expect(panel).not.toContain('蓝虚线 = 首字相同')
    expect(panel).not.toContain('蓝实线 = 与我亲密度')
  })

  it('设置里有独立开关，且它是「结构参数」要进 useMemo 依赖', () => {
    // 开关本体 2026-10-16 随参数面板搬进 `GraphRail.tsx`；`useMemo` 依赖仍在 `Graph.tsx`。
    const rail = readFileSync(join(HERE, 'GraphRail.tsx'), 'utf8')
    expect(rail).toContain('首字相同连边')
    expect(rail).toMatch(/patch\(\{\s*firstChar:\s*v\s*\}\)/)
    expect(model).toMatch(/firstChar:\s*true/)
    const deps = panel.match(/const graph = useMemo<BuiltGraph>\([\s\S]*?\n {4}\[[^\]]*\]/)
    expect(deps, '找不到 graph 的 useMemo').not.toBeNull()
    expect(deps?.[0], 'firstChar 漏进依赖 → 开关点了不重建图').toContain('settings.firstChar')
  })
})

describe('首字连边：画布与建模接线', () => {
  it('主题两套（深/浅）都定义了 edgeInitial，且 initial 边走虚线', () => {
    expect((canvas.match(/edgeInitial:/g) ?? []).length, '接口 1 处 + 深浅各 1 处').toBeGreaterThanOrEqual(3)
    expect(canvas).toMatch(/theme\.edgeInitial/)
    expect(canvas).toMatch(/const isInferred = isClass \|\| isInitial/)
    expect(canvas).toMatch(/dashed:\s*\(isWiki && stubIds\.has\(edge\.target\)\) \|\| isInferred/)
  })

  it('边类型联合里含 initial，并说明它的语义', () => {
    expect(model).toMatch(/export type GEdgeKind\s*=[\s\S]*?\| 'initial'/)
    expect(model).toContain('initial=首字相同')
  })

  it('后端扩展的互动类型有独立绿实线语义，图例与画布主题同源', () => {
    expect(model).toMatch(/group_owner:\s*'common'/)
    expect(model).toMatch(/invite:\s*'social'/)
    expect(model).toMatch(/reply:\s*'social'/)
    expect(model).toMatch(/mention_user:\s*'social'/)
    expect(model).toContain("social: '社交互动'")
    expect(canvas).toMatch(/theme\.edgeSocial/)
    expect((canvas.match(/edgeSocial:/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('★ 建模层与绘制层共用同一个 edgeBudget（各写一份就会「有边没画」）', () => {
    // 常量只在 graph-budget 里定义一次
    expect((budget.match(/const EDGES_PER_NODE = 5/g) ?? []).length).toBe(1)
    expect((budget.match(/const MIN_EDGE_BUDGET = 300/g) ?? []).length).toBe(1)
    expect((budget.match(/const MAX_EDGE_BUDGET = 24000/g) ?? []).length).toBe(1)
    // 画布侧不再自己定义，而是从共享模块取
    expect(canvas).toMatch(/from '\.\/graph-budget\.ts'/)
    expect(canvas).not.toMatch(/^const EDGES_PER_NODE = /m)
    // 建模侧用 edgeHeadroom 定量，而不是硬编码整数
    expect(model).toMatch(/edgeHeadroom\(/)
    expect(model).toMatch(/from '\.\/graph-budget\.ts'/)
  })

  it('首字层只在 people 模式生效，并且受开关控制', () => {
    expect(model).toMatch(/s\.mode === 'people' && s\.firstChar/)
  })

  it('去重：class 与 initial 共用同一个视觉点对桶，但各自关系明细不丢', () => {
    // 一个节点对只产生一条 GEdge；多种关系聚合进 relations。
    expect((model.match(/const pairBuckets = new Map<string, PairBucket>\(\)/g) ?? []).length).toBe(1)
    expect(model).toMatch(/relations: Map<string, RelationRecord>/)
    expect(model).toMatch(/const addInferred = \(a: string, b: string, kind: 'class' \| 'initial'\)/)
  })

  it('★ 计算余量时必须按「已产出的视觉边」计，不能按原始候选条数', () => {
    // 推导观测层受 observedCap 限制，推断层只拿 pairBuckets.size 之后剩下的额度。
    expect(model).toMatch(/const observedCap = Math\.min\(OBSERVED_EDGE_CAP, edgeDensityCap\(nodes\.length\)\)/)
    expect(model).toMatch(/pairBuckets\.size >= observedCap/)
    expect(model).toMatch(/edgeHeadroom\(nodes\.length, pairBuckets\.size\)/)
    // 后端观测边直接 addRelation，不经过 observedCap，因此不会被推导层上限误删。
    expect(model).toMatch(/for \(const raw of env\.edges \?\? \[\]\)/)
    expect(model).toMatch(/origin: 'backend'/)
    // 老写法（把 intimacy/edges/inferred 一起夹在硬编码 6000）必须不再出现
    expect(model).not.toMatch(/slice\(0, Math\.max\(0, 6000 - intimacy\.length\)\)/)
  })

  it('★ 观测层上限与密度上限由 graph-budget 单点定义（建模层只 import，不自带整数）', () => {
    expect((budget.match(/const OBSERVED_EDGE_CAP = 6000/g) ?? []).length).toBe(1)
    expect((budget.match(/export function edgeDensityCap\(/g) ?? []).length).toBe(1)
    // edgeHeadroom 必须复用 edgeDensityCap，否则「能画多少」又会有第二个答案
    expect(budget).toMatch(/return Math\.max\(0, edgeDensityCap\(nodeCount\) - nonNegative\(usedEdges\)\)/)
    expect(model).toMatch(
      /import \{ edgeDensityCap, edgeHeadroom, OBSERVED_EDGE_CAP \} from '\.\/graph-budget\.ts'/,
    )
  })

  it('★ 后端观测边完整保留；推断关系只合并进点对或使用剩余视觉额度', () => {
    // 最终边来自聚合桶，不存在 observed/inferred 两数组拼接后被整体 slice 的路径。
    expect(model).toMatch(/const edges: GEdge\[\] = \[\.\.\.pairBuckets\.values\(\)\]\.map/)
    expect(model).not.toMatch(/edges: \[\.\.\.observed, \.\.\.inferred\]/)
    // class 层与首字层都以当前视觉边数问余量。
    expect(model).toMatch(/let left = edgeHeadroom\(nodes\.length, pairBuckets\.size\)/)
    expect(model).toMatch(/const headroom = edgeHeadroom\(nodes\.length, pairBuckets\.size\)/)
    expect(model).toMatch(/if \(!pairBuckets\.has\(key\) && pairBuckets\.size >= edgeDensityCap\(nodes\.length\)\) return 'ignored'/)
  })
})
