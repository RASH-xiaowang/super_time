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
const model = readFileSync(join(HERE, 'graph-model.ts'), 'utf8')
const canvas = readdirSync(HERE).filter((f) => /^graph-canvas(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
const budget = readFileSync(join(HERE, 'graph-budget.ts'), 'utf8')

describe('首字连边：图例 / 开关 / 依赖三处都在', () => {
  it('图例里给这类线一个名字（蓝虚线 = 首字相同），且与「亲密度」措辞区分开', () => {
    expect(panel).toContain('css.legendLineBlueDash')
    expect(panel).toContain('蓝虚线 = 首字相同')
    // 亲密度那行必须写明「实线」，否则两条蓝线在图例上无法区分
    expect(panel).toContain('蓝实线 = 与我亲密度')
    expect(css, '.legendLineBlueDash 没定义').toMatch(/\.legendLineBlueDash\s*\{/)
    // 图例本身也画成虚线，否则「实线图例 + 虚线画布」对不上
    expect(css).toMatch(/\.legendLineBlueDash\s*\{[^}]*repeating-linear-gradient/)
  })

  it('设置里有独立开关，且它是「结构参数」要进 useMemo 依赖', () => {
    expect(panel).toContain('首字相同连边')
    expect(panel).toMatch(/patch\(\{\s*firstChar:\s*v\s*\}\)/)
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
    expect(model).toMatch(/kind:\s*'intimacy' \| 'common' \| 'wiki' \| 'source' \| 'class' \| 'initial'/)
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

  it('去重：class 与 initial 共用同一个点对集合（否则同两点两条边）', () => {
    // 只有一个 paired 集合，addInferred 是唯一的写入口（class / initial 都走它）
    expect((model.match(/const paired = new Set\(edgeW\.keys\(\)\)/g) ?? []).length).toBe(1)
    expect(model).toMatch(/const addInferred = \(a: string, b: string, kind: 'class' \| 'initial'\)/)
  })

  it('★ 计算余量时必须按「已产出的观测层」计，不能按原始条数（否则大图余量被算成 0）', () => {
    // 观测层先被 min(OBSERVED_EDGE_CAP, edgeDensityCap(n)) 夹过，余量基于**夹过的**条数。
    // 用原始条数（`edges.length`）去算，在全量视图上会得到 0 余量 —— 首字层实测 +0 条。
    expect(model).toMatch(/edgeHeadroom\(nodes\.length, observed\.length \+ inferred\.length\)/)
    expect(model).toMatch(/const observed = \[\.\.\.intimacy, \.\.\.edges\]/)
    expect(model).toMatch(/\.slice\(0, Math\.min\(OBSERVED_EDGE_CAP, edgeDensityCap\(nodes\.length\)\)\)/)
    // 老写法（把 intimacy/edges/inferred 一起夹在硬编码 6000）必须不再出现
    expect(model).not.toMatch(/slice\(0, Math\.max\(0, 6000 - intimacy\.length\)\)/)
    expect(model).not.toMatch(/derived/)
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

  it('★ 观测层与推断层分开夹（合在一起夹就会把推断层整批切掉）', () => {
    // 推断层接在观测层之后拼接，不再进同一批 sort 后整体截断
    expect(model).toMatch(/edges: \[\.\.\.observed, \.\.\.inferred\]/)
    // class 层也必须按余量截断（否则它会独自吃掉额度、把首字层挤成 0）
    expect(model).toMatch(/let left = edgeHeadroom\(nodes\.length, observed\.length \+ inferred\.length\)/)
  })
})
