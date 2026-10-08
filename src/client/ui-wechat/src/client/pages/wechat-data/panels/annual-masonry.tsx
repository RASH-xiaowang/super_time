/**
 * 年度看板容器（2026-09-30 定稿：**12 列网格 + dense 补空**，卡片宽度跟着内容走）。
 *
 * 演进过程（每一版都被用户当场否决，记下来免得再绕回去）：
 *   1. 12 列固定网格 + fr 行高（"一屏海报"）→ 用户要加内容，一屏装不下；
 *   2. CSS 多列（column-width）→ 按列顺序灌，末列常空一截、阅读顺序变竖读；
 *   3. JS 测高 + 最短列优先 → 测量不可靠时退化成"按索引轮流放"，左下一大片空白；
 *   4. 多列平衡（column-fill: balance）→ 列底齐平了，但**卡片等宽**，用户要"自适应卡片宽度"。
 *
 * 现在：`display: grid` + 12 列 + `grid-auto-flow: dense`。
 *   · 卡片宽度由自己的 `grid-column: span N` 决定 —— 热力图/词云这类宽内容占 6 列，
 *     普通数据卡占 4 列（1/3），窄卡占 3 列；海报卡沿用它们原来自带的 span（3/4/6/8/12）。
 *   · `dense` 让小卡回头补进大卡留下的空隙，减少成片空白。
 *   · 零 JS 测量：宽度是**声明式**的（由卡片类型决定），不依赖运行时量高，不会像第 3 版那样翻车。
 */
import type { ReactNode } from 'react'
import css from './annual.module.css'

export interface MasonryGridProps {
  /** 卡片（按源顺序摆放，dense 会自动补空）。 */
  children: ReactNode
}

/**
 * 渲染看板网格。
 * @param props - 卡片。
 * @returns 网格元素。
 */
export function MasonryGrid({ children }: MasonryGridProps): React.JSX.Element {
  return <div className={css.board}>{children}</div>
}
