/**
 * N32 第十一步：宿主 JS 的两份**手写** `.d.ts` 必须与实现双向对齐。
 *
 * ## 为什么这条守卫比声明文件本身更重要
 *
 * `wechat-paths.js` / `update.js` 的声明是手写的（沿用 `llm-retry.d.ts` 那条路）。
 * 手写声明的价值全在「它说的是实话」，而它坏掉的方式有两种，且**都不会让 tsc 报错**：
 *
 *   ① **漏一个导出** —— 那个成员在 TS 侧就是不存在。用它的地方会报 TS2305，看着像「用错了」，
 *      但如果没人用它（很常见：宿主层一堆函数只有 main.js 调），就连报错都没有，
 *      声明文件于是悄悄变成一份「只覆盖了一半的地图」。
 *   ② **多一个导出**（改了 JS 里的名字忘了同步，或干脆是发明出来的）—— 这才是真危险：
 *      类型检查通过，运行时 `undefined`。`typeof hostWrite === 'function'` 这种断言会红，
 *      但更多调用点连红都不会红。
 *
 * 所以这里做**双向差集**，两个方向都必须是空。
 *
 * ## 为什么不靠「让 tsc 从 JSDoc 生成」省掉这一步
 *
 * 试过，而且量过：生成是干净的，但宿主 JSDoc 里写的是 `@returns {object}` / `@param {{…}}`，
 * 变成真声明以后比 `any` 更窄而且错 —— 总量从 74 涨到 120。结论记在
 * `backend-tests-typecheck-ratchet.spec.ts` 的注释里：**上游类型本身就是错的时候，扩大覆盖面只会更糟**。
 * 本守卫的作用正是让「手写」这件事不至于重新退化成那份错的。
 *
 * ## 防空转
 *
 * 两个集合都断言非空：解析口径坏掉时它们会**同时变空**，那时「差集为空」是恒真的。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一个宿主模块：JS 是实现，d.ts 是声明。 */
const MODULES = [
  { name: 'wechat-paths.js', impl: 'wechat-paths.js', decl: 'wechat-paths.d.ts' },
  { name: 'update.js', impl: 'update.js', decl: 'update.d.ts' },
] as const

/**
 * 从 JS 的 `module.exports = { a, b, c: d }` 里取导出的**对外名字**。
 * 用 AST 而不是正则扫文本：JS 里注释与字符串都能出现 `module.exports`，而且键可以重排、可以带冒号。
 */
function jsExports(src: string): string[] {
  const sf = ts.createSourceFile('x.js', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const seen = new Set<ts.Node>()
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && /^module\.exports$/.test(node.left.getText(sf).replace(/\s/g, ''))
      && ts.isObjectLiteralExpression(node.right)) {
      for (const p of node.right.properties) {
        if (ts.isShorthandPropertyAssignment(p)) names.add(p.name.text)
        else if (ts.isPropertyAssignment(p)) names.add(p.name.getText(sf).replace(/['"]/g, ''))
        else if (ts.isSpreadAssignment(p)) names.add('…展开（见下面的显式断言）')
      }
    }
    node.forEachChild(walk)
  }
  walk(sf)
  return [...names]
}

/** 从 .d.ts 取**值**层面的导出名（`function` / `const` / `let` / `class` / `namespace`）。 */
function declValueExports(src: string): string[] {
  return [...src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|var|class|abstract\s+class|namespace)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1] as string)
}

describe('宿主层手写 .d.ts 与实现对齐（N32 收尾）', () => {
  for (const m of MODULES) {
    it(`${m.name} 的导出与 ${m.decl} 的声明双向无差集`, () => {
      const js = jsExports(readFileSync(join(HERE, '..', m.impl), 'utf8'))
      const dts = declValueExports(readFileSync(join(HERE, '..', m.decl), 'utf8'))
      // 防空转：两边都不许是空的（解析口径一坏就同时变空，差集「为空」就成了恒真）
      expect(js.length, `从 ${m.name} 一个导出都没解析出来 —— 解析口径失效`).toBeGreaterThan(3)
      expect(dts.length, `从 ${m.decl} 一个值导出都没解析出来 —— 声明文件的写法变了？`).toBeGreaterThan(3)
      expect(dts.filter((n) => !js.includes(n)), '声明里有、实现里却没有（发明成员或改了名没同步）').toEqual([])
      expect(js.filter((n) => !dts.includes(n)), '实现导出了、声明里却没有（地图缺一块）').toEqual([])
    })

    it(`${m.name} 的声明里不留 object / {} 这种「比 any 更窄而且错」的标注`, () => {
      const src = readFileSync(join(HERE, '..', m.decl), 'utf8')
      // 注释里出现 `object` 是正常的（很多地方正是在解释为什么不能这么写），只看类型位置
      const lines = src.split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .filter((l) => /:\s*object\b|Array<object>|:\s*\{\s*\}/.test(l))
      expect(lines, '这些位置要么给真类型，要么老实用 unknown/any').toEqual([])
    })
  }

  it('两份声明都真的存在（被人误删时，上面两条会因读不到文件而红，这里给一句人话）', () => {
    for (const m of MODULES) {
      const src = readFileSync(join(HERE, '..', m.decl), 'utf8')
      expect(src.length, `${m.decl} 是空的`).toBeGreaterThan(200)
      expect(src, `${m.decl} 缺头部说明：手写声明必须自己讲清楚为什么是手写`).toContain('手写')
    }
  })
})
