// @vitest-environment node
/**
 * 朋友圈卡片不出现内层滚动条（用户 2026-10-19 明确要求「删除卡片中的滚动条」）。
 *
 * 形状判据：
 * - `.card` 只负责卡片自身样式，高度随内容；不许再写 `max-height` / `overflow-y: auto|scroll`；
 * - 滚动只允许发生在时间线的外层 `.scroll`（虚拟列表的既定容器）。
 *
 * 为什么不测 jsdom 计算样式：CSS Modules 的规则在 jsdom 里不解析；这里读源文件，
 * 真正渲染由 `moments-virtual` 的虚拟化判据与真机截图覆盖。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(HERE, 'moments.module.css'), 'utf8')

/** 取一个顶层 class 的规则块（到第一个 `}` 为止；这些规则都是单层）。 */
function block(selector: string): string {
  const at = CSS.indexOf(`.${selector} {`)
  expect(at, `moments.module.css 里找不到 .${selector}`).toBeGreaterThanOrEqual(0)
  return CSS.slice(at, CSS.indexOf('}', at) + 1)
}

describe('朋友圈卡片：内层滚动条', () => {
  it('.card 不再用 max-height 限制高度，也不在卡内 scroll', () => {
    const card = block('card').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(card, '.card 又出现了 max-height ⇒ 长卡会在卡内被截断并产生滚动条').not.toMatch(/max-height/)
    expect(card, '.card 又出现了 overflow-y: auto|scroll ⇒ 卡片里的滚动条回来了').not.toMatch(/overflow-y:\s*(auto|scroll)/)
  })

  it('时间线外层 .scroll 仍是唯一滚动容器', () => {
    expect(block('scroll').replace(/\/\*[\s\S]*?\*\//g, ''), '外层时间线不再滚动，长列表会撑爆页面').toMatch(/overflow-y:\s*auto/)
  })
})
