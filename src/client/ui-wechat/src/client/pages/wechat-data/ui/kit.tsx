/**
 * 本地微信数据管理 · UI Kit
 *
 * 面板重构的共享组件层：设计令牌来自 scifi-theme.css 的 --nm-* 变量，交互
 * 原语基于 Radix（Dialog/Tabs/ToggleGroup/Tooltip/Select），表格内核基于
 * TanStack Table，长列表虚拟化基于 @tanstack/react-virtual。所有组件均只
 * 负责外观与交互，不包含任何业务数据逻辑；现有面板的懒加载/实时行为不变。
 */
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as SelectPrimitive from '@radix-ui/react-select'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import css from './kit.module.css'

/**
 * 统一按钮入口。
 *
 * 实现唯一放在 `ui-primitives-shim/Button.tsx`（不在此处再造一个 Button，
 * 否则又会变成两套）。从这里再导出，是为了让面板只认一个 import 面：
 * 需要按钮时 `import { Button } from '../ui/kit.tsx'`。
 *
 * 迁移背景：面板里仍有 271 个裸 `<button>`，配套的自定义类至少有
 * `.catBtn`(9 个文件) / `.tabBtn`(6) / `.linkBtn`(6) / `.statChip`(6) / `.miniBtn`(3) …，
 * 禁用态出现过 0.4/0.45/0.5/0.55/0.6 五种透明度，且几乎都没有 :focus-visible。
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives'
export type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 让非 `<button>` 的可点击元素具备按钮的键盘语义。
 *
 * 背景：面板里有 9 处 `role="button"` 的可点击 div（列表行 / 图片 / 折叠标题 /
 * 月历柱），此前只有 Chats 的文件卡带 `tabIndex` 与 `onKeyDown` —— 其余 8 处
 * 键盘用户既**无法聚焦**，也无法用 Enter/Space 激活。加了 `role` 却不给键盘
 * 通路，等于只对读屏软件"声称"是按钮。
 *
 * 用法：`<div {...clickableKey(() => open())} className={...} />`
 *
 * 取舍：语义上直接改用 `<button>` 更好，但这些元素各自带着布局样式
 * （`display:flex`、绝对定位、网格项等），换成 button 需要逐个重置 UA 样式，
 * 风险高于收益；这里先补齐键盘通路。
 *
 * @param onActivate - 点击或按 Enter / 空格时执行。
 * @param opts.stopPropagation - 阻止冒泡。元素嵌在**另一个可点击容器**里时必须开启
 *   （例如朋友圈卡片里的昵称：点昵称只应「按作者筛选」，不该连带打开详情）。
 * @param opts.role - 覆盖默认的 `'button'`。链接卡片用 `'link'`；
 *   批量选择态的卡片用 `'checkbox'`（配合 `aria-checked`）。
 * @param opts.label - `aria-label`，供没有可见文本的元素（图片、图标按钮）使用。
 * @returns 可直接展开到元素上的 role / tabIndex / onClick / onKeyDown。
 */
export function clickableKey(onActivate: () => void, opts?: {
  stopPropagation?: boolean
  role?: React.AriaRole
  label?: string
}): {
  role: React.AriaRole
  tabIndex: number
  'aria-label'?: string
  onClick: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
} {
  const stop = opts?.stopPropagation === true
  return {
    role: opts?.role ?? 'button',
    tabIndex: 0,
    'aria-label': opts?.label,
    onClick: (e) => { if (stop) e.stopPropagation(); onActivate() },
    onKeyDown: (e) => {
      // 空格要 preventDefault，否则会同时滚动页面。
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        if (stop) e.stopPropagation()
        onActivate()
      }
    },
  }
}

type Tone = 'default' | 'cyan' | 'green' | 'red' | 'amber' | 'purple' | 'blue'

