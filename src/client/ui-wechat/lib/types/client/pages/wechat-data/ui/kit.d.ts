/**
 * 本地微信数据管理 · UI Kit
 *
 * 面板重构的共享组件层：设计令牌来自 scifi-theme.css 的 --nm-* 变量，交互
 * 原语基于 Radix（Dialog/Tabs/ToggleGroup/Tooltip/Select），表格内核基于
 * TanStack Table，长列表虚拟化基于 @tanstack/react-virtual。所有组件均只
 * 负责外观与交互，不包含任何业务数据逻辑；现有面板的懒加载/实时行为不变。
 */
import * as React from 'react';
type Tone = 'default' | 'cyan' | 'green' | 'red' | 'amber' | 'purple' | 'blue';
/** 面板标题区：标题 + 描述 + 右侧操作按钮组。 */
export declare function PanelHeader({ title, desc, actions }: {
    title: React.ReactNode;
    desc?: React.ReactNode;
    actions?: React.ReactNode;
}): React.JSX.Element;
/** 工具栏：左侧筛选/搜索，右侧操作。 */
export declare function Toolbar({ left, right }: {
    left?: React.ReactNode;
    right?: React.ReactNode;
}): React.JSX.Element;
/** 带清除按钮的搜索输入（受控值，由面板自行防抖/触发查询）。 */
export declare function SearchInput({ value, onChange, placeholder, ariaLabel, onEnter }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    onEnter?: () => void;
}): React.JSX.Element;
/** 玻璃拟态卡片：可选标题栏/操作区/页脚。 */
export declare function Card({ title, extra, footer, children, flush, className }: {
    title?: React.ReactNode;
    extra?: React.ReactNode;
    footer?: React.ReactNode;
    children: React.ReactNode;
    flush?: boolean;
    className?: string;
}): React.JSX.Element;
/** 统计卡片：图标 + 数值 + 标签 + 备注，语义色强调；可选整卡可点。 */
export declare function StatCard({ icon, value, label, hint, tone, onClick, title }: {
    icon: React.ReactNode;
    value: React.ReactNode;
    label: React.ReactNode;
    hint?: React.ReactNode;
    tone?: Tone;
    onClick?: () => void;
    title?: string;
}): React.JSX.Element;
/** 统计卡片栅格容器。 */
export declare function StatGrid({ children }: {
    children: React.ReactNode;
}): React.JSX.Element;
/** 数据表格列定义（headless：渲染完全由面板提供）。 */
export interface DataColumn<T> {
    id: string;
    header: React.ReactNode;
    /** 渲染单元格（当前页行数据）。 */
    cell: (row: T) => React.ReactNode;
    /** 本页内排序键（数据本身仍按后端顺序/分页返回）。 */
    sortValue?: (row: T) => string | number | undefined;
    align?: 'left' | 'center' | 'right';
    className?: string;
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
export declare function DataTable<T>({ columns, rows, getRowId, loading, emptyTitle, emptyDesc, onRowClick, skeletonRows }: {
    columns: readonly DataColumn<T>[];
    rows: readonly T[];
    getRowId: (row: T, index: number) => string;
    loading?: boolean;
    emptyTitle?: string;
    emptyDesc?: string;
    onRowClick?: (row: T) => void;
    skeletonRows?: number;
}): React.JSX.Element;
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
export declare function VirtualList<T>({ items, getKey, rowHeight, renderRow, onEndReached, overscan, className }: {
    items: readonly T[];
    getKey: (item: T, index: number) => string;
    rowHeight: number;
    renderRow: (item: T, index: number) => React.ReactNode;
    onEndReached?: () => void;
    overscan?: number;
    className?: string;
}): React.JSX.Element;
/** 胶囊标签页（Radix Tabs 样式化）。 */
export declare function Tabs({ tabs, value, onChange, children }: {
    tabs: ReadonlyArray<{
        value: string;
        label: React.ReactNode;
    }>;
    value: string;
    onChange: (value: string) => void;
    children?: React.ReactNode;
}): React.JSX.Element;
/** 分段选择器（Radix ToggleGroup 样式化，单选）。 */
export declare function Segmented({ options, value, onChange, ariaLabel }: {
    options: ReadonlyArray<{
        value: string;
        label: React.ReactNode;
    }>;
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
}): React.JSX.Element;
/** 右侧抽屉（Radix Dialog）：详情/筛选面板统一入口。 */
export declare function Drawer({ open, onClose, title, children, footer, width }: {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
    width?: number;
}): React.JSX.Element;
/** 居中对话框（Radix Dialog）：确认/表单类弹窗。 */
export declare function Dialog({ open, onClose, title, children, footer }: {
    open: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
}): React.JSX.Element;
/** 提示气泡（Radix Tooltip）。 */
export declare function Tooltip({ content, children }: {
    content: React.ReactNode;
    children: React.ReactNode;
}): React.JSX.Element;
/** 徽标：语义色胶囊。 */
export declare function Badge({ tone, children, title }: {
    tone?: Tone;
    children: React.ReactNode;
    title?: string;
}): React.JSX.Element;
/** 进度条（0-100）。 */
export declare function ProgressBar({ value, tone }: {
    value: number;
    tone?: 'cyan' | 'green' | 'amber' | 'red';
}): React.JSX.Element;
/** 空态占位。 */
export declare function EmptyState({ icon, title, desc, action }: {
    icon?: React.ReactNode;
    title?: React.ReactNode;
    desc?: React.ReactNode;
    action?: React.ReactNode;
}): React.JSX.Element;
/** 下拉选择（Radix Select 样式化）。 */
export declare function Select({ value, onChange, options, placeholder, ariaLabel, onOpen }: {
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<{
        value: string;
        label: React.ReactNode;
    }>;
    placeholder?: string;
    ariaLabel?: string;
    onOpen?: () => void;
}): React.JSX.Element;
/** 单调单元格样式（md5/路径等）。 */
export declare function Mono({ children }: {
    children: React.ReactNode;
}): React.JSX.Element;
/** 主文本单元格样式。 */
export declare function CellPrimary({ children }: {
    children: React.ReactNode;
}): React.JSX.Element;
/** 防抖值 hook：输入频繁变化时仅在停顿后提交（搜索框配套）。 */
export declare function useDebouncedValue(value: string, delayMs?: number): string;
export {};
//# sourceMappingURL=kit.d.ts.map