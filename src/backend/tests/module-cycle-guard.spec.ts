/**
 * 模块环守卫（CODE-AUDIT-2026-09-26 P2-3，§七 第三批 #21）。
 *
 * ## 守的是什么
 *
 * **真会建边的循环 import**。环本身不一定立刻出事（本仓那 5 个环都在跑），但它是
 * 「改一处炸三处」的根：初始化顺序变成隐式依赖、tree-shaking 失效、任何一头的
 * 顶层副作用都会被另一头读到半初始化状态。所以这里把「值 import 环 = 0」钉成硬闸门。
 *
 * ## 为什么判据必须走 AST 而不是正则
 *
 * 报告里专门警告过：本仓注释里大量出现 `from './xxx.ts'` 这类字样
 * （`export-io.ts:5`、`api-core.ts:153`，还有本文件上面这段），
 * 任何按文本匹配的静态分析都会把它们读成真 import ⇒ **误报出一堆假环**。
 * 误报比漏报更坏：清单里混进不存在的环之后，「只能变小」就再也验不了真事。
 * 所以这里用 `ts.createSourceFile` 只取 `ImportDeclaration` / `export * from` 的
 * **模块说明符字面量**，注释里的字样在语法树里根本不是节点。
 *
 * ## 清单已经清空 ⇒ 本守卫是零容忍闸门
 *
 * 2026-09-26 逐个解开测出的 5 个环（`export-format` 的死 import、`api-core` 的 type-only、
 * `graph-canvas-theme` 的死 `bubbleText` + type-only、`chats-*` 卡片（拆出 `chats-card-foot.tsx`）、
 * `search-build/query/scaffold`（拆出 `search-display.ts`））之后，`KNOWN_RINGS` 已删。
 * **别再把它加回来**：新环一律当场解开，不留台账。
 *
 * ## 两个刻意留下的口径
 *
 *  · **`import type` 不建边**：它会被编译擦掉，不构成运行期依赖。这条不是宽松，是准确 ——
 *    `chats-thread.tsx` 与 `Chats.tsx` 互相提到的正是类型，所以那一对**不该**进清单；
 *    下面专门有一条用例钉住「不过宽」（把 type-only 也当边的那版实现会多报一个环，
 *    变异 M119 就是照这个改的）。
 *  · **只扫两个产物树**（后端 `src/`、渲染层 `ui-wechat/src/`）。`lib/`（生成物）与
 *    `deps/`（vendor 上游）里的环不归我们负责，也修不动。
 * @vitest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TREES = [
  join(ROOT, 'src', 'backend', 'wechat-data', 'src'),
  join(ROOT, 'src', 'client', 'ui-wechat', 'src'),
]

/** 参与建图的扩展名（`.d.ts` 是声明文件，不参与运行期依赖）。 */
const SOURCE_RE = /\.(ts|tsx)$/

const isSource = (name: string): boolean => SOURCE_RE.test(name) && !name.includes('.spec.') && !name.endsWith('.d.ts')

/** 递归列出要分析的源文件（绝对路径）。 */
function listSources(dir: string): string[] {
  const out: string[] = []
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (isSource(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * 取一个文件里**真的会建立模块依赖**的相对 import：
 * 静态 `import x from './y'`、`export * from './y'`，但**排除** `import type`。
 * @param file - 绝对路径。
 * @returns 相对仓库根、正斜杠的目标路径列表。
 */
function valueImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const specs: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier
      const clause = node.importClause
      // `import type { X } from` 与 `import type X from` 都算类型边（会被擦掉）；
      // `import { type A, b } from` 里只要有非类型成员就仍然建边。
      const typeOnly = clause === undefined ? false : clause.isTypeOnly === true
      const namedTypeOnlyOnly = clause?.namedBindings !== undefined
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((el) => el.isTypeOnly)
        && !clause.name
      if (!typeOnly && !namedTypeOnlyOnly && ts.isStringLiteral(spec)) specs.push(spec.text)
    }
    // 无名的 `export * from './x'` 与 `export * as ns from './x'` 会在运行时求值目标模块
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause
      if (clause === undefined || ts.isNamespaceExport(clause)) specs.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  const dir = dirname(file)
  const out: string[] = []
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue
    const base = resolve(dir, spec)
    // 本仓 import 一律带扩展名，但索引式（'./x' → './x/index.ts'）也要能落地
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (statSync(cand, { throwIfNoEntry: false })?.isFile()) {
        out.push(relative(ROOT, cand).replace(/\\/g, '/'))
        break
      }
    }
  }
  return out
}

