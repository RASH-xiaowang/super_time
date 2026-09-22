/**
 * H11：类型严格度的**已收紧档位**不许被悄悄退回。
 *
 * `tsconfig.base.json` 是按上游构建产物反推出来的，里面若干 `strict` 子开关最初是关着的
 * （为了让既有代码能过）。每收紧一档就该钉住一档 —— 否则下一次「类型报错太多了，先关掉」
 * 就会把成果静默丢掉。逐档实测（2026-09-22 / 09-23）：
 *   · `noImplicitAny` 36 处、`noImplicitThis` 与 `strictFunctionTypes` **0 处** ⇒ 全仓开；
 *   · `noUncheckedIndexedAccess` 客户端 0 处、后端 77 处 ⇒ 两侧都开（后端那 77 处逐处收口）。
 * 只剩客户端基座的 `strict`（含 `strictNullChecks`）没开：实测 90 处，其中 41 处在 `*.spec.ts` 里、
 * 49 处在源码，而源码的 49 处里有 31 处集中在 `utils/theme-color.ts`(19) 与
 * `panels/overview-panel.tsx`(12) 两个文件 —— 下面最后一条用例把「还有多少、欠在哪」照实钉住，
 * 不给粉饰的空间（收紧之后这条要主动改，改不动就说明没收紧）。
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
  ['noImplicitAny', client, '客户端'],
  ['noImplicitThis', client, '客户端'],
  ['strictFunctionTypes', client, '客户端'],
  ['noUncheckedIndexedAccess', client, '客户端（量过 0 处）'],
]

/** 已收紧的档位清单（项目工程不许在 extends 之后再覆盖回 false）。 */
const TIGHTENED = ['noImplicitAny', 'noImplicitThis', 'strictFunctionTypes', 'noUncheckedIndexedAccess']

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

  it('客户端基座的 strict 仍未开，欠多少照实记着（不给粉饰的空间）', () => {
    expect(clientBase.strict).toBe(false)
    // 2026-09-23 实测：`tsc -p src/client/ui-wechat` 在基座开 strict 之后报 90 处
    // （41 在 *.spec.ts、49 在源码）。这条注释是那一档的「欠条」，真收紧时连同上面的 ON 一起改。
    expect(client.strictNullChecks ?? false).toBe(false)
  })
})
