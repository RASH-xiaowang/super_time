/**
 * 记录表（Records）的虚拟化零件（W2-9.3）。
 *
 * 单独拆出来的理由不是「好看」：`RecordsPanel` 在函数体棘轮上（只能变小），
 * 而虚拟器 + 视口切片 + 两根撑杆有 ~45 行 —— 塞进组件必然顶破登记数字。
 * 搬成模块级之后组件只多三行，棘轮反而可能变小。
 *
 * @module panels/records-virtual
 */
import { useCallback } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { RecordItem } from './Records.tsx'

/** 一行固定 32px；Records 的 tr/td 明确使用同一高度，不依赖浏览器的动态测量。 */
export const RECORD_ROW_PX = 32

/**
 * Rows are deliberately fixed-height. Measuring table rows creates a native-layout
 * feedback loop here: measurement changes the tail spacer, which can change which
 * row is `:last-child`, and therefore changes the row's border height by ~1px.
 */
const estimateRecordRow = (): number => RECORD_ROW_PX

/** 视口里的一个行（含它在 `items` 里的**真实**下标）。 */
export interface VisibleRow {
  it: RecordItem
  i: number
}

/**
 * 记录表的行虚拟器。
 *
 * `getItemKey` 必须带 `keyPrefix`（= 分类名）：换分类等于换一张完全不同的表，
 * 行数也不同。只用下标当键的话，React 会把旧分类的行实体复用成新分类的行 ——
 * 表现是「切了页签，行内容闪一下才变」，key 撞车时 React 还会直接告警。
 *
 * @param count - 行数。
 * @param keyPrefix - 参与行键的分类名（换分类必须变）。
 * @param scrollRef - 滚动容器 ref（CSS 类是 `.tableScroll`）。
 * @returns 虚拟器。
 */
export function useRecordRowVirtualizer(
  count: number,
  keyPrefix: string,
  scrollRef: React.RefObject<HTMLDivElement | null>,
): Virtualizer<HTMLDivElement, Element> {
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef])
  const getItemKey = useCallback((i: number) => keyPrefix + '/' + String(i), [keyPrefix])
  return useVirtualizer({
    count,
    getScrollElement,
    estimateSize: estimateRecordRow,
    overscan: 8,
    getItemKey,
  })
}

/**
 * 取视口内的行。**过滤掉空行**：加载新页的瞬间 `items` 可能比虚拟器的 `count` 短一拍
 * （`count` 来自上一次渲染），不过滤就会往表格里塞 `undefined`。
 * @param virtualizer - 行虚拟器。
 * @param items - 全部已加载的行。
 * @returns 视口内的行与它们的真实下标。
 */
export function visibleRecordRows(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  items: readonly RecordItem[],
): VisibleRow[] {
  const out: VisibleRow[] = []
  for (const vi of virtualizer.getVirtualItems()) {
    const it = items[vi.index]
    if (it === undefined) continue
    out.push({ it, i: vi.index })
  }
  return out
}

/** 首尾两根撑杆的高度（px）。 */
export interface RecordPads {
  top: number
  bottom: number
}

/**
 * 算首尾撑杆该撑多少。
 *
 * 为什么必须是「空 tr 撑高度」而不是给行做绝对定位：`<table>` 的列宽是由**所有**行
 * 共同算出来的，行一旦脱离普通流，表头与行的列就会对不齐（破相），`sticky` 表头也会失效。
 * 撑杆是普通流里的空 tr，浏览器照常让它参与列宽计算。
 *
 * 高度取自 `getTotalSize()`，行高固定，因此滚动过程中不会出现测量与撑杆互相改写。
 * @param virtualizer - 行虚拟器。
 * @returns 上下撑杆高度。
 */
export function recordPads(virtualizer: Virtualizer<HTMLDivElement, Element>): RecordPads {
  const vis = virtualizer.getVirtualItems()
  if (vis.length === 0) return { top: 0, bottom: 0 }
  const last = vis[vis.length - 1]
  if (last === undefined) return { top: 0, bottom: 0 }
  return {
    top: vis[0]?.start ?? 0,
    bottom: Math.max(0, virtualizer.getTotalSize() - last.end),
  }
}