/** 整张图：文件 → 依赖列表。 */
function buildGraph(): Map<string, string[]> {
  const g = new Map<string, string[]>()
  const files = TREES.flatMap(listSources)
  for (const f of files) g.set(relative(ROOT, f).replace(/\\/g, '/'), [])
  for (const f of files) {
    const key = relative(ROOT, f).replace(/\\/g, '/')
    g.set(key, [...new Set(valueImports(f).filter((d) => g.has(d)))])
  }
  return g
}

/**
 * Tarjan 强连通分量（迭代版，避免几百层递归爆栈）。
 * @param g - 依赖图。
 * @returns 成员数 > 1 的分量（即「环」），每个分量内成员按字典序排好。
 */
function cyclesIn(g: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0
  for (const start of g.keys()) {
    if (index.has(start)) continue
    const work: Array<[string, number]> = [[start, 0]]
    index.set(start, counter); low.set(start, counter); counter += 1
    stack.push(start); onStack.add(start)
    while (work.length > 0) {
      const frame = work[work.length - 1] as [string, number]
      const deps = g.get(frame[0]) ?? []
      if (frame[1] < deps.length) {
        const w = deps[frame[1]] as string
        frame[1] += 1
        if (!g.has(w)) continue
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter += 1
          stack.push(w); onStack.add(w)
          work.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(frame[0], Math.min(low.get(frame[0]) ?? 0, index.get(w) ?? 0))
        }
        continue
      }
      work.pop()
      const v = frame[0]
      if (low.get(v) === index.get(v)) {
        const comp: string[] = []
        let w: string | undefined
        do {
          w = stack.pop()
          if (w !== undefined) onStack.delete(w)
          if (w !== undefined) comp.push(w)
        } while (w !== undefined && w !== v)
        if (comp.length > 1) out.push(comp.sort())
      }
      const parent = work[work.length - 1]
      if (parent) low.set(parent[0], Math.min(low.get(parent[0]) ?? 0, low.get(v) ?? 0))
    }
  }
  return out.sort((a, b) => a.join('|').localeCompare(b.join('|')))
}

/** 当前一个环都没有 ⇒ 本守卫零容忍；`pretty` 只是把环印成人话。 */
const pretty = (ring: string[]): string => ring.join('\n    ⇢ ')

describe('值 import 环（P2-3 / 第三批 #21）', () => {
  const graph = buildGraph()
  const rings = cyclesIn(graph)
  const edgeCount = [...graph.values()].reduce((a, v) => a + v.length, 0)

  it('图不是空的（否则下面所有判据都是恒真）', () => {
    console.log(`[算料|cycles] 节点 ${String(graph.size)}，值 import 边 ${String(edgeCount)}，环 ${String(rings.length)} 个`)
    expect(graph.size, '一个源文件都没读到 ⇒ 扫描根路径错了').toBeGreaterThan(300)
    expect(edgeCount, '一条边都没有 ⇒ 边提取坏了（连 export 都读不到）').toBeGreaterThan(600)
  })

  it('零容忍：值 import 环必须为 0（新环当场解开，不留台账）', () => {
    expect(rings.map((r) => pretty(r)), `发现 ${String(rings.length)} 个值 import 环`).toEqual([])
  })

  it('反例自证：临时造一个三方环，判据必须报出来', () => {
    const g = new Map(graph)
    const a = 'src/backend/wechat-data/src/query/db-open.ts'
    const b = 'src/backend/wechat-data/src/query/ghost-probe.ts'
    const c = 'src/backend/wechat-data/src/md5.ts'
    expect(g.has(a) && g.has(c), '夹具用的真实文件必须都在图里').toBe(true)
    g.set(b, [a])
    g.set(a, [...(g.get(a) ?? []), c])
    g.set(c, [b])
    const found = cyclesIn(g).some((r) => r.includes(a) && r.includes(b) && r.includes(c))
    expect(found, 'SCC 算不出来 ⇒ 上面那条「对齐」是恒真').toBe(true)
    // 没塞进去之前，这个三方环不该已经存在（否则「反例自证」证明不了什么）
    expect(cyclesIn(graph).some((r) => r.includes(b)), '探针用的假文件不该出现在真图里').toBe(false)
  })

  it('口径不过宽：类型互引的两端面不算环（chats-thread ↔ Chats）', () => {
    const thread = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-thread.tsx'
    const chats = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx'
    const inRing = rings.some((r) => r.includes(thread) && r.includes(chats))
    expect(inRing, '这一对互相提到的只是类型；把 import type 当边就会多报一个环（口径过宽 ⇒ 清单失去意义）')
      .toBe(false)
    expect(graph.has(thread) && graph.has(chats), '两个文件都不在图里 ⇒ 上面那条是空转').toBe(true)
  })
})
