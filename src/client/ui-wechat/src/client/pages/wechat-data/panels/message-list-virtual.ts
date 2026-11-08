/**
 * 消息列表专用行虚拟化。
 *
 * 数据窗口已经由 `message-list-view.ts` 限制在 2,000 条；这里再把真正挂到
 * `<tbody>` 的行限制在视口附近。两道上界分开，避免以后调整分页时误把 DOM
 * 也放开。
 */
import { useCallback } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { MESSAGE_LIST_SSR_ROWS } from './message-list-view.ts'

/** 与消息记录行的 28px 控件 + 单元格上下 padding 对齐；真实高度仍由 measureElement 回灌。 */
export const MESSAGE_LIST_ROW_PX = 32
export const MESSAGE_LIST_ROW_OVERSCAN = 8
/** 即使视口异常大，单次最多挂载这么多真实数据行。 */
export const MESSAGE_LIST_DOM_MAX = 120

export interface MessageListVirtualSnapshot {
  getVirtualItems: () => ReadonlyArray<{
    index: number
    start: number
    end: number
    size: number
  }>
  getTotalSize: () => number
}

export interface VisibleMessageListRow {
  record: MessageListRecord
  index: number
  start: number
  end: number
}

export interface MessageListRowPads {
  top: number
  bottom: number
}

export interface MessageListRenderRows {
  rows: VisibleMessageListRow[]
  pads: MessageListRowPads
  virtualized: boolean
}

export function useMessageListRowVirtualizer(
  records: readonly MessageListRecord[],
  scrollRef: React.RefObject<HTMLDivElement | null>,
): Virtualizer<HTMLDivElement, Element> {
  const getItemKey = useCallback(
    (index: number): number => records[index]?.id ?? index,
    [records],
  )
  return useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => MESSAGE_LIST_ROW_PX,
    overscan: MESSAGE_LIST_ROW_OVERSCAN,
    getItemKey,
  })
}

/** 过滤虚拟器短暂领先于 records 的空下标，并给 DOM 再上一道硬上限。 */
export function visibleMessageListRows(
  virtualizer: MessageListVirtualSnapshot,
  records: readonly MessageListRecord[],
): VisibleMessageListRow[] {
  const out: VisibleMessageListRow[] = []
  for (const item of virtualizer.getVirtualItems()) {
    const record = records[item.index]
    if (record === undefined) continue
    out.push({
      record,
      index: item.index,
      start: item.start,
      end: item.end,
    })
    if (out.length >= MESSAGE_LIST_DOM_MAX) break
  }
  return out
}

export function messageListRowPads(
  virtualizer: MessageListVirtualSnapshot,
  rows: readonly VisibleMessageListRow[],
): MessageListRowPads {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first === undefined || last === undefined) return { top: 0, bottom: 0 }
  return {
    top: Math.max(0, first.start),
    bottom: Math.max(0, virtualizer.getTotalSize() - last.end),
  }
}

/** SSR/首帧没有滚动尺寸时只渲染固定首段，客户端接管后再按视口切片。 */
export function messageListRowsForRender(
  virtualizer: MessageListVirtualSnapshot,
  records: readonly MessageListRecord[],
  ssrRows = MESSAGE_LIST_SSR_ROWS,
): MessageListRenderRows {
  const rows = visibleMessageListRows(virtualizer, records)
  if (rows.length > 0) {
    return {
      rows,
      pads: messageListRowPads(virtualizer, rows),
      virtualized: true,
    }
  }
  const fallback = records.slice(0, Math.max(0, Math.min(ssrRows, MESSAGE_LIST_DOM_MAX)))
  return {
    rows: fallback.map((record, index) => ({
      record,
      index,
      start: index * MESSAGE_LIST_ROW_PX,
      end: (index + 1) * MESSAGE_LIST_ROW_PX,
    })),
    pads: { top: 0, bottom: 0 },
    virtualized: false,
  }
}
