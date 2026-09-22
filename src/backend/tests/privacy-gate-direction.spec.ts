/**
 * 隐私闸门的**失败方向**必须是「拦下」。
 *
 * 起因（2026-09-20）：`outboundBlocked` 的 catch 原本 `return false`、`privacyBlocked`
 * 的 catch 原本 `return null` —— 都是「读不到设置 = 当作没开拦截」。于是用户显式开了
 * 「出站拦截」后，`wechat_privacy.db` 损坏/被锁/被换成一个目录的那一刻，拦截静默失效：
 * `getAvatarsLocal` 会把远端头像 URL 照发（渲染层随即去微信 CDN 取图）。
 *
 * 为什么用源码级守卫而不是行为用例：`outboundBlocked` 只被 `getAvatarsLocal` 的
 * `allowRemote` 用掉，要端到端区分「allowRemote 真为 false」得造齐
 * head_image.db + 联系人库两套夹具；而这里要钉住的其实是一条**规则** ——
 * 权限判断的 catch 不许给出放行值。规则用 AST 查最直接，注释与字符串骗不过它。
 *
 * 行为侧的配套在 `wechat-data/tests/kb-summary.spec.ts`（「隐私库读不到时按
 * 「拦截出站」处理」）与 `privacy-audit.spec.ts`（读不到要抛，不许编默认值）。
 * @vitest-environment node
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// M21 结构刀：三处接缝都住在网关的「核」里 ⇒ 读组成这个类的两个文件（**不**含 remotes/ ——
// 判据要的就是「接缝在网关类里」，实现模块里的同名调用不算）。
import { gatewayClassSource } from './gateway-source.ts'

/** 三处接缝：失败时必须拦下，不许在 catch 里编一个「没开拦截」。 */
const SEAMS = ['outboundBlocked', 'privacyBlocked', 'privacyGate']

type SeamScan = { found: boolean; catches: number; permissiveReturn: string | null }

function scan(src: string): Map<string, SeamScan> {
  const sf = ts.createSourceFile('gateway.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = new Map<string, SeamScan>(SEAMS.map((n) => [n, { found: false, catches: 0, permissiveReturn: null }]))

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      const hit = out.get(name)
      if (hit) {
        hit.found = true
        const walk = (n: ts.Node): void => {
          if (ts.isCatchClause(n)) {
            hit.catches++
            // catch 体内出现 `return false` / `return null` 就是放行。
            const inner = (m: ts.Node): void => {
              if (ts.isReturnStatement(m) && m.expression) {
                const e = m.expression
                const permissive =
                  e.kind === ts.SyntaxKind.FalseKeyword ||
                  e.kind === ts.SyntaxKind.NullKeyword ||
                  (ts.isIdentifier(e) && e.text === 'undefined')
                if (permissive) hit.permissiveReturn = e.getText()
              }
              m.forEachChild(inner)
            }
            if (n.block) inner(n.block)
          }
          n.forEachChild(walk)
        }
        walk(node)
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('隐私闸门的失败方向', () => {
  const scans = scan(gatewayClassSource())

  it('三个接缝都还在（防空转）：找不到方法名说明守卫已失效', () => {
    for (const name of SEAMS) {
      const s = scans.get(name)!
      expect(s.found, `${name} 没找到 —— 改名或挪走后必须同步本用例`).toBe(true)
      expect(s.catches, `${name} 里没有 catch 子句，守卫无从判断`).toBeGreaterThan(0)
    }
  })

  it('catch 里不许出现 return false / return null（读不到 ≠ 没开拦截）', () => {
    const bad = SEAMS
      .map((n) => [n, scans.get(n)!] as const)
      .filter(([, s]) => s.permissiveReturn !== null)
      .map(([n, s]) => `${n} 的 catch 返回了 ${s.permissiveReturn}`)
    expect(
      bad,
      '隐私是权限判断：读不到设置时必须拦下（返回 true / 带原因的拦截文案），' +
        `不能当作「用户没开拦截」放行：\n  ${bad.join('\n  ')}`,
    ).toEqual([])
  })
})
