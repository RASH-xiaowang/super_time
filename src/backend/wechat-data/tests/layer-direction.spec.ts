/**
 * M24 守卫：`keys` ↔ `query` 的双向依赖必须一直保持「已消除」。
 *
 * 背景：原先 `keys/service.ts`、`keys/db-key-v4.ts` 反向 import `query/config.ts`，而
 * `query/image-key.ts` 又 import `keys/key-store.ts` —— 最底层能力与上层互相引用。修法是把
 * 共享的配置读写下沉到 `src/config/**`（并让 DB 密钥校验落在 `keys/db-key-verify.ts`），
 * 使依赖方向变成 `config ← keys ← query`。这条用例守的就是这个方向 **且** 扫描集合本身不空转
 * （空转的守卫在 M12/N19/N20/N23 上已经被抓过四次）。
 *
 * 判据取 AST 里的**模块说明符字符串字面量**再解析成源码路径，不扫原始文本：注释里提到
 * `query/config.ts` 是正常的（多个文件在解释这段历史），真正的依赖必然以字面量出现在
 * `import`/`export ... from`/`require`/动态 `import()` 里。
 *
 * 守得住什么、守不住什么（如实标注）：
 *   · 守得住：任何 `keys/**` → `query/**` 的静态依赖（含 `export ... from` 与动态 import 字面量）、
 *     `config/**` 反向依赖上层、跨层「向上」依赖、以及扫描集合失效；
 *   · **守不住**：运行期拼出来的路径（`import(name)`）、`createRequire` 间接加载、
 *     以及通过 tsconfig `paths` 别名绕开相对路径的写法（本包没有别名，故未处理）。
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** 后端插件源码根：扫描对象与判据都以它为基准。 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 分层：`config` 最底，`keys` 次之，`query` 最高；其余顶层文件是装配/宿主胶水。 */
type Layer = 'config' | 'keys' | 'query' | 'glue'

/**
 * 只允许这些「层 → 层」的依赖方向（同层内部依赖天然允许）。
 * `glue`（gateway/index/types/dirs…）是插件装配层，可以引用任何层，所以对它不设上界。
 */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  config: [],
  keys: ['config'],
  query: ['config', 'keys'],
  glue: ['config', 'keys', 'query', 'glue'],
}

/**
 * `keys/**` 允许引用的胶水层叶子模块。
 *
 * 为什么只放这几个：`dirs.ts`（数据根解析）与 `asar-path.ts`（打包路径）都不 import 包内任何
 * 模块，是真正的叶子；把它们列成白名单，比「keys 可以随便引用 glue」更能守住方向。
 */
const KEYS_GLUE_ALLOW = new Set(['dirs.ts', 'asar-path.ts'])

/**
 * `query/**` 允许引用的胶水层文件。
 *
 * `types.ts` 不当作叶子：它反过来 `export type ... from './query/contacts.ts'`，是**有意**的类型
 * 聚合再导出（query → types.ts → query 这条纯类型环 M24 之前就存在，也不在本次范围内）。这里
 * 如实放行，而不是假装它不存在 —— 守卫只承诺「不会退回 keys ↔ query 的双向依赖」。
 */
const QUERY_GLUE_ALLOW = new Set(['dirs.ts', 'asar-path.ts', 'types.ts'])

/** 一条解析出来的包内依赖边。 */
interface Edge {
  /** 源文件（相对 `src/`）。 */
  from: string
  /** 目标文件（相对 `src/`）。 */
  to: string
  fromLayer: Layer
  toLayer: Layer
}

/** 递归列出某目录下全部 `.ts`（只含实现源码，本包无 `.tsx`）。 */
function listTs(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTs(p, base))
    else if (entry.name.endsWith('.ts')) out.push(relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

/** 由源码相对路径判断所属层。 */
function layerOf(rel: string): Layer {
  const head = rel.split('/')[0]
  return head === 'config' || head === 'keys' || head === 'query' ? head : 'glue'
}

/**
 * 取一段源码里所有以 `.` 开头的模块说明符（相对导入）。
 * @param src - 源码全文。
 * @param filename - 文件名（只用于解析器选择与错误定位）。
 * @returns 相对模块说明符列表。
 */
function relativeModuleSpecifiers(src: string, filename: string): string[] {
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0]
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && first && ts.isStringLiteralLike(first)) out.push(first.text)
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out.filter((s) => s.startsWith('.'))
}

/**
 * 取一段源码里的**全部**字符串字面量（注释与标识符不算）。
 * @param src - 源码全文。
 * @param filename - 文件名。
 * @returns 字面量文本列表。
 */
