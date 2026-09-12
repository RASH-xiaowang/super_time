import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import css from './kit.module.css';
/** 面板标题区：标题 + 描述 + 右侧操作按钮组。 */
export function PanelHeader({ title, desc, actions }) {
    return (_jsxs("div", { className: css.panelHeader, children: [_jsxs("div", { className: css.panelTitleWrap, children: [_jsx("h2", { className: css.panelTitle, children: title }), desc && _jsx("p", { className: css.panelDesc, children: desc })] }), actions && _jsx("div", { className: css.panelActions, children: actions })] }));
}
/** 工具栏：左侧筛选/搜索，右侧操作。 */
export function Toolbar({ left, right }) {
    return (_jsxs("div", { className: css.toolbar, children: [_jsx("div", { className: css.toolbarLeft, children: left }), right && _jsx("div", { className: css.toolbarRight, children: right })] }));
}
/** 带清除按钮的搜索输入（受控值，由面板自行防抖/触发查询）。 */
export function SearchInput({ value, onChange, placeholder = '搜索…', ariaLabel, onEnter }) {
    return (_jsxs("div", { className: css.searchBox, children: [_jsx("span", { className: css.searchIcon, children: "\uD83D\uDD0D" }), _jsx("input", { className: css.searchInput, type: "text", value: value, placeholder: placeholder, "aria-label": ariaLabel ?? placeholder, onChange: (e) => { onChange(e.target.value); }, onKeyDown: (e) => { if (e.key === 'Enter')
                    onEnter?.(); } }), value !== '' && (_jsx("button", { type: "button", className: css.searchClear, "aria-label": "\u6E05\u9664\u641C\u7D22", onClick: () => { onChange(''); }, children: "\u00D7" }))] }));
}
/** 玻璃拟态卡片：可选标题栏/操作区/页脚。 */
export function Card({ title, extra, footer, children, flush = false, className }) {
    return (_jsxs("section", { className: clsx(css.card, className), children: [(title || extra) && (_jsxs("div", { className: css.cardHd, children: [title && _jsx("div", { className: css.cardTitle, children: title }), extra && _jsx("div", { className: css.cardExtra, children: extra })] })), _jsx("div", { className: flush ? css.cardBdFlush : css.cardBd, children: children }), footer && _jsx("div", { className: css.cardFt, children: footer })] }));
}
/** 统计卡片：图标 + 数值 + 标签 + 备注，语义色强调；可选整卡可点。 */
export function StatCard({ icon, value, label, hint, tone = 'cyan', onClick, title }) {
    if (onClick) {
        return (_jsxs("button", { type: "button", className: clsx(css.statCard, css.statCardButton), "data-tone": tone, title: title, onClick: () => { onClick(); }, children: [_jsx("span", { className: css.statIcon, children: icon }), _jsx("span", { className: css.statValue, children: value }), _jsx("span", { className: css.statLabel, children: label }), hint && _jsx("span", { className: css.statHint, children: hint })] }));
    }
    return (_jsxs("div", { className: css.statCard, "data-tone": tone, children: [_jsx("div", { className: css.statIcon, children: icon }), _jsx("div", { className: css.statValue, children: value }), _jsx("div", { className: css.statLabel, children: label }), hint && _jsx("div", { className: css.statHint, children: hint })] }));
}
/** 统计卡片栅格容器。 */
export function StatGrid({ children }) {
    return _jsx("div", { className: css.statGrid, children: children });
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
export function DataTable({ columns, rows, getRowId, loading = false, emptyTitle = '暂无数据', emptyDesc, onRowClick, skeletonRows = 8 }) {
    const [sorting, setSorting] = useState([]);
    const colDefs = useMemo(() => columns.map((col) => {
        const base = {
            id: col.id,
            header: () => col.header,
            cell: info => col.cell(info.row.original),
        };
        const sortValue = col.sortValue;
        if (!sortValue)
            return base;
        return {
            ...base,
            accessorFn: row => sortValue(row),
            sortingFn: (a, b) => {
                const av = sortValue(a.original);
                const bv = sortValue(b.original);
                if (av === undefined && bv === undefined)
                    return 0;
                if (av === undefined)
                    return -1;
                if (bv === undefined)
                    return 1;
                return String(av).localeCompare(String(bv), 'zh-Hans-CN', { numeric: true });
            },
        };
    }), [columns]);
    const table = useReactTable({
        data: rows,
        columns: colDefs,
        state: { sorting },
        onSortingChange: setSorting,
        getRowId: (row, index) => getRowId(row, index),
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });
    if (loading && rows.length === 0) {
        return (_jsx("div", { className: css.tableWrap, children: _jsxs("table", { className: css.table, "aria-busy": "true", children: [_jsx("thead", { children: _jsx("tr", { children: columns.map(col => _jsx("th", { children: col.header }, col.id)) }) }), _jsx("tbody", { children: Array.from({ length: skeletonRows }).map((_, i) => (_jsx("tr", { children: columns.map(col => (_jsx("td", { children: _jsx("span", { className: "nm-skel", style: { display: 'inline-block', width: '60%', height: 12 } }) }, col.id))) }, i))) })] }) }));
    }
    if (rows.length === 0) {
        return _jsx(EmptyState, { title: emptyTitle, desc: emptyDesc });
    }
    return (_jsx("div", { className: css.tableWrap, children: _jsxs("table", { className: css.table, children: [_jsx("thead", { children: table.getHeaderGroups().map(hg => (_jsx("tr", { children: hg.headers.map((header) => {
                            const col = columns.find(c => c.id === header.column.id);
                            const sortable = Boolean(col?.sortValue);
                            const dir = header.column.getIsSorted();
                            return (_jsx("th", { className: clsx(sortable && css.thSortable), "data-sorted": dir || undefined, style: col?.align === 'right' ? { textAlign: 'right' } : col?.align === 'center' ? { textAlign: 'center' } : undefined, onClick: sortable ? header.column.getToggleSortingHandler() : undefined, children: _jsxs("span", { className: css.thInner, children: [flexRender(header.column.columnDef.header, header.getContext()), sortable && _jsx("span", { className: css.thArrow, children: dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕' })] }) }, header.id));
                        }) }, hg.id))) }), _jsx("tbody", { children: table.getRowModel().rows.map(row => (_jsx("tr", { className: clsx(onRowClick && css.rowClickable), onClick: onRowClick ? () => { onRowClick(row.original); } : undefined, children: row.getVisibleCells().map((cell) => {
                            const col = columns.find(c => c.id === cell.column.id);
                            return (_jsx("td", { className: clsx(col?.className), style: col?.align === 'right' ? { textAlign: 'right' } : col?.align === 'center' ? { textAlign: 'center' } : undefined, children: flexRender(cell.column.columnDef.cell, cell.getContext()) }, cell.id));
                        }) }, row.id))) })] }) }));
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
export function VirtualList({ items, getKey, rowHeight, renderRow, onEndReached, overscan = 8, className }) {
    const parentRef = useRef(null);
    const endReachedRef = useRef(onEndReached);
    endReachedRef.current = onEndReached;
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan,
    });
    const lastIndex = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
    useEffect(() => {
        if (lastIndex >= 0 && lastIndex >= items.length - 5)
            endReachedRef.current?.();
    }, [lastIndex, items.length]);
    return (_jsx("div", { ref: parentRef, className: clsx(css.vlist, className), children: _jsx("div", { className: css.vlistInner, style: { height: virtualizer.getTotalSize() }, children: virtualizer.getVirtualItems().map((vi) => {
                const item = items[vi.index];
                if (item === undefined)
                    return null;
                return (_jsx("div", { className: css.vlistRow, style: { transform: `translateY(${vi.start}px)`, height: rowHeight }, children: renderRow(item, vi.index) }, getKey(item, vi.index)));
            }) }) }));
}
/** 胶囊标签页（Radix Tabs 样式化）。 */
export function Tabs({ tabs, value, onChange, children }) {
    return (_jsxs(TabsPrimitive.Root, { className: css.tabs, value: value, onValueChange: onChange, children: [_jsx(TabsPrimitive.List, { className: css.tabList, children: tabs.map(t => (_jsx(TabsPrimitive.Trigger, { className: css.tabTrigger, value: t.value, children: t.label }, t.value))) }), children] }));
}
/** 分段选择器（Radix ToggleGroup 样式化，单选）。 */
export function Segmented({ options, value, onChange, ariaLabel }) {
    return (_jsx(ToggleGroup.Root, { className: css.seg, type: "single", value: value, "aria-label": ariaLabel, onValueChange: (v) => { if (v)
            onChange(v); }, children: options.map(o => (_jsx(ToggleGroup.Item, { className: css.segItem, value: o.value, children: o.label }, o.value))) }));
}
/** 右侧抽屉（Radix Dialog）：详情/筛选面板统一入口。 */
export function Drawer({ open, onClose, title, children, footer, width }) {
    return (_jsx(DialogPrimitive.Root, { open: open, onOpenChange: (v) => { if (!v)
            onClose(); }, children: _jsxs(DialogPrimitive.Portal, { children: [_jsx(DialogPrimitive.Overlay, { className: css.drawerOverlay }), _jsxs(DialogPrimitive.Content, { className: css.drawer, style: width ? { width: Math.min(width, 560) } : undefined, children: [_jsxs("div", { className: css.drawerHd, children: [_jsx(DialogPrimitive.Title, { className: css.drawerTitle, children: title }), _jsx(DialogPrimitive.Close, { className: css.drawerClose, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), _jsx("div", { className: css.drawerBd, children: children }), footer && _jsx("div", { className: css.drawerFt, children: footer })] })] }) }));
}
/** 居中对话框（Radix Dialog）：确认/表单类弹窗。 */
export function Dialog({ open, onClose, title, children, footer }) {
    return (_jsx(DialogPrimitive.Root, { open: open, onOpenChange: (v) => { if (!v)
            onClose(); }, children: _jsxs(DialogPrimitive.Portal, { children: [_jsx(DialogPrimitive.Overlay, { className: css.dialogOverlay }), _jsxs(DialogPrimitive.Content, { className: css.dialog, children: [title && (_jsxs("div", { className: css.drawerHd, children: [_jsx(DialogPrimitive.Title, { className: css.drawerTitle, children: title }), _jsx(DialogPrimitive.Close, { className: css.drawerClose, "aria-label": "\u5173\u95ED", children: "\u00D7" })] })), _jsx("div", { className: css.dialogBd, children: children }), footer && _jsx("div", { className: css.drawerFt, children: footer })] })] }) }));
}
/** 提示气泡（Radix Tooltip）。 */
export function Tooltip({ content, children }) {
    return (_jsx(TooltipPrimitive.Provider, { delayDuration: 300, children: _jsxs(TooltipPrimitive.Root, { children: [_jsx(TooltipPrimitive.Trigger, { asChild: true, children: children }), _jsx(TooltipPrimitive.Portal, { children: _jsx(TooltipPrimitive.Content, { className: css.tooltip, sideOffset: 6, children: content }) })] }) }));
}
/** 徽标：语义色胶囊。 */
export function Badge({ tone = 'default', children, title }) {
    return _jsx("span", { className: css.badge, "data-tone": tone, title: title, children: children });
}
/** 进度条（0-100）。 */
export function ProgressBar({ value, tone = 'cyan' }) {
    const v = Math.max(0, Math.min(100, value));
    return (_jsx("div", { className: css.progress, "data-tone": tone, role: "progressbar", "aria-valuenow": Math.round(v), "aria-valuemin": 0, "aria-valuemax": 100, children: _jsx("div", { className: css.progressFill, style: { width: `${v}%` } }) }));
}
/** 空态占位。 */
export function EmptyState({ icon = '🗂️', title = '暂无数据', desc, action }) {
    return (_jsxs("div", { className: css.empty, children: [_jsx("div", { className: css.emptyIcon, children: icon }), _jsx("div", { className: css.emptyTitle, children: title }), desc && _jsx("div", { className: css.emptyDesc, children: desc }), action] }));
}
/** 下拉选择（Radix Select 样式化）。 */
export function Select({ value, onChange, options, placeholder = '请选择…', ariaLabel, onOpen }) {
    return (_jsxs(SelectPrimitive.Root, { value: value, onValueChange: onChange, onOpenChange: (open) => { if (open)
            onOpen?.(); }, children: [_jsxs(SelectPrimitive.Trigger, { className: css.selectTrigger, "aria-label": ariaLabel, children: [_jsx(SelectPrimitive.Value, { placeholder: placeholder }), _jsx(SelectPrimitive.Icon, { children: "\u25BE" })] }), _jsx(SelectPrimitive.Portal, { children: _jsx(SelectPrimitive.Content, { className: css.selectContent, position: "popper", sideOffset: 4, children: _jsx(SelectPrimitive.Viewport, { children: options.map(o => (_jsxs(SelectPrimitive.Item, { className: css.selectItem, value: o.value, children: [_jsx(SelectPrimitive.ItemText, { children: o.label }), _jsx(SelectPrimitive.ItemIndicator, { className: css.selectCheck, children: "\u2713" })] }, o.value))) }) }) })] }));
}
/** 单调单元格样式（md5/路径等）。 */
export function Mono({ children }) {
    return _jsx("span", { className: css.cellMono, children: children });
}
/** 主文本单元格样式。 */
export function CellPrimary({ children }) {
    return _jsx("span", { className: css.cellPrimary, children: children });
}
/** 防抖值 hook：输入频繁变化时仅在停顿后提交（搜索框配套）。 */
export function useDebouncedValue(value, delayMs = 300) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = window.setTimeout(() => { setDebounced(value); }, delayMs);
        return () => { window.clearTimeout(t); };
    }, [value, delayMs]);
    return debounced;
}
//# sourceMappingURL=kit.js.map