/**
 * `kit.tsx` 的「数据表格（列定义 + 骨架/空态/行点击）」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kit-table
 */

import * as React from 'react'
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { EmptyState } from './kit-fields.tsx'
import tableCss from './kit-table.module.css'

/** 数据表格列定义（headless：渲染完全由面板提供）。 */
export interface DataColumn<T> {
  id: string
  header: React.ReactNode
  /** 渲染单元格（当前页行数据）。 */
  cell: (row: T) => React.ReactNode
  /** 本页内排序键（数据本身仍按后端顺序/分页返回）。 */
  sortValue?: (row: T) => string | number | undefined
  align?: 'left' | 'center' | 'right'
  className?: string
  /**
   * 列宽（px）。table-layout: fixed 下经 colgroup 兑现；**不传 = 弹性列**，
   * 与其余未指定列平分剩余宽度（clawbot B1：正文列靠它吃掉全部余量）。
   */
  width?: number
}

/**
 * 数据表格：TanStack Table 内核 + 现有 neon 主题样式。
 * 只对已加载页做客户端排序；分页/加载状态由面板的 usePagedList 控制。
 * @param columns - 列定义（header/cell/sortValue/align）。
 * @param rows - 当前页行数据。
 * @param getRowId - 稳定行 id。
 * @param loading - 显示骨架行。
 * @param emptyTitle - 空态标题。
 * @param onRowClick - 行点击回调（有值时整行可点）。
 * @param scroll - 本包装是否自建滚动（默认 true = 既有 62vh 行为；false = 调用方自当滚动容器）。
 * @param minWidth - 表格最小宽度 px（默认 640 = .table 的 CSS 值；0 = 不设下限）。
 * @returns 表格元素。
 */
export function DataTable<T>({ columns, rows, getRowId, loading = false, emptyTitle = '暂无数据', emptyDesc, onRowClick, skeletonRows = 8, scroll = true, minWidth = 640 }: {
  columns: readonly DataColumn<T>[]
  rows: readonly T[]
  getRowId: (row: T, index: number) => string
  loading?: boolean
  emptyTitle?: string
  emptyDesc?: string
  onRowClick?: (row: T) => void
  skeletonRows?: number
  /**
   * 本包装是否自建滚动（默认 true = 既有行为：.tableWrap 带 62vh 上限）。
   * 传 false = 调用方自己当唯一滚动容器（clawbot B0：面板内只准一个滚动容器，
   * 嵌套滚动会双滚动条 + 滚动手感断裂），包装退成静态。
   */
  scroll?: boolean
  /** 表格最小宽度（px，默认 640 = .table 的 CSS 值；传 0 = 不设下限）。 */
  minWidth?: number
}): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([])
  /** scroll=false 时包装不滚；minWidth 与 CSS 默认值不同时才写行内样式（其余面板零影响）。 */
  const wrapClass = scroll ? tableCss.tableWrap : tableCss.tableWrapStatic
  const tableStyle = minWidth !== 640 ? { minWidth: `${minWidth}px` } : undefined
  /** 有任一列显式宽度时才渲染 colgroup（table-layout: fixed 只认 col/首行，类名不兑现宽度）。 */
  const hasWidths = columns.some((c) => c.width !== undefined)
  const colDefs = useMemo<Array<ColumnDef<T>>>(
    () => columns.map((col): ColumnDef<T> => {
      const base: ColumnDef<T> = {
        id: col.id,
        header: () => col.header,
        cell: info => col.cell(info.row.original),
      }
      const sortValue = col.sortValue
      if (!sortValue) return base
      return {
        ...base,
        accessorFn: row => sortValue(row),
        sortingFn: (a, b) => {
          const av = sortValue(a.original)
          const bv = sortValue(b.original)
          if (av === undefined && bv === undefined) return 0
          if (av === undefined) return -1
          if (bv === undefined) return 1
          return String(av).localeCompare(String(bv), 'zh-Hans-CN', { numeric: true })
        },
      }
    }),
    [columns],
  )
  const table = useReactTable({
    data: rows as T[],
    columns: colDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row, index) => getRowId(row, index),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  if (loading && rows.length === 0) {
    return (
      <div className={wrapClass}>
        <table className={tableCss.table} style={tableStyle} aria-busy="true">
          {hasWidths && (
            <colgroup>
              {columns.map((col) => <col key={col.id} style={col.width !== undefined ? { width: `${col.width}px` } : undefined} />)}
            </colgroup>
          )}
          <thead>
            <tr>{columns.map(col => <th key={col.id}>{col.header}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>
                {columns.map(col => (
                  <td key={col.id}><span className={`nm-skel ${tableCss.skelTdLine}`} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} desc={emptyDesc} />
  }
  return (
    <div className={wrapClass}>
      <table className={tableCss.table} style={tableStyle}>
        {hasWidths && (
          <colgroup>
            {columns.map((col) => <col key={col.id} style={col.width !== undefined ? { width: `${col.width}px` } : undefined} />)}
          </colgroup>
        )}
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const col = columns.find(c => c.id === header.column.id)
                const sortable = Boolean(col?.sortValue)
                const dir = header.column.getIsSorted()
                const thStyle = col?.align === 'right' ? { textAlign: 'right' as const } : col?.align === 'center' ? { textAlign: 'center' as const } : undefined
                const inner = (
                  <span className={tableCss.thInner}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sortable && <span className={tableCss.thArrow}>{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span>}
                  </span>
                )
                return (
                  <th
                    key={header.id}
                    className={clsx(sortable && tableCss.thSortable, col?.className)}
                    data-sorted={dir || undefined}
                    // 排序状态用 aria-sort 表达；排序控件本身是下面的真 <button>，
                    // 所以键盘用户也能排序（原来只有 <th onClick>，鼠标专属）。
                    aria-sort={sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}
                    style={thStyle}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={tableCss.thBtn}
                        onClick={header.column.getToggleSortingHandler()}
                        title={typeof col?.header === 'string' ? `按「${col.header}」排序` : '排序'}
                      >
                        {inner}
                      </button>
                    ) : inner}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr
              key={row.id}
              className={clsx(onRowClick && tableCss.rowClickable)}
              onClick={onRowClick ? () => { onRowClick(row.original) } : undefined}
              // 整行可点时也必须能键盘触发：tr 不能包 button，所以给它 tabIndex + Enter/Space。
              // 注意保留 tr 的隐式 row 角色（不加 role="button"），以免破坏表格语义。
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row.original) }
              } : undefined}
            >
              {row.getVisibleCells().map((cell) => {
                const col = columns.find(c => c.id === cell.column.id)
                return (
                  <td key={cell.id} className={clsx(col?.className)} style={col?.align === 'right' ? { textAlign: 'right' } : col?.align === 'center' ? { textAlign: 'center' } : undefined}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
