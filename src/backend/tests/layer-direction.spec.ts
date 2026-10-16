/**
 * 层间方向守卫：宿主/后端那一侧不许 import 前端源码（P3-17，CODE-AUDIT-2026-09-26）。
 *
 * ## 起因
 *
 * `src/backend/tests/debug-gates.spec.ts` 原先写着
 * `import { shouldSkipGates } from '../../client/ui-app/debug-gates.ts'`
 * —— 看着无害（只是份测试），但它是**反向依赖**：后端那一侧的图里从此有一条指向 `src/client` 的边。
 * 三条实际代价：
 *   ① 那条判定函数的归属变得含糊 —— 它守的是渲染层"事实形状不对就不许放行"，理应与 `ui-entry.tsx` 同层；
 *   ② 谁挪前端目录，后端 spec 就红 —— 而红的位置离真正的原因隔了一层；
 *   ③ 更要紧的是**它会被模仿**：下一个要断言前端纯逻辑的人先看到的是"从后端 import 过去"。
 * 判据已经把那份行为用例搬去 `src/client/ui-app/debug-gates.spec.ts`；本文件保证这条路不再长回来。
 *
 * ## 守的是"值耦合"，不是"读源码文本"
 *
 * 后端 spec 里 `readFileSync('src/client/…')` 做源码级断言是**常规手段**（棘轮、接线守卫都这么读，
 * 几十处）。那不是依赖：改前端目录不会让后端构建失败，只会让守卫的用例名变红 —— 那正是守卫该有的样子。
 * 所以这张判据只看会进入模块图的四种形状：静态 `import … from`、`export { x } from`、
 * `await import(…)`、`require(…)`。
 *
 * ## 基线是 0，不留白名单
 *
 * 搬掉那一条之后全仓再无此类边（446 份宿主/后端文件实测 0 条），所以这里写成"零容忍"。
 * 将来若真有正当需要，得先改这条判据并说明理由 —— 这正是判据的目的。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

/** 要扫的层：后端包 + 宿主层（`src/backend/**`、根上的 `main.js` / `preload.js`）。 */
const SCAN_DIRS = [join(ROOT, 'src', 'backend')]
const SCAN_FILES = [join(ROOT, 'main.js'), join(ROOT, 'preload.js')]
const SKIP_DIRS = new Set(['lib', 'deps', 'node_modules', 'dist'])

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collect(p, out)
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const SOURCES: string[] = []
for (const d of SCAN_DIRS) if (existsSync(d)) collect(d, SOURCES)
for (const f of SCAN_FILES) if (statSync(f).isFile()) SOURCES.push(f)

const rel = (p: string): string => relative(ROOT, p).split(sep).join('/')

