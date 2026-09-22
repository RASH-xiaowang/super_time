/**
 * H11：类型严格度的**已收紧档位**不许被悄悄退回。
 *
 * `tsconfig.base.json` 是按上游构建产物反推出来的，里面若干 `strict` 子开关最初是关着的
 * （为了让既有代码能过）。每收紧一档就该钉住一档 —— 否则下一次「类型报错太多了，先关掉」
 * 就会把成果静默丢掉。逐档实测：
 *   · `noImplicitAny` 36 处、`noImplicitThis` 与 `strictFunctionTypes` **0 处** ⇒ 全仓开；
 *   · `noUncheckedIndexedAccess` 客户端 0 处、后端 77 处 ⇒ 两侧都开（后端那 77 处逐处收口）；
 *   · 客户端基座的 `strict`（含 `strictNullChecks`）实测 90 处 ⇒ 开（2026-09-23）；
 *   · `noImplicitOverride` 两侧各 **0 处** ⇒ 顺手一起开。
 * 剩下的债照实钉在最后一条用例里（`exactOptionalPropertyTypes`、`noUnusedLocals`），
 * 数字都是当场量过的 —— 2026-09-22 曾把「客户端 strictNullChecks」写成「唯一真正的大工程」，
 * 实际只有 90 处，而那个「实测」根本没量过。收紧或退回都要主动改用例，不给粉饰空间。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function options(rel: string): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, rel), 'utf8').replace(/^\s*"\/\/".*$/m, '')
  return JSON.parse(raw).compilerOptions as Record<string, unknown>
}

const base = options('tsconfig.base.json')
const client = options('src/client/ui-wechat/tsconfig.json')
const clientBase = options('tsconfig.base.client.json')
const projects = ['src/backend/wechat-data/tsconfig.json', 'src/client/ui-wechat/tsconfig.json']

/** 已收紧的档位：一处一处记，退回任何一项都要红。 */
const ON: Array<[string, Record<string, unknown>, string]> = [
  ['noImplicitAny', base, '基座（后端）'],
  ['noImplicitThis', base, '基座（后端）'],
  ['strictFunctionTypes', base, '基座（后端）'],
  ['noUncheckedIndexedAccess', base, '基座（后端）'],
  ['noImplicitOverride', base, '基座（后端）'],
  ['strict', clientBase, '客户端基座（含 strictNullChecks，2026-09-23 开）'],
  ['noImplicitOverride', clientBase, '客户端基座'],
  ['noImplicitAny', client, '客户端'],
  ['noImplicitThis', client, '客户端'],
  ['strictFunctionTypes', client, '客户端'],
  ['noUncheckedIndexedAccess', client, '客户端（量过 0 处）'],
]

/** 已收紧的档位清单（项目工程不许在 extends 之后再覆盖回 false）。 */
const TIGHTENED = ['noImplicitAny', 'noImplicitThis', 'strictFunctionTypes', 'noUncheckedIndexedAccess', 'noImplicitOverride']

describe('H11：TypeScript 严格度档位', () => {
  for (const [flag, where, label] of ON) {
    it(`${label} 的 ${flag} 保持 true（要关回去先在台账里说清代价）`, () => {
      expect(where[flag]).toBe(true)
    })
  }

  it('两个项目工程都不许把已收紧的档位覆盖回 false', () => {
    for (const rel of projects) {
      const own = options(rel)
      for (const flag of TIGHTENED) {
        expect(own[flag] ?? true, `${rel} 把 ${flag} 覆盖回 false 了`).toBe(true)
      }
    }
  })

  it('还没收紧的档位照实记成 false，并写清各测过多少（不给粉饰的空间）', () => {
    // 数字都是 2026-09-23 当场量的（方法：临时把该项改成 true 跑 tsc 数报错，再按 sha256 还原）。
    // exactOptionalPropertyTypes：后端 32 处；客户端从「已收口的 0 处」涨到 57 处上下
    //   （打开后 tsc 总报错 98，其中 41 是当时尚未收完的 spec ⇒ EOPT 自身约 57 处）。
    expect(base.exactOptionalPropertyTypes).toBe(false)
    expect(client.exactOptionalPropertyTypes).toBe(false)
    // noUnusedLocals：后端 515 处 —— 这一项更像 lint 而不是类型口径，刻意留在这里记账。
    expect(base.noUnusedLocals).toBe(false)
  })
})
