// @vitest-environment node
/**
 * 图谱统计条的计数守卫（审计 P3-14）。
 *
 * 报告点的是"同一次 render 里 6 次 `filter().length`"，实到 7 次：统计条每格各扫一遍
 * `graph.nodes`，而渲染由悬停/选中/面板开合这些与计数无关的动作触发 ⇒ 动一下鼠标就分配
 * 七份临时数组。收成 `countByKind` 一次遍历 + `useMemo` 之后，这条判据要钉两件事：
 * ① 数出来的结果与"按种类各数一遍"完全一致（合并不能改变口径）；
 * ② 那七次 `filter` 不许长回去（长回去不会有编译错误，只会在节点多的时候把渲染拖慢）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGraph, countByKind, DEFAULT_GRAPH_SETTINGS, localGraph, type GNode } from './graph-model.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const kind = (k: GNode['kind']): Pick<GNode, 'kind'> => ({ kind: k })

describe('countByKind', () => {
  it('空图什么都不是 0，而是"这个种类根本没出现"（缺键与 0 的差别由调用点按 0 处理）', () => {
    expect(countByKind([])).toEqual({})
    expect(countByKind([kind('note')]).note).toBe(1)
    expect(countByKind([kind('note')]).stub).toBeUndefined()
  })

  it('每种各数自己的，一个都不落到键外', () => {
    const nodes: Array<Pick<GNode, 'kind'>> = [
      kind('person'), kind('person'), kind('group'), kind('self'),
      kind('note'), kind('stub'), kind('stub'), kind('file'), kind('section'), kind('entity'),
    ]
    const counts = countByKind(nodes)
    expect(counts).toEqual({ person: 2, group: 1, self: 1, note: 1, stub: 2, file: 1, section: 1, entity: 1 })
    const sum = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
    expect(sum, '合并成一次遍历之后仍然要等于逐个数的和').toBe(nodes.length)
  })

  it('与"按种类 filter 一遍"逐类相等（口径没被改写）', () => {
    const nodes: Array<Pick<GNode, 'kind'>> = [kind('note'), kind('note'), kind('file'), kind('entity'), kind('entity'), kind('entity')]
    const counts = countByKind(nodes)
    for (const k of ['note', 'file', 'entity', 'stub'] as const) {
      expect(counts[k] ?? 0, `${k} 这一类数错了`).toBe(nodes.filter((n) => n.kind === k).length)
    }
  })
})

describe('统计条不再每渲染一次扫七遍（P3-14 防回归）', () => {
  const src = readFileSync(join(HERE, 'Graph.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const model = readFileSync(join(HERE, 'graph-model.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('`graph.nodes.filter(n => n.kind === …).length` 一处不剩', () => {
    // 只钉统计条那一族（`graph.nodes` + `===`）：另一处 `env.nodes.filter(… !== …).length` 是
    // 数据到手时封顶一次 `nodeLimit` 的，不在每次渲染上，不该被这条误伤。
    const back = src.match(/graph\.nodes\.filter\(n => n\.kind ===[^\n]*\.length/g) ?? []
    expect(back, `统计条又回到每渲染一遍扫 N 遍：\n  ${back.join('\n  ')}`).toEqual([])
  })

  it('组件不再自己数，只读图上的 `graph.kindCounts`（数的动作只能有一处）', () => {
    expect(src, 'Graph.tsx 又开始自己调 countByKind ⇒ 会有两份计数').not.toContain('countByKind(')
    expect((src.match(/graph\.kindCounts\./g) ?? []).length, '统计条那七格都不读图上的计数了？').toBeGreaterThanOrEqual(7)
  })

  it('每一个 BuiltGraph 构造处都带上 kindCounts（漏一个就是那一档统计全变 0）', () => {
    const builds = model.split('\n').filter((l) => /^\s*return \{.*communityCount/.test(l))
    expect(builds.length, '一个 BuiltGraph 构造处都没扫到 ⇒ 判据恒真').toBeGreaterThanOrEqual(3)
    const missing = builds.filter((l) => !l.includes('kindCounts'))
    expect(missing, `这些构造处忘了带计数：\n  ${missing.join('\n  ')}`).toEqual([])
  })
})

/**
 * 文本判据只能证明"写了 `kindCounts`"，证明不了"带的是自己那份"。
 * 这几条走真实构造：计数必须与结果里的节点数组自洽（把某个构造处改成 `kindCounts: {}` 会当场红）。
 */
describe('真实构造处的计数自洽', () => {
  type EnvNode = { id: string, label: string, kind: string, is_friend?: boolean, msg_count?: number, group_count?: number, group_codes?: string[] }
  const S = { ...DEFAULT_GRAPH_SETTINGS }
  const person = (id: string): EnvNode => ({ id, label: id, kind: 'contact', is_friend: true, msg_count: 0, group_count: 0, group_codes: [] })
  const group = (id: string): EnvNode => ({ id, label: id, kind: 'group', is_friend: false, msg_count: 0, group_count: 0, group_codes: [] })
  const env = (nodes: EnvNode[]): { nodes: EnvNode[], edges: [] } => ({ nodes, edges: [] })

  it('buildGraph：计数就是结果节点数出来的，且各类之和等于节点总数', () => {
    const g = buildGraph(env([person('p1'), person('p2'), group('g1@chatroom')]) as never, S)
    expect(g.kindCounts).toEqual(countByKind(g.nodes))
    const sum = Object.values(g.kindCounts).reduce((a, b) => a + (b ?? 0), 0)
    expect(sum).toBe(g.nodes.length)
    expect(g.kindCounts.person ?? 0, '两个联系人 ⇒ 至少该数出两个人（外加补进来的「我」）').toBeGreaterThanOrEqual(2)
  })

  it('localGraph：深度过滤后的计数跟着过滤结果走', () => {
    const g = buildGraph(env([person('p1'), person('p2'), group('g1@chatroom')]) as never, S)
    const anchor = g.nodes[0]?.id ?? 'self'
    const cut = localGraph(g, anchor, 1)
    expect(cut.kindCounts).toEqual(countByKind(cut.nodes))
  })

  it('没有数据时的构造处给的是空计数（不是 undefined，组件那边才敢直接读）', () => {
    expect(buildGraph(null as never, S).kindCounts).toEqual({})
  })
})
