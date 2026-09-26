/**
 * P3-8「零引用导出」的守卫（CODE-AUDIT-2026-09-26 第四批）。
 *
 * ## 要守的两件事
 *
 * ① **删掉的死导出不许复活**。报告点名的这几条实测没有任何引用点：
 *   `resolveImageMd5`（被批版 `resolveImageMd5sBatch` 取代）、
 *   `isQueueRunning`（注释写着"诊断与用例用"，而全仓没有一处用例）、
 *   `senderNameMap`（`messages.ts` 早已删掉那条 SenderName2Id 回退，这是残留）、
 *   `embedOne`（同上一类），它们整条删掉了 ⇒ 任何文件再导出同名就是回退。
 *   `KEY_SIZE` / `PBKDF2_ITERATIONS` / `PAGE_SIZE` / `SALT_SIZE` / `AES_BLOCK_SIZE` 是另一种形状：
 *   **常量本身是活的**（`db-key-v4.ts` / `db-key-verify.ts` / `image-key-resolver.ts` 各自在用），
 *   死掉的是 `keys/types.ts` 里那份**没人 import 的第二处出处** —— 同一个数字两处定义而只有一处承重，
 *   改的人只会改到自己那一份。所以这一族判据针对 `keys/types.ts`，不针对全仓同名。
 * ② **选了"反向接线"的那条要真的有取用点**：`hammingDistance` 没删，因为 `selectByHamming`
 *   里正逐字重复着它那两次 `popcount32` 异或相加 —— 现在取用点改成调用它。
 *   只断言"它被导出了"没有意义（死导出也是被导出的），要断言的是**有调用点**。
 *
 * 走 AST 而不是文本扫描：`media-image.ts` 的注释与函数名里就有 `resolveImageMd5sBatch`
 * （子串包含 `resolveImageMd5`），而本仓已三次栽在"注释里的代码字样"上。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(HERE, '..', 'src')

/** 整条删掉的导出：全仓任何文件都不许再导出它们。 */
const DEAD_FUNCTIONS = ['resolveImageMd5', 'isQueueRunning', 'senderNameMap', 'embedOne'] as const

/** 只该在 `keys/types.ts` 里消失的名字（别处的同名是活的，不能拿全仓判）。 */
const DEAD_IN_KEY_TYPES = ['KEY_SIZE', 'PBKDF2_ITERATIONS', 'PAGE_SIZE', 'SALT_SIZE', 'AES_BLOCK_SIZE'] as const

/** 反向接线：名字 → 该文件里必须既有导出、又有调用点。 */
const WIRED_EXPORTS: Array<{ name: string; file: string }> = [
  { name: 'hammingDistance', file: 'query/vector-math.ts' },
]

function listTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'deps' || e.name === 'node_modules' || e.name === 'lib') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listTs(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const FILES = listTs(SRC_ROOT)
const rel = (abs: string): string => relative(SRC_ROOT, abs).split(sep).join('/')

/** 一个源文件里所有**被 export 出去**的顶层名字（函数 / 类 / 变量 / 接口 / 类型别名 / 具名再导出）。 */
function exportedNamesOf(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const stmt of sf.statements) {
    // `export { a as b }` / `export type { X } from …` 没有 modifier（export 关键字是这句话本身），
    // 拿 isExported 去筛会整条跳过 ⇒ "换一根 barrel 用别名再导出"就能绕过判据。
    // 反例自证那一节专门踩这一点。`export * from` 交不出具体名字，是这套判据的**已知上限**。
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const e of stmt.exportClause.elements) out.add(e.name.text)
      }
      continue
    }
    if (!isExported(stmt)) continue
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)
      || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) {
      out.add(stmt.name.text)
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) out.add(d.name.text)
    }
  }
  return out
}

const PARSED = new Map<string, ts.SourceFile>()
function parsed(abs: string): ts.SourceFile {
  let sf = PARSED.get(abs)
  if (!sf) {
    sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ESNext, true)
    PARSED.set(abs, sf)
  }
  return sf
}

