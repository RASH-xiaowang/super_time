/**
 * H11：类型严格度的**已收紧档位**不许被悄悄退回。
 *
 * `tsconfig.base.json` 是按上游构建产物反推出来的，里面若干 `strict` 子开关被关着
 * （为了让既有代码能过）。每收紧一档就该钉住一档 —— 否则下一次「类型报错太多了，先关掉」
 * 就会把成果静默丢掉。2026-09-22 实测：`noImplicitAny` 只有 36 处、`noImplicitThis` 与
 * `strictFunctionTypes` **0 处**、`noUncheckedIndexedAccess` 客户端 0 / 后端 77 处
 * ⇒ 前三档全仓开、第四档只在客户端开，后端那一档留着记账（客户端基座仍是 `strict: false`，
 * 因为 `strictNullChecks` 不是「量一下就能开」的量级）。这里逐项钉住，退任何一项都会红。
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
const projects = ['src/backend/wechat-data/tsconfig.json', 'src/client/ui-wechat/tsconfig.json']

/** 已收紧的档位：一处一处记，退回任何一项都要红。 */
const ON: Array<[string, Record<string, unknown>, string]> = [
  ['noImplicitAny', base, '基座（后端）'],
  ['noImplicitThis', base, '基座（后端）'],
  ['strictFunctionTypes', base, '基座（后端）'],
  ['noImplicitAny', client, '客户端'],
  ['noImplicitThis', client, '客户端'],
  ['strictFunctionTypes', client, '客户端'],
  ['noUncheckedIndexedAccess', client, '客户端（量过 0 处）'],
]

describe('H11：TypeScript 严格度档位', () => {
  for (const [flag, where, label] of ON) {
    it(`${label} 的 ${flag} 保持 true（要关回去先在台账里说清代价）`, () => {
      expect(where[flag]).toBe(true)
    })
  }

  it('两个项目工程都不许把已收紧的档位覆盖回 false', () => {
    for (const rel of projects) {
      const own = options(rel)
      for (const flag of ['noImplicitAny', 'noImplicitThis', 'strictFunctionTypes']) {
        expect(own[flag] ?? true, `${rel} 把 ${flag} 覆盖回 false 了`).toBe(true)
      }
    }
  })

  it('仍未收紧的那一档照实记成 false，并写清欠多少（不给粉饰的空间）', () => {
    expect(base.noUncheckedIndexedAccess).toBe(false)
    // 客户端 0 处、后端 77 处（2026-09-22 实测）。收紧之后这条断言要主动改。
    expect(client.noUncheckedIndexedAccess).toBe(true)
  })
})
