/**
 * 栅格基准（`layout-tokens.ts`）的派生函数判据 + 「总览不得回到自造 12 栅格」的防回潮。
 *
 * 历史：U13 把「12 栅格 + 10px 间距」当成全站基准，`overview.module.css` 曾用
 * `.ovGrid { repeat(12, …) }` + `.ovSpanN` 自造了一套栅格（与 Bootstrap 并存）。
 * Wave D3（2026-10-18）用户要求「和其他界面一致、用 Bootstrap 栅格」，总览改 `row g-2` / `col-*`，
 * 那套自造栅格已删除；本文件因此只保留 `layout-tokens.ts` 的**纯函数**判据（文档/基准仍在用），
 * 再加一条「overview 源里不得再出现 ovGrid/ovSpan」的判据，防止有人把旧版式加回来。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readText } from '../../../test-helpers/wiring-kit.ts'
import {
  CARD_BODY_GAP_PX,
  CARD_BODY_PAD_X,
  CARD_BODY_PAD_Y,
  CARD_HEAD_GAP_PX,
  CARD_HEAD_PAD_X,
  CARD_HEAD_PAD_Y,
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
  GRID_GAP_PX,
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
const OVERVIEW_CSS_RAW = readText(join(HERE, 'overview.module.css'))
/** 去掉注释：文件头会解释「旧版 ovGrid 怎么删的」，按原文扫会自伤。 */
const OVERVIEW_CSS = OVERVIEW_CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('layout-tokens 的派生函数', () => {
  it('gridTemplateLiteral / cardHeadPadding / cardBodyPadding 与真源字面量逐字一致', () => {
    expect(gridTemplateLiteral()).toBe('repeat(12, minmax(0, 1fr))')
    expect(cardHeadPadding()).toBe(`${CARD_HEAD_PAD_Y}px ${CARD_HEAD_PAD_X}px`)
    expect(cardBodyPadding()).toBe(`${CARD_BODY_PAD_Y}px ${CARD_BODY_PAD_X}px`)
    expect(cardBodyPadding(true)).toBe(`${COMPACT_CARD_BODY_PAD_Y}px ${COMPACT_CARD_BODY_PAD_X}px`)
  })

  it('分档取值：gridGap / panelGap 各回自己那一档', () => {
    expect(gridGap(false)).toBe(GRID_GAP_PX)
    expect(gridGap(true)).toBe(COMPACT_GRID_GAP_PX)
    expect(panelGap(false)).toBe(PANEL_GAP_PX)
    expect(panelGap(true)).toBe(COMPACT_PANEL_GAP_PX)
  })

  it('两档基准确实不同 —— 这正是当初被混淆的那一点，别顺手"统一"掉', () => {
    expect(GRID_GAP_PX, '宽档与紧档的栅格间距若变得相同，U13 的文档口径必须同步改写').not.toBe(COMPACT_GRID_GAP_PX)
    expect(PANEL_GAP_PX).not.toBe(COMPACT_PANEL_GAP_PX)
    expect(CARD_BODY_PAD_Y).not.toBe(COMPACT_CARD_BODY_PAD_Y)
    expect(cardBodyPadding()).not.toBe(cardBodyPadding(true))
    expect(CARD_HEAD_GAP_PX).not.toBe(COMPACT_CARD_HEAD_GAP_PX)
    expect(METRIC_MIN_COL_PX).not.toBe(COMPACT_METRIC_MIN_COL_PX)
    expect(METRIC_GAP_PX).not.toBe(COMPACT_METRIC_GAP_PX)
    expect(COMPACT_MEDIA_MAX_PX).toBeGreaterThan(0)
    expect(CARD_BODY_GAP_PX).toBeGreaterThan(0)
    expect(COMPACT_CARD_BODY_GAP_PX).toBeGreaterThan(0)
    expect(CARD_HEAD_PAD_X).toBeGreaterThan(0)
    expect(COMPACT_CARD_HEAD_PAD_X).toBeGreaterThan(0)
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

describe('总览不再自造 12 栅格（Wave D3 起交给 Bootstrap）', () => {
  it('overview.module.css 不得再出现 .ovGrid / .ovSpanN 规则', () => {
    expect(OVERVIEW_CSS, '旧的自造 12 栅格又回来了？总览现在用 Bootstrap row/col').not.toMatch(/\.ovGrid\b/)
    expect(OVERVIEW_CSS, '旧的自造跨列又回来了？总览现在用 Bootstrap row/col').not.toMatch(/\.ovSpan\d*\b/)
  })

  it('布局由 Bootstrap 类名承担：TSX 里必须有 row g-2 / col-*', () => {
    const tsx = readText(join(HERE, 'overview-panel.tsx')) + readText(join(HERE, 'overview-sections.tsx'))
    expect(tsx).toContain('row g-2')
    // 2026-10-19 微信化：KPI 8→4 后改为 4 列档（手机 2 列 / ≥sm 4 列），不再用 sm-4 的 3 列档
    expect(tsx).toMatch(/className="col-6 col-sm-3"/)
    expect(tsx).toMatch(/className="col-12 col-xl-\d+"/)
  })
})
