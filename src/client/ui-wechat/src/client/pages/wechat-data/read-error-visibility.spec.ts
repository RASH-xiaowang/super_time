/**
 * 「读失败」不许被显示成「没有数据」（N1 的收尾守卫）。
 *
 * 后端把「库打不开 / 读失败」与「确实没有条目」分成两件事：快照里带 `readError` 就是前者。
 * 但这个字段**只有面板真的去读它**才有意义 —— 忘了读，用户看到的就是一个空列表，
 * 而真实原因是数据根损坏/没解密（第 47 轮勘测 `chats.module.css` 时顺手发现这条判据只有零散的
 * 面板级用例，没有全局网）。
 *
 * 本用例不靠人工维护清单，而是**从类型推**：
 *   ① 后端哪些快照类型带 `readError`；
 *   ② api 层（`api-*.ts`）里哪些导出函数的返回类型是它们（面板调的是这层的包装）；
 *   ③ 调用这些方法的面板文件必须自己提到 `readError`。
 * 新接一个带 `readError` 的快照却忘了显示 ⇒ 这里会红。
 *
 * 2026-09-26（P1-1 顺带）修了判据自己的两个错：
 *   · ② 原本是 `export async function (\\w+)\\s*\\([\\s\\S]*?\\)\\s*:\\s*Promise<(\\w+)>`。
 *     返回类型写成内联对象（`Promise<{ ok: boolean }>`)时那一段匹配不上，`[\\s\\S]*?` 就会
 *     **继续吃下一个函数**直到撞上能匹配的签名 —— 于是 `apiSearchUnified` 的返回类型被记到
 *     `apiCancelSearch` 头上（§八 明写「跨花括号禁 `[\\s\\S]*?`」，这条就是它自己的反例）。
 *     现在按 TypeScript AST 逐个函数读返回类型注释。
 *   · ③ 原来只扫 `panels/*.tsx`，而全局搜索的结果面板住在上一层的 `WechatDataPanel.tsx`
 *     ⇒ 「调用方存在」会因为找错目录而假红。面板根目录那层一起纳入。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_TYPES = join(HERE, '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src')
const PANELS = join(HERE, 'panels')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** ① 带 readError 的后端类型名。 */
function typesWithReadError(): string[] {
  const files = readdirSync(BACKEND_TYPES).filter((f) => /^types(-[a-z-]+)?\.ts$/.test(f))
  const out = new Set<string>()
  for (const f of files) {
    for (const m of read(join(BACKEND_TYPES, f)).matchAll(/export interface (\w+)[\s\S]*?\n\}/g)) {
      if (/readError\??:/.test(m[0]) && m[1]) out.add(m[1])
    }
  }
  return [...out].sort()
}

/**
 * ② api 层里**返回这些类型**的导出函数（面板调的是这层的包装，不是 `remote.*`）。
 * 只认 `Promise<简单标识符>`；`Promise<{…}>` / `Promise<A | B>` 没有可查的 `readError`，不参与。
 */
function apiWrappersReturning(names: string[]): Array<{ fn: string; type: string; file: string }> {
  const hits: Array<{ fn: string; type: string; file: string }> = []
  for (const f of readdirSync(HERE).filter((x) => /^api(-[a-z-]+)?\.ts$/.test(x))) {
    const sf = ts.createSourceFile(f, read(join(HERE, f)), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const seen = new Set<ts.Node>()
    const walk = (node: ts.Node): void => {
      // 去重：本仓踩过「同一子树走两遍 ⇒ 计数翻倍」
      if (seen.has(node)) return
      seen.add(node)
      if (ts.isFunctionDeclaration(node) && node.name && node.type
        && (node.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const ret = node.type
        if (ts.isTypeReferenceNode(ret) && ret.typeName.getText(sf) === 'Promise') {
          const arg = (ret.typeArguments ?? [])[0]
          if (arg && ts.isTypeReferenceNode(arg)) {
            const typeName = arg.typeName.getText(sf).split('.').pop() ?? ''
            if (names.includes(typeName)) hits.push({ fn: node.name.getText(sf), type: typeName, file: f })
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
  }
  return hits.sort((a, b) => a.fn.localeCompare(b.fn))
}

/** ③ 要守的界面文件：`panels/*.tsx` + 面板根目录那层（排除用例）。 */
function uiFiles(): string[] {
  const inPanels = readdirSync(PANELS)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.spec.'))
    .map(f => join(PANELS, f))
  const atRoot = readdirSync(HERE)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.spec.'))
    .map(f => join(HERE, f))
  return [...inPanels, ...atRoot].sort()
}

describe('N1：带 readError 的快照必须在面板里被区分显示', () => {
  const types = typesWithReadError()
  const wrappers = apiWrappersReturning(types)

  it('后端确实有带 readError 的快照类型，且 api 层有对应包装（防止判据空转）', () => {
    expect(types.length).toBeGreaterThan(0)
    expect(wrappers.length, 'api 层没有返回这些类型的函数 —— ② 的解析口径需要更新').toBeGreaterThan(0)
  })

  it('② 不再跨函数串味（回归哨兵）', () => {
    const fns = wrappers.map((w) => w.fn)
    // `apiCancelSearch(): Promise<{ ok: boolean }>` —— 老正则会把下一个函数的返回类型记到它头上
    expect(fns, 'apiCancelSearch 的返回类型是内联对象，不该进名单').not.toContain('apiCancelSearch')
    for (const w of wrappers) {
      expect(types, `${w.fn}() 被记成 ${w.type}，但它不在带 readError 的类型清单里`).toContain(w.type)
    }
    // 反过来：真该在的那条必须在（否则说明 AST 口径又读不到东西了）
    expect(fns, 'apiSearchUnified 返回 UnifiedSearchSnapshot，②却漏了').toContain('apiSearchUnified')
  })

  for (const { fn, type } of wrappers) {
    it(`${fn}()（${type}）的调用方面板读了 readError`, () => {
      // 面板是从 api 层**具名导入后裸调**（`apiGetKbFiles(...)`），不是 `remote.getKbFiles(...)`
      const callers = uiFiles().filter((p) => new RegExp(`(?<![\\w$.])${fn}\\s*\\(`).test(read(p)))
      expect(callers.length, `没有任何界面文件调用 ${fn}()；要么判据该更新，要么接口已死`).toBeGreaterThan(0)
      const blind = callers.filter((p) => !read(p).includes('readError'))
      expect(blind, `这些面板调了 ${fn}() 却没读 readError（读失败会被显示成空数据）：${blind.join(', ')}`).toEqual([])
    })
  }
})