/** 一个源文件里所有会进入模块图的来源串（静态 import / 具名再导出 / 动态 import / require）。 */
function moduleSources(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        out.push(node.arguments[0].text)
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        out.push(node.arguments[0].text)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

/** 指进 `src/client` 的那些来源（相对路径解析之后再判，别名如 `@deepseek-ai/…` 不在此列）。 */
function clientEdges(file: string, specifiers: string[]): string[] {
  return specifiers.filter((spec) => {
    if (!spec.startsWith('.')) return false
    const target = resolve(dirname(file), spec)
    return rel(target).startsWith('src/client')
  })
}

describe('层间方向：后端/宿主不许 import 前端源码', () => {
  it('扫描射程够大（扫空 ⇒ 下面那条「零命中」是恒真）', () => {
    expect(SOURCES.length, `只扫到 ${String(SOURCES.length)} 份宿主/后端文件`).toBeGreaterThan(200)
    // 自证判据认得出"什么算指进前端"：合成一段 import 前端源码的源码，必须被 moduleSources + clientEdges 抓住。
    // 假文件放在 `src/backend/tests/` 这一层（与真的那份 spec 同深度），相对路径才按同一套规则解析。
    const fakeDir = join(ROOT, 'src', 'backend', 'tests')
    const fake = ts.createSourceFile(join(fakeDir, 'fake.ts'),
      "import { x } from '../../client/ui-app/foo.ts'\n"
      + "export { y } from '../../client/pages/a/b'\n"
      + "const m = await import('../../client/ui-wechat/src/client/kit')\n"
      + "const r = require('../../client/ui-app/bar')\n",
      ts.ScriptTarget.Latest, true)
    expect(clientEdges(join(fakeDir, 'fake.ts'), moduleSources(fake))).toHaveLength(4)
    // 反面：合法方向与同层引用不许误伤（后端内部、宿主层内部、以及**读前端源码文本**都不算边）
    const ok = ts.createSourceFile(join(fakeDir, 'fake2.ts'),
      "import { join } from 'node:path'\nimport { q } from './query/x.ts'\nconst t = '../../client/ui-app/ui-entry.tsx'\n",
      ts.ScriptTarget.Latest, true)
    expect(clientEdges(join(fakeDir, 'fake2.ts'), moduleSources(ok))).toEqual([])
  })

  it('全仓宿主/后端那一侧，指进 src/client 的模块依赖是 0 条', () => {
    const bad: string[] = []
    for (const f of SOURCES) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : f.endsWith('.js') || f.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      for (const spec of clientEdges(f, moduleSources(sf))) bad.push(`${rel(f)}  ->  ${spec}`)
    }
    expect(bad, `出现了反向依赖（后端 import 前端源码）：\n${bad.join('\n')}\n行为的判据该写在前端那一层的 spec 里（见 src/client/ui-app/debug-gates.spec.ts）`).toEqual([])
  })

  it('搬走的那份判据确实落在前端那一层（不是被删掉了）', () => {
    const p = join(ROOT, 'src', 'client', 'ui-app', 'debug-gates.spec.ts')
    expect(existsSync(p), 'src/client/ui-app/debug-gates.spec.ts 不在了 —— shouldSkipGates 的行为判据去哪了？').toBe(true)
    const s = readFileSync(p, 'utf8')
    expect(s).toContain('shouldSkipGates')
    // 三条用例都在（真值表、字段改名、非对象事实不抛错）
    expect(s.match(/\bit\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})

/**
 * P3-17 的后半：**门禁脚本不许走测试接缝拿实现**。
 *
 * `scripts/rag-retrieval-check.ts` 原先 `import { __internals } from '…/retrieval/embedding.ts'`
 * 去拿 `simhash` / `popcount32` / `getPlanes` / `l2normalize` —— 那些的出处是
 * `query/vector-math.ts`（各自都有 named export）。走接缝的实际代价不是难看，而是：
 * 接缝是"给测试开后门"的口子，脚本依赖它之后，**真 API 改名会静默漏过门禁**
 * （门禁自己却还绿），而这份脚本正是"没有 vitest 也能立刻验证"的那道保险。
 * 测试用接缝是允许的（有些内部状态确实只有单测需要，比如要先跑 embedding 才拿得到的
 * `loadHashRows`），脚本不行。
 */
describe('门禁脚本不许依赖 __internals 测试接缝', () => {
  const scriptDir = join(ROOT, 'scripts')
  const scripts = readdirSync(scriptDir, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(ts|tsx|mjs|js)$/.test(e.name))
    .map(e => join(scriptDir, e.name))

  it('扫到了足够多的脚本（扫空 ⇒ 下面那条「零命中」是恒真）', () => {
    expect(scripts.length, `scripts/ 只扫到 ${String(scripts.length)} 份脚本`).toBeGreaterThan(40)
    // 判据自证：合成的"脚本用接缝"必须被抓到，而同名出现在注释里不算
    const fake = ts.createSourceFile('fake-check.ts',
      "import { __internals } from '../src/backend/wechat-data/src/query/retrieval/embedding.ts'\n"
      + "const v = __internals.simhash\nexport const x = __internals\n",
      ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const walk = (node: ts.Node): void => {
      const txt = node.getText(fake)
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && /(^|\.)__internals\b/.test(txt)) found.push(txt)
      ts.forEachChild(node, walk)
    }
    walk(fake)
    expect(found.length, '合成违例一个都没抓到 ⇒ 这条判据是空转').toBeGreaterThan(0)
    const commentOnly = ts.createSourceFile('fake2-check.ts', "// 别再走 '__internals' 拿实现\nexport const ok = 1\n", ts.ScriptTarget.Latest, true)
    let inComment = 0
    const w2 = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === '__internals') inComment += 1
      ts.forEachChild(node, w2)
    }
    w2(commentOnly)
    expect(inComment, '注释里的 __internals 被当成了依赖 ⇒ 判据会自己咬自己').toBe(0)
  })

  it('scripts/** 里没有任何一处引用 __internals', () => {
    const bad: string[] = []
    for (const f of scripts) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(mjs|js)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === '__internals') {
          bad.push(`${rel(f)}:${String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)}`)
        }
        ts.forEachChild(node, walk)
      }
      walk(sf)
    }
    expect(bad, `门禁脚本走测试接缝拿实现：\n${bad.join('\n')}\n纯逻辑请直接 import 它的出处（如 query/vector-math.ts）`).toEqual([])
  })
})
