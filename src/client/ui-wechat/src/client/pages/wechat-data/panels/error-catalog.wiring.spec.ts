// @vitest-environment node
/**
 * 错误码参考的接线与形状判据。
 *
 * 这张卡最容易出现的“假完成”是：码表写好了，但设置里没渲染；或者复制文档时
 * 只有 code 没有“怎么办”。这里只钉最小事实：码唯一、每条有 fix、Settings 真的 map 它。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ERROR_CATALOG } from './error-catalog.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = readFileSync(join(HERE, 'Settings.tsx'), 'utf8')

describe('错误码参考', () => {
  it('码唯一、字段非空', () => {
    const codes = ERROR_CATALOG.map((e) => e.code)
    expect(new Set(codes).size, '错误码重复').toBe(codes.length)
    for (const entry of ERROR_CATALOG) {
      expect(entry.code, '空 code').not.toBe('')
      expect(entry.what, `${entry.code} 缺 what`).not.toBe('')
      expect(entry.fix, `${entry.code} 缺 fix`).not.toBe('')
    }
  })

  it('Settings 高级设置里真的渲染这张卡', () => {
    expect(SETTINGS).toContain("import { ERROR_CATALOG } from './error-catalog.ts'")
    expect(SETTINGS).toContain('<summary>错误码参考（排障用）</summary>')
    expect(SETTINGS).toMatch(/ERROR_CATALOG\.map/)
  })
})
