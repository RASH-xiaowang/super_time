/**
 * P3-16「测试辅助不许混在生产源码目录里」的守卫（CODE-AUDIT-2026-09-26 第四批）。
 *
 * ## 要守的三件事
 *
 * ① **面板/页面那一侧不许出现 node 内建模块的 import**。搬走之前 `panels/` 里躺着
 *   `wiring-kit.ts` / `chats-source.ts` / `settings-source.ts` 三份读盘的测试辅助 ——
 *   它们只被 `*.spec.ts` 引用、不会被打包，但住在生产目录里意味着：
 *   按目录扫源码的守卫（单函数行数棘轮、文件体积棘轮、幻影引用守卫）把它们算成产品代码，
 *   而新人翻 `panels/` 时读到的是 fs 样板。判据走 AST 的 import 声明 ——
 *   注释里写 `node:fs` 不算数（本仓已三次栽在文本扫描上）。
 * ② **辅助住在 `src/client/ui-wechat/src/client/test-helpers/`，且只有 spec 引用它们**。
 * ③ **搬家之后那两份「联合源码」扫描必须还在读面板目录** —— 这是本轮最容易静默失手的地方：
 *   两份辅助原先扫的是「我自己所在的目录」，搬家那天若忘了把目录写死，它们会去扫
 *   `test-helpers/`（一个 `chats-*` 文件都没有）⇒ 联合源码退化成只剩入口那一份，
 *   而**所有读这份联合的守卫集体失去靶子却仍然全绿**。
 *   所以这里不只断言"读到了东西"，而是断言读到了**只有拆分模块里才有**的字样。
 *
 * 本文件自己也读盘 —— 它住在 test-helpers/，正是②要的那种位置。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { readChatsSource } from './chats-source.ts'
import { readSettingsSource } from './settings-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..')
const rel = (p: string): string => relative(CLIENT, p).split(sep).join('/')

/** node 内建（含裸名与 `node:` 前缀两种写法）：打包进浏览器的那一侧一个都不该出现。 */
const NODE_BUILTIN = /^(node:|fs$|path$|os$|url$|crypto$|sqlite$|child_process$)/

/** `pages/**` 那一侧的全部非 spec 源文件（会被打包、也算产品代码的那一批）。 */
function pageSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) pageSources(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

/** 整个 client 根下的 .ts/.tsx（spec 也在内）。 */
function allClientSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'lib') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) allClientSources(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 一个源文件里所有 import 来源：静态 `import … from`、`export { x } from`、
 * 以及 `await import('…')`（漏掉后者的话，`await import('node:fs')` 就能溜过去）。
 */
function importSources(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) out.push(node.arguments[0].text)
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

const HELPER_NAMES = ['wiring-kit.ts', 'chats-source.ts', 'settings-source.ts'] as const
const HELPER_RE = /from '[^']*(?:wiring-kit|chats-source|settings-source)\.ts'/

describe('测试辅助的位置纪律（P3-16）', () => {
  const pages = pageSources(join(CLIENT, 'pages'))

  it('扫到了足够多的面板源文件（扫空 ⇒ 下面那条「不许 import node 内建」是恒真）', () => {
    expect(pages.length, `pages/** 只扫到 ${String(pages.length)} 份非 spec 源文件`).toBeGreaterThan(80)
  })

  it('生产那一侧（pages/** 的非 spec 文件）不 import 任何 node 内建模块', () => {
    for (const f of pages) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true)
      const bad = importSources(sf).filter(m => NODE_BUILTIN.test(m))
      expect(bad, `${rel(f)} 里出现了 node 内建 import：${bad.join(', ')} —— 读盘的测试辅助要住在 test-helpers/`).toEqual([])
    }
  })

  it('test-helpers/ 里就是那三份辅助、两份联合读取器和它们的自检 spec', () => {
    const names = readdirSync(HERE).sort()
    expect(names).toEqual(['chats-source.ts', 'placement.spec.ts', 'settings-source.ts', 'wiring-kit.spec.ts', 'wiring-kit.ts'])
    for (const h of HELPER_NAMES) expect(names).toContain(h)
  })

  it('三份辅助只被 *.spec.ts 引用（生产代码不许依赖读盘 helper）', () => {
    const all = allClientSources(CLIENT)
    const hits = all.filter(f => HELPER_RE.test(readFileSync(f, 'utf8')))
    expect(hits.length, '一个引用都没找到 ⇒ 这条判据在空转').toBeGreaterThan(20)
    for (const f of hits) {
      expect(f.endsWith('.spec.ts'), `${rel(f)} 不是 spec 却引用了测试辅助`).toBe(true)
    }
  })

  it('两份联合源码搬完还在读面板目录：读到的是拆分模块里的字样，不是入口那一份', () => {
    const chats = readChatsSource()
    // `ChatsExportDialog` 只住在 `chats-export-dialog.tsx`（#19 第四刀拆出的那一屏）。
    // 扫描目录若退回 HERE（也就是 test-helpers/），这一支永远读不到，
    // 而"长度 > 0"、"含 Chats.tsx 里的字样"这些都照样绿。
    expect(chats, 'readChatsSource 的联合里没有 chats-export-dialog 那一支 ⇒ 扫描目录指错了').toContain('ChatsExportDialog')
    expect(chats.length).toBeGreaterThan(20_000)
    const settings = readSettingsSource()
    expect(settings, 'readSettingsSource 的联合里没有 settings-* 拆分模块 ⇒ 扫描目录指错了').toContain('useSettingsState')
    expect(settings.length).toBeGreaterThan(10_000)
  })

  it('反例自证：把 node:fs 塞回面板源文件，同一套判据必须抓住', () => {
    const stat = ts.createSourceFile('fake.tsx', "import { existsSync } from 'node:fs'\nexport const x = existsSync('a')\n", ts.ScriptTarget.ESNext, true)
    expect(importSources(stat).filter(m => NODE_BUILTIN.test(m)), '静态 import 没被抓住 ⇒ 上面那条是空转').toEqual(['node:fs'])
    const dyn = ts.createSourceFile('fake2.ts', "const m = await import('node:fs')\nexport { y } from 'node:path'\n", ts.ScriptTarget.ESNext, true)
    expect(importSources(dyn).filter(m => NODE_BUILTIN.test(m)).sort()).toEqual(['node:fs', 'node:path'])
    // 注释里出现 node:fs 不该算数（否则面板里任何一句"当初为什么搬走"的说明都会自己咬自己）
    const commentOnly = ts.createSourceFile('fake3.ts', "// 别再 import 'node:fs'\n/* import x from 'node:os' */\nexport const ok = 1\n", ts.ScriptTarget.ESNext, true)
    expect(importSources(commentOnly).filter(m => NODE_BUILTIN.test(m))).toEqual([])
  })
})