/** 面板标题区：标题 + 描述 + 右侧操作按钮组。 */
export function PanelHeader({ title, desc, actions }: {
  title: React.ReactNode
  desc?: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={css.panelHeader}>
      <div className={css.panelTitleWrap}>
        <h2 className={css.panelTitle}>{title}</h2>
        {desc && <p className={css.panelDesc}>{desc}</p>}
      </div>
      {actions && <div className={css.panelActions}>{actions}</div>}
    </div>
  )
}

/** 工具栏：左侧筛选/搜索，右侧操作。 */
export function Toolbar({ left, right }: {
  left?: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={css.toolbar}>
      <div className={css.toolbarLeft}>{left}</div>
      {right && <div className={css.toolbarRight}>{right}</div>}
    </div>
  )
}

/**
 * 带清除按钮的搜索输入（受控值，由面板自行防抖/触发查询）。
 *
 * `className` 用于让调用方接管宽度策略：kit 默认是工具栏里那种
 * `flex: 0 1 320px; min-width: 220px`（在宽工具栏里正合适），
 * 但塞进 302px 的会话左栏时，220px 的下限会把同行按钮顶出列外
 * （实测「批量」按钮整颗落在 x 382..428，越出左栏 46px）。
 * 传 `flex: 1; min-width: 0` 就让它随行宽收缩。
 */
export function SearchInput({ value, onChange, placeholder = '搜索…', ariaLabel, onEnter, className }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  onEnter?: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={clsx(css.searchBox, className)}>
      <span className={css.searchIcon}>🔍</span>
      <input
        className={css.searchInput}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => { onChange(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.()
          /*
           * Esc 清空搜索（第 70 轮）。9 个面板共用这个输入框，之前只有：
           * 输入非空时右侧出现「×」按钮可点 —— 键盘用户要清空得先点进去再点按钮，或多按几次退格。
           * Esc 是搜索框的通用约定，这里补上；只在**有内容**时处理，避免与「Esc 关弹窗」抢事件
           * （弹窗打开时焦点在弹窗里，输入框本来就拿不到这个按键；再加一道 role=dialog 的保险）。
           */
          else if (e.key === 'Escape' && value !== '' && !document.querySelector('[role="dialog"]')) {
            e.preventDefault()
            onChange('')
          }
        }}
      />
      {value !== '' && (
        <button type="button" className={css.searchClear} aria-label="清除搜索" onClick={() => { onChange('') }}>×</button>
      )}
    </div>
  )
}

/** 玻璃拟态卡片：可选标题栏/操作区/页脚。 */
export function Card({ title, extra, footer, children, flush = false, className }: {
  title?: React.ReactNode
  extra?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  flush?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <section className={clsx(css.card, className)}>
      {(title || extra) && (
        <div className={css.cardHd}>
          {title && <div className={css.cardTitle}>{title}</div>}
          {extra && <div className={css.cardExtra}>{extra}</div>}
        </div>
      )}
      <div className={flush ? css.cardBdFlush : css.cardBd}>{children}</div>
      {footer && <div className={css.cardFt}>{footer}</div>}
    </section>
  )
}

/** 统计卡片：图标 + 数值 + 标签 + 备注，语义色强调；可选整卡可点。 */
export function StatCard({ icon, value, label, hint, tone = 'cyan', onClick, title }: {
  icon: React.ReactNode
  value: React.ReactNode
  label: React.ReactNode
  hint?: React.ReactNode
  tone?: Tone
  onClick?: () => void
  title?: string
}): React.JSX.Element {
  if (onClick) {
    return (
      <button type="button" className={clsx(css.statCard, css.statCardButton)} data-tone={tone} title={title} onClick={() => { onClick() }}>
        <span className={css.statIcon}>{icon}</span>
        <span className={css.statValue}>{value}</span>
        <span className={css.statLabel}>{label}</span>
        {hint && <span className={css.statHint}>{hint}</span>}
      </button>
    )
  }
  return (
    <div className={css.statCard} data-tone={tone}>
      <div className={css.statIcon}>{icon}</div>
      <div className={css.statValue}>{value}</div>
      <div className={css.statLabel}>{label}</div>
      {hint && <div className={css.statHint}>{hint}</div>}
    </div>
  )
}