function stringLiterals(src: string, filename: string): string[] {
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/** 缓存一份「源码 → 内容」的读取结果（同一次运行里多处判据都要用）。 */
const FILES = listTs(SRC).map((rel) => ({ rel, text: readFileSync(join(SRC, rel), 'utf8') }))

/** 解析出来的全部包内相对依赖边。 */
const EDGES: Edge[] = FILES.flatMap(({ rel, text }) => {
  const fromLayer = layerOf(rel)
  return relativeModuleSpecifiers(text, rel)
    .map((spec) => relative(SRC, resolve(SRC, dirname(rel), spec)).replace(/\\/g, '/'))
    .filter((to) => !to.startsWith('..'))
    .map((to) => ({ from: rel, to, fromLayer, toLayer: layerOf(to) }))
})

/** 格式化成可读的边列表（失败信息里要能直接看出是谁依赖谁）。 */
function show(edges: Edge[]): string[] {
  return edges.map((e) => `${e.from} -> ${e.to}`)
}

describe('M24 · 分层依赖方向', () => {
  it('扫描集合不空转：三层都真的被扫到了，且 keys 真的依赖了共享层', () => {
    const byLayer = (layer: Layer): string[] => FILES.filter((f) => layerOf(f.rel) === layer).map((f) => f.rel)
    // 数量下界只用来抓「目录搬走/扫描失效」这类假绿，不是精确断言。
    expect(byLayer('config').length).toBeGreaterThanOrEqual(4)
    expect(byLayer('keys').length).toBeGreaterThanOrEqual(10)
    expect(byLayer('query').length).toBeGreaterThanOrEqual(80)
    // 非空转的关键一条：如果 keys 一条 config 依赖都没有，下面的规则就成了「恒真」。
    expect(show(EDGES.filter((e) => e.fromLayer === 'keys' && e.toLayer === 'config')).length)
      .toBeGreaterThanOrEqual(1)
  })

  it('keys/** 不再依赖 query/**（M24 的核心）', () => {
    const bad = EDGES.filter((e) => e.fromLayer === 'keys' && e.toLayer === 'query')
    expect(show(bad), 'keys 是最底层能力，不能反向 import query').toEqual([])
  })

  it('keys/** 里没有任何指向 query 的模块说明符字面量（含动态 import）', () => {
    // 边判据已覆盖静态 import；这里补一层「字面量级」判据，防的是 import(name) 之类
    // 绕过 AST 边解析、但字面量里写着 query 的写法（也防注释以外的路径复述）。
    const offenders: string[] = []
    for (const { rel, text } of FILES) {
      if (layerOf(rel) !== 'keys') continue
      for (const spec of relativeModuleSpecifiers(text, rel)) {
        if (/(^|\/)query(\/|$)/.test(spec.replace(/\\/g, '/'))) offenders.push(`${rel}: ${spec}`)
      }
      for (const lit of stringLiterals(text, rel)) {
        if (lit.includes('query/config.ts')) offenders.push(`${rel}: "${lit}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('config/** 是真正的底层：不依赖 keys/query/胶水层', () => {
    const bad = EDGES.filter((e) => e.fromLayer === 'config' && (e.toLayer === 'keys' || e.toLayer === 'query' || e.toLayer === 'glue'))
    expect(show(bad), '共享配置层被上层反向依赖后，双向依赖会立刻回来').toEqual([])
  })

  it('全图只允许向下：跨层边要么是 ALLOWED，要么落在胶水层白名单里', () => {
    const bad = EDGES.filter((e) => {
      if (e.toLayer === e.fromLayer) return false
      if (ALLOWED[e.fromLayer].includes(e.toLayer)) return false
      // → 胶水层：只放行白名单内的具体文件（keys/query 各有自己的白名单）。
      if (e.fromLayer === 'keys' && e.toLayer === 'glue') return !KEYS_GLUE_ALLOW.has(e.to)
      if (e.fromLayer === 'query' && e.toLayer === 'glue') return !QUERY_GLUE_ALLOW.has(e.to)
      return true
    })
    expect(show(bad)).toEqual([])
  })

  it('密钥真源确实落在 config/**：secrets.json 的实现不再留在 query/config.ts', () => {
    // 抽层要「真抽」而不是加一层转发：如果 SECRET_FIELDS/secrets.json 的实现又回到
    // query/config.ts，说明共享层只是被绕过，M24 会在下一次改动里复发。
    const secretsOwners = FILES
      .filter(({ text, rel }) => stringLiterals(text, rel).includes('secrets.json'))
      .map(({ rel }) => rel)
    expect(secretsOwners.some((rel) => rel.startsWith('config/')), 'secrets.json 的实现必须在 config/**').toBe(true)
    expect(secretsOwners.filter((rel) => rel.startsWith('query/'))).toEqual([])

    const facade = FILES.find((f) => f.rel === 'query/config.ts')
    expect(facade, 'query/config.ts 必须保留（gateway 与既有 spec 都从它取配置能力）').toBeDefined()
    const facadeLiterals = stringLiterals(facade?.text ?? '', 'query/config.ts')
    expect(facadeLiterals.filter((lit) => lit.includes('secrets.json'))).toEqual([])
    expect(facadeLiterals.filter((lit) => lit.includes('SECRET_FIELDS'))).toEqual([])
  })
})
