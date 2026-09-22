/**
 * H11：类型严格度的**已收紧档位**不许被悄悄退回。
 *
 * `tsconfig.base.json` 是按上游构建产物反推出来的，里面若干 `strict` 子开关被关着
 * （为了让既有代码能过）。每收紧一档就该钉住一档 —— 否则下一次「类型报错太多了，先关掉」
 * 就会把成果静默丢掉。这里只钉已收紧的那一档（`noImplicitAny`），没收紧的照实记成 false，
 * 免得用例替谁说谎。
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

describe('H11：TypeScript 严格度档位', () => {
  it('noImplicitAny 已经开成 true（要关回去必须先在台账里说清代价）', () => {
    expect(base.noImplicitAny).toBe(true)
  })

  it('两个项目工程都不许在 extends 之后把它改回 false', () => {
    for (const rel of ['src/backend/wechat-data/tsconfig.json', 'src/client/ui-wechat/tsconfig.json']) {
      const own = options(rel)
      expect(own.noImplicitAny ?? true, `${rel} 把 noImplicitAny 覆盖回 false 了`).toBe(true)
    }
  })

  it('其余仍未收紧的档位保持显式 false（用例与现状一致，不粉饰）', () => {
    for (const k of ['noImplicitThis', 'noUncheckedIndexedAccess', 'strictFunctionTypes']) {
      expect(base[k], `${k} 若已收紧，请把本用例移到上一档`).toBe(false)
    }
  })
})