/** 统计卡片栅格容器。 */
export function StatGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className={css.statGrid}>{children}</div>
}

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
 * @returns 表格元素。
 */
export function DataTable<T>({ columns, rows, getRowId, loading = false, emptyTitle = '暂无数据', emptyDesc, onRowClick, skeletonRows = 8 }: {
  columns: readonly DataColumn<T>[]
  rows: readonly T[]
  getRowId: (row: T, index: number) => string
  loading?: boolean
  emptyTitle?: string
  emptyDesc?: string
  onRowClick?: (row: T) => void
  skeletonRows?: number
}): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([])
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
      <div className={css.tableWrap}>
        <table className={css.table} aria-busy="true">
          <thead>
            <tr>{columns.map(col => <th key={col.id}>{col.header}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>
                {columns.map(col => (
                  <td key={col.id}><span className={`nm-skel ${css.skelTdLine}`} /></td>
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
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const col = columns.find(c => c.id === header.column.id)
                const sortable = Boolean(col?.sortValue)
                const dir = header.column.getIsSorted()
                const thStyle = col?.align === 'right' ? { textAlign: 'right' as const } : col?.align === 'center' ? { textAlign: 'center' as const } : undefined
                const inner = (
                  <span className={css.thInner}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sortable && <span className={css.thArrow}>{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span>}
                  </span>
                )
                return (
                  <th
                    key={header.id}
                    className={clsx(sortable && css.thSortable, col?.className)}
                    data-sorted={dir || undefined}
                    // 排序状态用 aria-sort 表达；排序控件本身是下面的真 <button>，
                    // 所以键盘用户也能排序（原来只有 <th onClick>，鼠标专属）。
                    aria-sort={sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}
                    style={thStyle}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={css.thBtn}
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
              className={clsx(onRowClick && css.rowClickable)}
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

/**
 * 虚拟滚动列表（@tanstack/react-virtual）：仅渲染可视区行。
 * @param items - 全量数据。
 * @param getKey - 稳定行 key。
 * @param rowHeight - 固定行高（像素）。
 * @param renderRow - 行渲染函数。
 * @param onEndReached - 滚动接近末尾时回调（用于加载更多）。
 * @param className - 滚动容器附加类（需给定高度）。
 * @returns 虚拟列表元素。
 */
export function VirtualList<T>({ items, getKey, rowHeight, renderRow, onEndReached, overscan = 8, className }: {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  rowHeight: number
  renderRow: (item: T, index: number) => React.ReactNode
  onEndReached?: () => void
  overscan?: number
  className?: string
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const endReachedRef = useRef(onEndReached)
  endReachedRef.current = onEndReached
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })
  const lastIndex = virtualizer.getVirtualItems().at(-1)?.index ?? -1
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= items.length - 5) endReachedRef.current?.()
  }, [lastIndex, items.length])
  return (
    <div ref={parentRef} className={clsx(css.vlist, className)}>
      <div className={css.vlistInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index]
          if (item === undefined) return null
          return (
            <div
              key={getKey(item, vi.index)}
              className={css.vlistRow}
              style={{ transform: `translateY(${vi.start}px)`, height: rowHeight }}
            >
              {renderRow(item, vi.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 胶囊标签页（Radix Tabs 样式化）。 */
export function Tabs({ tabs, value, onChange, children }: {
  tabs: ReadonlyArray<{ value: string; label: React.ReactNode }>
  value: string
  onChange: (value: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <TabsPrimitive.Root className={css.tabs} value={value} onValueChange={onChange}>
      <TabsPrimitive.List className={css.tabList}>
        {tabs.map(t => (
          <TabsPrimitive.Trigger key={t.value} className={css.tabTrigger} value={t.value}>
            {t.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  )
}

/** 分段选择器（Radix ToggleGroup 样式化，单选）。 */
export function Segmented({ options, value, onChange, ariaLabel }: {
  options: ReadonlyArray<{ value: string; label: React.ReactNode }>
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <ToggleGroup.Root
      className={css.seg}
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v) => { if (v) onChange(v) }}
    >
      {options.map(o => (
        <ToggleGroup.Item key={o.value} className={css.segItem} value={o.value}>
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

/** 右侧抽屉（Radix Dialog）：详情/筛选面板统一入口。 */
export function Drawer({ open, onClose, title, children, footer, width }: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={css.drawerOverlay} />
        <DialogPrimitive.Content className={css.drawer} style={width ? { width: Math.min(width, 560) } : undefined}>
          <div className={css.drawerHd}>
            <DialogPrimitive.Title className={css.drawerTitle}>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className={css.drawerClose} aria-label="关闭">×</DialogPrimitive.Close>
          </div>
          <div className={css.drawerBd}>{children}</div>
          {footer && <div className={css.drawerFt}>{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** 居中对话框（Radix Dialog）：确认/表单类弹窗。 */
export function Dialog({ open, onClose, title, children, footer, className }: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={css.dialogOverlay} />
        <DialogPrimitive.Content className={clsx(css.dialog, className)}>
          {title && (
            <div className={css.drawerHd}>
              <DialogPrimitive.Title className={css.drawerTitle}>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close className={css.drawerClose} aria-label="关闭">×</DialogPrimitive.Close>
            </div>
          )}
          <div className={css.dialogBd}>{children}</div>
          {footer && <div className={css.drawerFt}>{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/**
 * 手写覆盖层的 Escape 关闭栈。
 *
 * 为什么需要：kit 的 `Drawer`/`Dialog` 走 Radix，Esc 是白送的；但面板里还有一批
 * **手写**的 `role="dialog"` 覆盖层（导出弹窗、聊天记录查看器、日历、已编辑消息、
 * 文件灯箱、任务表单…），它们只支持点遮罩关闭。WAI-ARIA 的 dialog 模式要求 Esc 可关闭，
 * 键盘用户会在这些弹窗里被困住。
 *
 * 用**栈**而不是各自监听：聊天记录查看器支持嵌套打开，若每个覆盖层都监听 Esc，
 * 一次按键会把整摞弹窗全部关掉。只让最后打开的那层响应。
 */
const escStack: Array<() => void> = []

/**
 * 让一个覆盖层支持 Escape 关闭。
 * @param open - 覆盖层是否打开。
 * @param onClose - 关闭回调（身份可变，内部用 ref 持有）。
 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose })
  useEffect(() => {
    if (!open) return
    const entry = (): void => { ref.current() }
    escStack.push(entry)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (escStack[escStack.length - 1] !== entry) return   // 只让最上层响应
      e.stopPropagation()
      ref.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      const i = escStack.indexOf(entry)
      if (i >= 0) escStack.splice(i, 1)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
}

/**
 * 手写弹窗的**焦点管理**：进入时把焦点移进弹窗、Tab 在弹窗内循环、关闭后焦点还原。
 *
 * 为什么需要（第 57 轮实测）：文件灯箱打开后 `document.activeElement` 仍是窗口的
 * 「最小化」按钮（焦点根本没进来），按 3 次 Tab 之后焦点跑到了背景页的
 * 「切换到浅色主题」按钮上 —— 键盘用户可以操作**弹窗背后的界面**，而弹窗里的 5 个按钮
 * 一个都到不了。Radix 的 Dialog 自带这套行为，手写的没有。
 *
 * 用选择器而不是 ref：手写弹窗分散在 4 个面板、共 8 处，逐个建 ref 只会让 diff 变长；
 * 给容器加 `data-st-dialog="<名字>"` 属性即可（效果在渲染后查询，元素此时已存在）。
 *
 * @param open - 弹窗是否打开。
 * @param selector - 弹窗容器的 CSS 选择器（通常是 `[data-st-dialog="x"]`）。
 */
export function useDialogFocus(open: boolean, selector: string): void {
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.querySelector<HTMLElement>(selector)
    const focusables = (): HTMLElement[] => {
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) return []
      return [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(x => x.offsetParent !== null || x === document.activeElement)
    }
    // 进入：优先第一个可聚焦元素，没有则让容器自己可聚焦
    const enter = focusables()
    if (enter.length > 0) enter[0]?.focus()
    else if (root) { root.tabIndex = -1; root.focus() }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) return
      const list = focusables()
      if (list.length === 0) { e.preventDefault(); return }
      const first = list[0]
      const last = list[list.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      const outside = !(active instanceof Node) || !el.contains(active)
      if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [open, selector])
}

/** 提示气泡（Radix Tooltip）。 */
export function Tooltip({ content, children }: {
  content: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className={css.tooltip} sideOffset={6}>
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

/** 徽标：语义色胶囊。 */
export function Badge({ tone = 'default', children, title }: {
  tone?: Tone
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return <span className={css.badge} data-tone={tone} title={title}>{children}</span>
}

/** 进度条（0-100）。 */
export function ProgressBar({ value, tone = 'cyan' }: {
  value: number
  tone?: 'cyan' | 'green' | 'amber' | 'red'
}): React.JSX.Element {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={css.progress} data-tone={tone} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={css.progressFill} style={{ width: `${v}%` }} />
    </div>
  )
}

/** 空态占位。 */
export function EmptyState({ icon = '🗂️', title = '暂无数据', desc, action }: {
  icon?: React.ReactNode
  title?: React.ReactNode
  desc?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={css.empty}>
      <div className={css.emptyIcon}>{icon}</div>
      <div className={css.emptyTitle}>{title}</div>
      {desc && <div className={css.emptyDesc}>{desc}</div>}
      {action}
    </div>
  )
}

/**
 * 空状态 + 「可能还在后台同步」的说明（第 62 轮）。
 *
 * 为什么需要：冷启动时后端要跑 1–2 分钟才把库同步完，期间 `getFiles` / 表情包等接口
 * 返回的是**空快照**。第 62 轮的 31 页签普查拍到现场：
 * 「文件资产」显示「共 **0** 项」、表情包显示「共 0」，而用户的库里其实有 3427 个文件。
 * 数字本身没错（快照确实是空的），但**读起来像数据丢了**。
 *
 * 这里不猜「是不是正在同步」（客户端拿不到可靠信号），只如实补一句可能性 + 说明会自动刷新，
 * 这样在有数据和没数据两种情况下都不会说假话。数据到了之后面板会自行刷新（useWechatDataUpdated）。
 * @param props.text - 主文案（如「暂无文件」）。
 * @param props.note - 覆盖默认说明；默认说明只在首次同步的长窗口下才有意义。
 */
export function EmptyMaybeSyncing({ text, note }: { text: React.ReactNode; note?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={css.emptyMaybe} data-st-empty-sync="1">
      <div className={css.emptyMaybeMain}>{text}</div>
      <div className={css.emptyMaybeNote}>
        {note ?? '若这是刚启动，后台可能仍在同步微信数据（首次同步约 1–2 分钟）；同步完成后会自动刷新。'}
      </div>
    </div>
  )
}

/** 下拉选择（Radix Select 样式化）。 */export function Select({ value, onChange, options, placeholder = '请选择…', ariaLabel, onOpen }: {
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: React.ReactNode }>
  placeholder?: string
  ariaLabel?: string
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} onOpenChange={(open) => { if (open) onOpen?.() }}>
      <SelectPrimitive.Trigger className={css.selectTrigger} aria-label={ariaLabel}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>▾</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className={css.selectContent} position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {options.map(o => (
              <SelectPrimitive.Item key={o.value} className={css.selectItem} value={o.value}>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className={css.selectCheck}>✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/** 单调单元格样式（md5/路径等）。 */
export function Mono({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className={css.cellMono}>{children}</span>
}

/** 主文本单元格样式。 */
export function CellPrimary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className={css.cellPrimary}>{children}</span>
}

/** 防抖值 hook：输入频繁变化时仅在停顿后提交（搜索框配套）。 */
export function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(value) }, delayMs)
    return () => { window.clearTimeout(t) }
  }, [value, delayMs])
  return debounced
}
