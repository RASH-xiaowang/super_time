/**
 * 拖拽手柄的位置契约（2026-11-19）。
 *
 * ## 为什么单独钉这条
 *
 * 用户要求「数据总览」与「年度报告」的拖拽按钮**一定在卡片右上角**。
 * 之前它在 `.canvasRight` 里（卡头的一个 `flex-wrap: wrap` 子容器），于是：
 *   · 标题长的时候，整个 `canvasRight` 换到第二行 ⇒ 手柄跑到**左下**；
 *   · 右上角还有分区药丸 + 操作按钮 + 折叠按钮（总览的卡就是这样）时，
 *     `.canvasRight` 自己也 `wrap` ⇒ 手柄被挤到**中间偏下**。
 *
 * 这类问题在源码里"看着没问题"（手柄确实是卡头里最后一个元素），只有真渲染
 * 才知道它跑哪去了。所以判据必须是**结构 + 定位方式**两条：
 *   ① 手柄是卡片（`section`）的**直接子元素**，不在卡头/右侧容器的流里；
 *   ② 它的定位是 `position: absolute` 且带 `top` / `right`。
 * 满足这两条，位置就只由 `top/right` 决定，与标题长短、角标多少无关。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const cardTsx = readFileSync(join(HERE, 'card-canvas-card.tsx'), 'utf8')
const cssText = readFileSync(join(HERE, 'card-canvas.module.css'), 'utf8')
/** 剥注释后再断言（本文件的说明里会引用旧写法，裸词匹配会被自己骗到）。 */
const cssCode = cssText.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某条选择器的声明（同名规则合并）。 */
function declarationsOf(selector: string): string[] {
  const out: string[] = []
  postcss.parse(cssCode).walkRules((rule) => {
    if (rule.selector.trim() !== selector) return
    rule.walkDecls((decl) => { out.push(`${decl.prop}:${decl.value}`) })
  })
  return out
}

describe('拖拽手柄固定在卡片右上角', () => {
  it('手柄是卡片（section）的直接子元素，不在卡头里', () => {
    // 卡片根 → 手柄：中间不允许再套一层容器。
    // 判据：`<section ...>` 之后、`<div className={css.canvasHead}>` 之前就出现手柄。
    const sectionAt = cardTsx.indexOf('className={css.canvasCard}')
    const handleAt = cardTsx.indexOf('data-canvas-handle=""')
    const headAt = cardTsx.indexOf('className={css.canvasHead}')
    expect(sectionAt, '找不到卡片根').toBeGreaterThan(-1)
    expect(handleAt, '找不到拖拽手柄').toBeGreaterThan(-1)
    expect(headAt, '找不到卡头').toBeGreaterThan(-1)
    expect(handleAt, '手柄必须在卡头之前（即卡片的直接子元素），否则会被 flex 布局挤走')
      .toBeLessThan(headAt)
    expect(handleAt, '手柄必须在卡片根之后').toBeGreaterThan(sectionAt)
  })

  it('手柄不在 canvasRight 容器里', () => {
    /**
     * `canvasRight` 是 `flex-wrap: wrap` 的容器：放在里面的手柄会被折行挤走。
     *
     * 判据必须**按标签配平取整块**再查内部有没有手柄 —— 早先我用
     * 「找 `</span>` 当结尾」，但 `canvasRight` 里本来就有嵌套的 `<span>`
     * （分区药丸 / 附注），第一个 `</span>` 落在内部，区间算错，这条断言形同虚设
     * （变异验证时它没红，才发现）。
     */
    const openAt = cardTsx.indexOf('<span className={css.canvasRight}>')
    expect(openAt, '找不到 canvasRight').toBeGreaterThan(-1)
    let i = openAt
    let depth = 0
    let end = -1
    while (i < cardTsx.length) {
      if (cardTsx.startsWith('<span', i)) { depth += 1; i += 5; continue }
      if (cardTsx.startsWith('</span>', i)) {
        depth -= 1
        i += 7
        if (depth === 0) { end = i; break }
        continue
      }
      i += 1
    }
    expect(end, 'canvasRight 的闭合标签没找到（配平失败）').toBeGreaterThan(openAt)
    const block = cardTsx.slice(openAt, end)
    expect(block, '手柄又回到 canvasRight 里了 —— 会被 flex-wrap 挤到非右上角')
      .not.toContain('data-canvas-handle')
  })

  it('CSS 用绝对定位 + top/right，位置与内容多少无关', () => {
    const decl = declarationsOf('.canvasCard > .canvasHandle')
    expect(decl, '缺少 `.canvasCard > .canvasHandle` 规则').not.toHaveLength(0)
    expect(decl, '手柄必须绝对定位').toContain('position:absolute')
    expect(decl, '手柄必须贴右上（缺 top）').toContain('top:17px')
    expect(decl, '手柄必须贴右（缺 right）').toContain('right:16px')
    // 必须压过 `.canvasCard > *` 的 `position: relative`：那条是 (0,1,0)，
    // 带 `.canvasCard` 前缀的这条是 (0,2,0)，能覆盖。
    expect(cssCode, '`.canvasCard > *` 的 relative 会盖掉绝对定位').toMatch(/\.canvasCard > \* \{[^}]*position: relative/)
  })

  it('卡头给手柄留出了位置（否则长标题会跑到手柄底下）', () => {
    const head = declarationsOf('.canvasHead')
    expect(head, '卡头缺 padding-right，标题会压到手柄').toContain('padding-right:24px')
  })

  it('手柄始终可见（不靠 :hover 显形 —— 触摸屏点不到）', () => {
    const base = declarationsOf('.canvasHandle')
    expect(base, '手柄基础态必须是可见的').toContain('opacity:1')
    expect(cssCode, '手柄不许用 opacity 靠 hover 才显现').not.toMatch(/\.canvasHandle[^{]*\{[^}]*opacity:\s*0[;\s]/)
  })

  it('画布样式里不再留灰色占位卡（加载态改成文字说明）', () => {
    expect(cssCode).not.toMatch(/\.skelHost/)
    expect(cssCode).not.toMatch(/\.skelBlock/)
  })
})
