/**
 * 栅格基准（`layout-tokens.ts`）与真源（`overview.module.css`）的**双向核对**。
 *
 * 这份用例存在的理由，是一个具体的事故：U13 的口径「12 栅格 + 10px 间距」被当成全站基准传了一阵，
 * 而真源里 12px 与 10px **分属两个媒体查询档**（宽档 gap 12px / `@media (max-width: 1100px)` 紧档 gap 10px）。
 * 照着那句口径改宽屏面板，间距就会错一档 —— 而且没有任何检查会红。
 *
 * 所以这里：
 *   · 把两份**分档**读出来（按 `@media (max-width: …)` 切），任一档漂移都红；
 *   · 断言两档**确实不同**（这正是当初被混淆的那一点，谁想"顺手统一"就得先来改这条）；
 *   · 反向核对跨列档位，防孤儿档（CSS 里有 `span 11` 而基准没登记）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allClassBlocks, classBlock, readText } from '../../../test-helpers/wiring-kit.ts'
import {
  CARD_BODY_GAP_PX,
  CARD_BODY_PAD_X,
  CARD_BODY_PAD_Y,
  CARD_HEAD_GAP_PX,
  CARD_HEAD_PAD_X,
  CARD_HEAD_PAD_Y,
  CARD_RADIUS_TOKEN,
  COMPACT_CARD_BODY_GAP_PX,
  COMPACT_CARD_BODY_PAD_X,
  COMPACT_CARD_BODY_PAD_Y,
  COMPACT_CARD_HEAD_GAP_PX,
  COMPACT_CARD_HEAD_PAD_X,
  COMPACT_CARD_HEAD_PAD_Y,
  COMPACT_GRID_GAP_PX,
  COMPACT_MEDIA_MAX_PX,
  COMPACT_METRIC_GAP_PX,
  COMPACT_METRIC_MIN_COL_PX,
  COMPACT_PANEL_GAP_PX,
  GRID_COLUMNS,
  GRID_GAP_PX,
  GRID_SPAN_STEPS,
  METRIC_GAP_PX,
  METRIC_MIN_COL_PX,
  PANEL_GAP_PX,
  cardBodyPadding,
  cardHeadPadding,
  countGridTracks,
  gridGap,
  gridTemplateLiteral,
  panelGap,
} from './layout-tokens.ts'

const HERE = import.meta.dirname
const CSS = readText(join(HERE, 'overview.module.css'))

// 按紧档的媒体查询把这支样式表切成两半：前半是宽档（基准），后半是紧档。
const MEDIA = `@media (max-width: ${COMPACT_MEDIA_MAX_PX}px)`
const mediaAt = CSS.indexOf(MEDIA)
const WIDE = CSS.slice(0, mediaAt)
const COMPACT = CSS.slice(mediaAt)

describe('栅格基准 · 与 overview.module.css 分档核对', () => {
  it('切档锚点存在（找不到就说明媒体查询改了写法，本文件必须同步）', () => {
    expect(mediaAt, `找不到「${MEDIA}」`).toBeGreaterThan(-1)
  })

  it('宽档：12 栅格 + 间距/内边距与基准一致', () => {
    expect(classBlock(WIDE, 'ovGrid')).toContain(gridTemplateLiteral())
    expect(classBlock(WIDE, 'ovGrid')).toContain(`gap: ${GRID_GAP_PX}px`)
    expect(classBlock(WIDE, 'root')).toContain(`gap: ${PANEL_GAP_PX}px`)
    expect(classBlock(WIDE, 'ovCardHd')).toContain(`padding: ${cardHeadPadding()}`)
    expect(classBlock(WIDE, 'ovCardHd')).toContain(`gap: ${CARD_HEAD_GAP_PX}px`)
    expect(classBlock(WIDE, 'ovCardBd')).toContain(`padding: ${cardBodyPadding()}`)
    expect(classBlock(WIDE, 'ovCardBd')).toContain(`gap: ${CARD_BODY_GAP_PX}px`)
    // `.ovCard` 在本文件里被声明多次（前两条在媒体查询里只写 flex），所以只断言"某一处带上了圆角令牌"。
    const cardRules = allClassBlocks(WIDE, 'ovCard')
    expect(cardRules.length, '找不到任何 .ovCard 规则').toBeGreaterThan(0)
    expect(
      cardRules.some((r) => r.includes(`border-radius: ${CARD_RADIUS_TOKEN}`)),
      '卡片的圆角令牌没在任何一个 .ovCard 规则里出现',
    ).toBe(true)
  })

  it('宽档：指标格的自适应下限与间距与基准一致', () => {
    const grid = classBlock(WIDE, 'metricGrid')
    expect(grid).toContain(`minmax(${METRIC_MIN_COL_PX}px, 1fr)`)
    expect(grid).toContain(`gap: ${METRIC_GAP_PX}px`)
  })

  it('紧档：12 栅格仍是 12 列，但间距与内边距整体收紧且与基准一致', () => {
    expect(classBlock(COMPACT, 'root')).toContain(`gap: ${COMPACT_PANEL_GAP_PX}px`)
    expect(classBlock(COMPACT, 'ovGrid')).toContain(`gap: ${COMPACT_GRID_GAP_PX}px`)
    expect(classBlock(COMPACT, 'ovCardHd')).toContain(`padding: ${cardHeadPadding(true)}`)
    expect(classBlock(COMPACT, 'ovCardHd')).toContain(`gap: ${COMPACT_CARD_HEAD_GAP_PX}px`)
    expect(classBlock(COMPACT, 'ovCardBd')).toContain(`padding: ${cardBodyPadding(true)}`)
    expect(classBlock(COMPACT, 'ovCardBd')).toContain(`gap: ${COMPACT_CARD_BODY_GAP_PX}px`)
    const grid = classBlock(COMPACT, 'metricGrid')
    expect(grid).toContain(`minmax(${COMPACT_METRIC_MIN_COL_PX}px, 1fr)`)
    expect(grid).toContain(`gap: ${COMPACT_METRIC_GAP_PX}px`)
  })

  it('紧档**只**收间距，不改列数（把列数也改了就是另一套栅格了）', () => {
    expect(classBlock(COMPACT, 'ovGrid'), '紧档不该重声明列模板').not.toContain('grid-template-columns')
  })

  it('两档的间距确实不同 —— 这正是当初被混淆的那一点，别顺手"统一"掉', () => {
    expect(GRID_GAP_PX, '宽档与紧档的栅格间距若变得相同，U13 的文档口径必须同步改写').not.toBe(COMPACT_GRID_GAP_PX)
    expect(PANEL_GAP_PX).not.toBe(COMPACT_PANEL_GAP_PX)
    expect(CARD_BODY_PAD_Y).not.toBe(COMPACT_CARD_BODY_PAD_Y)
    expect(cardBodyPadding(), '两档的 CSS 简写也应当不同').not.toBe(cardBodyPadding(true))
  })

  it('跨列档位双向核对：CSS 里出现的 span N 全在基准里，基准里每一项也有对应的类', () => {
    const inCss = [...CSS.matchAll(/^\.ovSpan(\d+)\s*\{/gm)].map((m) => Number(m[1]))
    expect(inCss.length, '没解析出任何 .ovSpanN —— 类名改了就要同步本用例').toBeGreaterThanOrEqual(5)
    const orphan = inCss.filter((n) => !GRID_SPAN_STEPS.includes(n))
    expect(orphan, '这些跨列档位没登记进 GRID_SPAN_STEPS').toEqual([])
    const declared = GRID_SPAN_STEPS.filter((n) => !inCss.includes(n))
    expect(declared, '基准里登记了但 CSS 里没有对应类的档位').toEqual([])
    const over = inCss.filter((n) => n > GRID_COLUMNS)
    expect(over, '跨列数不可能超过总列数').toEqual([])
  })
})

describe('layout-tokens 的派生函数', () => {
  it('gridTemplateLiteral / cardHeadPadding / cardBodyPadding 与真源字面量逐字一致', () => {
    expect(gridTemplateLiteral()).toBe('repeat(12, minmax(0, 1fr))')
    expect(cardHeadPadding()).toBe(`${CARD_HEAD_PAD_Y}px ${CARD_HEAD_PAD_X}px`)
    expect(cardBodyPadding()).toBe(`${CARD_BODY_PAD_Y}px ${CARD_BODY_PAD_X}px`)
  })

  it('分档取值：gridGap / panelGap 各回自己那一档', () => {
    expect(gridGap(false)).toBe(GRID_GAP_PX)
    expect(gridGap(true)).toBe(COMPACT_GRID_GAP_PX)
    expect(panelGap(false)).toBe(PANEL_GAP_PX)
    expect(panelGap(true)).toBe(COMPACT_PANEL_GAP_PX)
  })

  it('countGridTracks：浏览器展开后的像素串、未展开的 repeat()、以及 none 都要数对', () => {
    expect(countGridTracks('123.5px 123.5px 123.5px')).toBe(3)
    expect(countGridTracks('repeat(12, minmax(0, 1fr))')).toBe(12)
    expect(countGridTracks('120px 1fr 2fr 3fr')).toBe(4)
    expect(countGridTracks('none')).toBe(0)
    expect(countGridTracks('')).toBe(0)
    expect(countGridTracks('   ')).toBe(0)
  })
})
