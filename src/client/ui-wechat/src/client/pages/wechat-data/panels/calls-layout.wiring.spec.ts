
/**
 * 通话记录面板的**布局契约**（2026-09-26 重新设计）。
 *
 * 起因：用户报「留白过多」。实测根因是 `kit.cardGrid` 是**等宽两列**、行高取两块的最大值，
 * 而「最近通话」有 60 条（约 1800px）、它左边只有「未接通原因」6 行（约 260px）——
 * 于是左下半张卡片全是行剩余空间。整页内容高约 2700px 且全靠页面滚动。
 *
 * 本次三条要求与对应契约：
 *  ① **精简条目数**：`topPeers: 12` / `recentLimit: 30`；
 *  ② **单页面滚动（2026-10-19 修订，用户要求「合理使用滚动条」）**：三个列表不再各自
 *     限高 + 内滚，长内容统一交给 `.panelBody` 的页面级滚动 —— 一屏只留一条滚动条；
 *  ③ **窄档不裁切**：桌面档解除卡片高度预算（compact-chrome），390 档仍由页面/卡身滚动兜底；
 *  ④ **长列表独占一行**：`最近通话` 不许再与矮卡片配对（那是留白的直接来源）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, classBlock, readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const TSX = readStripped(join(HERE, 'Calls.tsx'))
const CSS = readText(join(HERE, 'calls.module.css'))

/** 必须限高 + 内层滚动的三个列表。 */
const SCROLL_LISTS = ['rankList', 'monthList', 'recentList'] as const

describe('① 精简条目数', () => {
  it('排行取 12、最近通话取 30（原先 20 / 60，页面被撑到约 2700px）', () => {
    expect(TSX, '取数上限没改回大值').toMatch(/apiGetCalls\(\{ topPeers: 12, recentLimit: 30 \}\)/)
    expect(TSX.includes('topPeers: 20'), '排行不该再取 20 条').toBe(false)
    expect(TSX.includes('recentLimit: 60'), '最近通话不该再取 60 条').toBe(false)
  })
})

describe('②③ 单页面滚动：列表不再各自限高/嵌套滚动', () => {
  for (const name of SCROLL_LISTS) {
    it(`.${name} 不再写 max-height / overflow-y: auto`, () => {
      const block = classBlock(CSS, name)
      expect(block, `.${name} 又出现 max-height —— 页面会变成「页面滚 + 卡内滚」两层`).not.toMatch(/max-height:/)
      expect(block, `.${name} 又出现内层滚动`).not.toMatch(/overflow-y:\s*auto/)
    })
  }

  it('滚动条统一由全局 ui-app/scrollbars.css 提供（可见细条 + 窄档隐藏）', () => {
    const bar = readText(join(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'scrollbars.css'))
    expect(bar, '全局滚动条宽度必须显式声明（8px 细条）').toContain('width: 8px;')
    expect(bar, '拇指必须用正文次级色 mix（跟随深浅主题）').toContain('color-mix(in srgb, var(--nm-text-2')
    expect(bar, '窄档（≤560）隐藏触摸屏滚动条').toContain('@media (max-width: 560px)')
    expect(CSS, 'calls 列表还留着旧的独立滚动条声明（死 CSS）').not.toContain('.rankList::-webkit-scrollbar')
  })

  it('防空转：真的读到了三个文件', () => {
    atLeast(TSX.length, 6000, 'Calls.tsx 源码')
    atLeast(CSS.length, 6000, 'calls.module.css 源码')
    atLeast(readText(join(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'scrollbars.css')).length, 800, 'scrollbars.css 源码')
  })
})

describe('④ 最近通话独占一行（不与矮卡片配对）', () => {
  it('它不在 cardGrid 里 —— 长列表与矮卡片同行的行剩余空间正是留白的来源', () => {
    const at = TSX.indexOf('<Card title="最近通话"')
    expect(at, '找不到「最近通话」卡片').toBeGreaterThan(-1)
    const before = TSX.slice(0, at)
    expect(before.lastIndexOf('</div>'), '最近通话必须独占一行（不在两列网格里）')
      .toBeGreaterThan(before.lastIndexOf('<div className={kitCss.cardGrid}>'))
    // 上面的相对位置判据读起来最清楚，但它没法用字符串替换来制造失败（要移动代码）。
    // 所以再钉一条**精确锚点**：最近通话紧跟在网格闭合之后、且回到顶层缩进 ——
    // 这条既是同一件事的另一种说法，也是变异测试真正能咬住的那一条。
    expect(TSX, '最近通话必须紧跟网格闭合、且回到顶层缩进')
      .toContain('</div>\n\n          <Card title="最近通话"')
  })

  it('「通话对象排行」与「未接通原因」配对（两块都短，行高不浪费）', () => {
    const rankAt = TSX.indexOf('title="通话对象排行"')
    const reasonAt = TSX.indexOf('title="未接通原因"')
    expect(rankAt, '找不到排行卡片').toBeGreaterThan(-1)
    expect(reasonAt, '找不到未接通原因卡片').toBeGreaterThan(-1)
    // 两块同属一个网格 ⇔ 它们之间没有跨出网格边界：
    // 用一个简单而可靠的判据 —— 这段里 `<div` 与 `</div>` 必须**配平**
    // （排行卡内部自己有 div，所以不能靠「有没有 </div>」来判断）。
    const seg = TSX.slice(rankAt, reasonAt)
    const opens = (seg.match(/<div\b/g) ?? []).length
    const closes = (seg.match(/<\/div>/g) ?? []).length
    expect(opens, '排行与未接通原因之间的 div 不配平 —— 说明它们被网格边界隔开了').toBe(closes)
    // 而且这个网格确实存在（排行之前最近的开标签是 cardGrid）
    const before = TSX.slice(0, rankAt)
    expect(before.lastIndexOf('</div>'), '排行必须在网格内')
      .toBeLessThan(before.lastIndexOf('<div className={kitCss.cardGrid}>'))
  })

  it('三处空态文案仍在（重排不该弄丢空态）', () => {
    for (const s of ['暂无通话对象', '全部接通', '暂无记录']) {
      expect(TSX, `空态文案丢了：${s}`).toContain(s)
    }
  })
})