/** 文件里 `const NAME = …` 这类**变量声明**的处数（不看注释，所以第二处出处骗不了它）。 */
function constDeclsOf(name: string, prefix: string): string[] {
  const out: string[] = []
  for (const f of FILES) {
    if (!rel(f).startsWith(prefix)) continue
    const sf = parsed(f)
    let found = false
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = true
      ts.forEachChild(node, walk)
    }
    walk(sf)
    if (found) out.push(rel(f))
  }
  return out
}

/** 某个名字被**直接调用**的次数（限定在一个文件里）。 */
function callSitesIn(name: string, file: string): number {
  let hits = 0
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) hits += 1
    ts.forEachChild(node, walk)
  }
  walk(parsed(join(SRC_ROOT, file)))
  return hits
}

describe('零引用导出的处置结果（P3-8）', () => {
  it('三张清单与扫描都不是空的（清空 ⇒ 下面的判据全变恒真）', () => {
    expect(DEAD_FUNCTIONS.length).toBeGreaterThanOrEqual(4)
    expect(DEAD_IN_KEY_TYPES.length).toBeGreaterThanOrEqual(5)
    expect(WIRED_EXPORTS.length).toBeGreaterThanOrEqual(1)
    expect(FILES.length, '一个 .ts 都没扫到 ⇒ 扫描器坏了').toBeGreaterThan(50)
  })

  it('删掉的那四条，全仓没有任何文件再导出它们', () => {
    for (const f of FILES) {
      const names = exportedNamesOf(parsed(f))
      for (const dead of DEAD_FUNCTIONS) {
        expect(names.has(dead), `${rel(f)} 又导出了 ${dead}（P3-8 已确认零引用并整条删掉）`).toBe(false)
      }
    }
  })

  it('keys/types.ts 不许再长出那份"没人 import 的共享常量"', () => {
    const names = exportedNamesOf(parsed(join(SRC_ROOT, 'keys', 'types.ts')))
    for (const dead of DEAD_IN_KEY_TYPES) {
      expect(names.has(dead), `keys/types.ts 又导出了 ${dead} ⇒ 同一个数字有了第二处出处`).toBe(false)
    }
    // 而真正在用的那一份必须还在（否则这条判据就成了"删干净"的空头支票）
    expect(constDeclsOf('PAGE_SIZE', 'keys/'), `PAGE_SIZE 在 keys/ 里的出处变了：${constDeclsOf('PAGE_SIZE', 'keys/').join(', ')}`).toEqual(['keys/db-key-v4.ts'])
  })

  it('反向接线那条：既在导出面里，也真的有调用点（不是又一个"导出了但没人用"）', () => {
    for (const { name, file } of WIRED_EXPORTS) {
      expect(exportedNamesOf(parsed(join(SRC_ROOT, file))).has(name), `${file} 不再导出 ${name}`).toBe(true)
      expect(callSitesIn(name, file), `${name} 被导出了却一处都没调用 ⇒ 它又变回零引用导出`).toBeGreaterThanOrEqual(1)
    }
  })

  it('反例自证：合成的"复活"源码必须被同一套收集器抓住', () => {
    for (const dead of [...DEAD_FUNCTIONS, ...DEAD_IN_KEY_TYPES]) {
      const revived = ts.createSourceFile('fake.ts', `export function ${dead}(): void {}\nexport const ${dead} = 1\n`, ts.ScriptTarget.ESNext, true)
      const names = exportedNamesOf(revived)
      expect(names.has(dead), `收集器认不出导出的 ${dead} ⇒ 上面两条「不许再导出」是恒真`).toBe(true)
    }
    const barrel = ts.createSourceFile('fake.ts', `function inner(): void {}\nexport { inner as ${'resolveImageMd5'} }\n`, ts.ScriptTarget.ESNext, true)
    expect(exportedNamesOf(barrel).has('resolveImageMd5'), '具名再导出没被收集 ⇒ 换根 barrel 就能绕过判据').toBe(true)
    const caller = ts.createSourceFile('fake.ts', 'function h(a: { lo: number }): number { return a.lo }\nh({ lo: 1 })\n', ts.ScriptTarget.ESNext, true)
    let hits = 0
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'h') hits += 1
      ts.forEachChild(node, walk)
    }
    walk(caller)
    expect(hits, '调用点计数器空转 ⇒「有调用点」那条是恒真').toBe(1)
  })
})
