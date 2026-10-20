/**
 * `kit.tsx` 的「表单字段与轻量展示：Tooltip / Badge / 进度条 / 空态 / Select / 日期区间各字段」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kit-fields
 */

import * as React from 'react'
import clsx from 'clsx'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as SelectPrimitive from '@radix-ui/react-select'
import { RANGE_PRESETS, normalizeRange, resolveRangePreset, type RangePresetKey } from '../utils/date-range.ts'
import css from './kit.module.css'
import { Tone } from './kit-shell.tsx'

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

/**
 * 进度条（0-100）。
 * @param props - `value` 百分比；`indeterminate` 表示**总量未知**（后端此时报 total=0），
 * 画一段来回扫的短条 —— 否则总量未知的长任务会钉在一根 0% 的空条上，看着像卡死。
 */
export function ProgressBar({ value, tone = 'cyan', indeterminate = false }: {
  value: number
  tone?: 'cyan' | 'green' | 'amber' | 'red'
  indeterminate?: boolean
}): React.JSX.Element {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={css.progress} data-tone={tone} data-indeterminate={indeterminate || undefined}
      role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={css.progressFill} style={indeterminate ? undefined : { width: `${v}%` }} />
    </div>
  )
}

/**
 * 统一错误态（R4）。
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────
 * R4 勘察：仓库里渲染错误的地方有 **48 处、横跨 31 个面板**，但形态四分五裂：
 *   · 7 个面板各自定义了一份 `.error` / `.errBanner`（daily-summary / note-editor /
 *     overview / privacy-trust / session-ask / world-map / monitor），加上 kit 共 8 份同语义样式；
 *   · 6 处渲染错误时**漏了 `role="alert"`**（AskHistoryDialog / DailySummary /
 *     KnowledgeNoteEditor / Monitor / PrivacyTrust / WorldMap）—— 读屏软件完全不播报；
 *   · 前缀不统一（有的 `⚠️ {error}`、有的裸 `{error}`）；
 *   · 最坏的一类（PrivacyTrust）自定义 `.error` 只有 padding + color + font-size，
 *     **没有红框红底** ⇒ 出错与「没数据」视觉几乎无差。
 *
 * 这里把「红框 + 红底 + `role="alert"`」三件事绑成一个组件，调用方**没有机会漏掉**
 * 无障碍属性。`onRetry` 给「可重试的失败」一条出路（此前只能靠用户手动切页刷新）。
 *
 * 样式复用 `kit.module.css` 的 `.error`（**不新造类**，避免踩 `kit-css-split.wiring.spec.ts`
 * 的跨份引用坑）；`detail` 用 `<details>` 折叠——长堆栈/原始报文不再撑破版面。
 * @param props.message - 主文案（一句话说清「什么失败了」）。
 * @param props.detail - 可选的原始错误 / 堆栈，折叠展示。
 * @param props.onRetry - 传入则渲染「重试」按钮。
 */
export function ErrorState({ message, detail, onRetry }: {
  message: React.ReactNode
  detail?: React.ReactNode
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className={css.error} role="alert" data-st-error="1">
      <div className={css.errorMain}>{message}</div>
      {detail && (
        <details className={css.errorDetail}>
          <summary>详情</summary>
          <pre className={css.errorPre}>{detail}</pre>
        </details>
      )}
      {onRetry && (
        <button type="button" className={css.errorRetry} onClick={onRetry}>重试</button>
      )}
    </div>
  )
}

/**
 * 统一加载态（R4）。
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────
 * R4 勘察：同一句「加载中」在仓库里有三种形态 ——
 *   · `Graph.tsx` 有脉动骨架 + 两行文案（最好的一档）；
 *   · `CityMap.tsx:61` 是一行裸字 `正在加载城市地图…`；
 *   · `PrivacyTrust.tsx:162/187` 更糟：加载中和空态**共用 `.emptyInline`** ——
 *     两个语义完全不同的分支同一套视觉，用户分不清「在跑」和「没有」。
 *
 * 2026-10-18 用户要求「用正常的加载样式」：**不再画骨架条**（头像 + 占位线那套），
 * 统一改成「旋转指示 + 文案」。`skeleton` 档仅为兼容旧调用保留（视觉与 compact 相同），
 * 三档只差文案与附加信息：
 *   · `skeleton` / `compact` —— 一行紧凑的加载提示；
 *   · `timed` —— 慢查询带「已等待 Ns」，让等待有进度感。
 *
 * **不变量**：任何一档都**不得**复用空态视觉（`.empty` / `.emptyInline`）——
 * 否则又回到「加载 = 没数据」的老毛病。由 `state-components.wiring.spec.ts` 钉住。
 * @param props.label - 主文案。
 * @param props.variant - 三档之一（视觉已统一为旋转指示 + 文案）。
 * @param props.rows - 旧骨架行数参数，仅为兼容保留，加载态不再渲染骨架。
 * @param props.grid - 旧骨架网格参数，仅为兼容保留。
 * @param props.since - timed 档的已用秒数（调用方传 `useElapsedSeconds(x)`）。
 * @param props.hint - 可选的补充说明（如「首次同步约 1–2 分钟」）。
 */
export function LoadingState({ label = '加载中…', variant = 'compact', since, hint }: {
  label?: React.ReactNode
  variant?: 'skeleton' | 'compact' | 'timed'
  /** 兼容旧调用（骨架行数）；加载态已不再渲染骨架。 */
  rows?: number
  /** 兼容旧调用（骨架网格）；加载态已不再渲染骨架。 */
  grid?: boolean
  since?: number
  hint?: React.ReactNode
}): React.JSX.Element {
  const suffix = variant === 'timed' && since !== undefined ? `（已等待 ${since}s）` : ''
  return (
    <div className={css.loadingState} data-st-loading={variant}>
      <span className={css.spinner} aria-hidden="true" />
      <div className={css.loadingLabel} role="status">{label}{suffix}</div>
      {hint && <div className={css.loadingHint}>{hint}</div>}
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

/**
 * 文字链按钮（族 C，P3 收敛，2026-09-28）。
 *
 * 「长得像链接的原生 `<button>`」——无内边距、无边框、无背景、青色字、hover 下划线。
 * 六个面板原来各写一份该类（`exportLinkBtn` / `linkBtn`×4 / `link`），样式几乎相同
 * 但 hover 与字号各有出入；现在统一由 `css.link` 提供。
 *
 * **为什么不复用 `Button`**：`Button`（外部包 `dsh-client-ui-primitives`）的 6 个 variant
 * 全都带内边距与固定高（`ghost` 36px / `sm` 28px）。族 C 用在**表格单元格**与
 * 「说明 + 操作」行里，多出来的高度会撑开行、顶掉滚动位置 —— `padding: 0` 是语义，不是遗漏。
 *
 * `type="button"` 由组件内置（裸 `<button>` 在 `<form>` 内默认 `type="submit"`，
 * 六个调用点都没显式写，收敛顺带堵掉这个隐患）；其余原生属性（`title` / `disabled` /
 * `aria-*` / 事件）一律透传。
 *
 * @param props.children - 链接文字。
 */
export function LinkButton({ className, children, ...rest }: {
  className?: string | undefined
  children?: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button type="button" className={clsx(css.link, className)} {...rest}>
      {children}
    </button>
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

/**
 * 日期输入（原生 `input[type=date]`，套用与 `Select` 同一套皮肤）。
 *
 * 为什么继续用原生而不是自绘日历：`color-scheme: dark` 已让 Chromium 的日历弹层
 * 跟随深色主题，键盘输入/无障碍/本地化都不用自己重做一遍；需要修的只是「各面板
 * 各写一套边框高度」与「日历图标在深色底上看不见」这两件事（后者在 scifi-theme.css
 * 全局解决，任何未迁到本组件的 date 输入也一并受益）。
 * @param props - 值、变更回调与可访问性标签。
 * @returns 日期输入元素。
 */
export function DateField({ value, onChange, ariaLabel, id, min, max, className, placeholderHint }: {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  id?: string
  /** 最小可选日期（`YYYY-MM-DD`），传给原生 `min`。 */
  min?: string
  /** 最大可选日期（`YYYY-MM-DD`），传给原生 `max`。 */
  max?: string
  className?: string
  /** 空值时的补充说明（原生 date 无法自定义占位文案，只能另起一个 title）。 */
  placeholderHint?: string
}): React.JSX.Element {
  return (
    <input
      type="date"
      id={id}
      className={clsx(css.dateField, className)}
      value={value}
      onChange={(e) => { onChange(e.target.value) }}
      aria-label={ariaLabel}
      title={value ? undefined : placeholderHint}
      data-empty={value ? undefined : 'true'}
      {...(min ? { min } : {})}
      {...(max ? { max } : {})}
    />
  )
}

/**
 * 月份输入（原生 `input[type=month]`），与 `DateField` 同一套皮肤。
 *
 * 账本按月汇总用它。原生 month 在空值时会渲染成「----年--月」，视觉上像坏掉了 ——
 * 这里补上 `data-empty` 让它退成次要色，并给一个 title 说明这是「不限月份」。
 * @param props - 值、变更回调与可访问性标签。
 * @returns 月份输入元素。
 */
export function MonthField({ value, onChange, ariaLabel, id, className }: {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  id?: string
  className?: string
}): React.JSX.Element {
  return (
    <input
      type="month"
      id={id}
      className={clsx(css.dateField, className)}
      value={value}
      onChange={(e) => { onChange(e.target.value) }}
      aria-label={ariaLabel}
      title={value ? undefined : '不限月份'}
      data-empty={value ? undefined : 'true'}
    />
  )
}

/**
 * 时刻输入（原生 `input[type=time]`），与 `DateField` 同一套皮肤。
 * @param props - 值、变更回调与可访问性标签。
 * @returns 时刻输入元素。
 */
export function TimeField({ value, onChange, ariaLabel, id, className }: {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  id?: string
  className?: string
}): React.JSX.Element {
  return (
    <input
      type="time"
      id={id}
      className={clsx(css.dateField, className)}
      value={value}
      onChange={(e) => { onChange(e.target.value) }}
      aria-label={ariaLabel}
      data-empty={value ? undefined : 'true'}
    />
  )
}

/**
 * 日期区间（起止两个日期 + 可选的预设 chip + 可选的清除按钮）。
 *
 * 全应用此前有 8 处各写各的区间（周期总结另带一份预设实现），这里收敛成一个组件：
 * 预设来自 `utils/date-range.ts` 的纯函数，面板只负责接自己的 state。
 *
 * 起止**不**加 `min`/`max` 互相限制：那样用户想把「从」改到「到」之后会被原生控件
 * 直接灰掉，只能先清空另一端。这里改成两边都能自由选，起止颠倒时**在组件内自动对调**
 * —— 语义上「这段时间之内」本来就没有颠倒，静默对调比让筛选结果变空更符合预期。
 * @param props - 起止值、变更回调、预设键列表与清除回调。
 * @returns 区间控件元素。
 */
export function DateRangeField({ from, to, onFrom, onTo, onClear, presets, ariaLabel = '日期区间', idFrom, idTo, className, inline = false }: {
  from: string
  to: string
  onFrom: (value: string) => void
  onTo: (value: string) => void
  /** 传了才显示「清除」按钮（值全空时不渲染）。 */
  onClear?: () => void
  /** 要展示的预设 chip；省略则不显示预设行。 */
  presets?: readonly RangePresetKey[]
  ariaLabel?: string
  idFrom?: string
  idTo?: string
  className?: string
  /**
   * 预设与日期区间**并排一行**（默认上下两行）。
   *
   * 默认的上下堆叠在「筛选条只有这一件工具」时没问题，但放进**一行式筛选条**
   * （ClawBot 接入会话）就会把整条撑成两行 —— 那里预设与区间是同一件事的两半，
   * 并排才读得通（2026-10-17）。
   */
  inline?: boolean
}): React.JSX.Element {
  /** 起止都填了且颠倒时对调，再一次性写回两端。 */
  const commit = (nextFrom: string, nextTo: string): void => {
    const n = normalizeRange(nextFrom, nextTo)
    if (n.from !== nextFrom) onFrom(n.from)
    if (n.to !== nextTo) onTo(n.to)
  }
  const applyPreset = (key: RangePresetKey): void => {
    const r = resolveRangePreset(key)
    onFrom(r.from)
    onTo(r.to)
  }
  return (
    <div className={clsx(css.dateRange, inline && css.dateRangeInline, className)} role="group" aria-label={ariaLabel}>
      {presets && presets.length > 0 && (
        <div className={css.dateRangePresets}>
          {presets.map((key) => {
            const preset = RANGE_PRESETS.find(p => p.key === key)
            if (!preset) return null
            const r = preset.resolve(new Date())
            const active = from === r.from && to === r.to
            return (
              <button
                key={key}
                type="button"
                className={css.datePresetChip}
                data-active={active || undefined}
                onClick={() => { applyPreset(key) }}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      )}
      <div className={css.dateRangeRow}>
        <DateField
          value={from}
          onChange={(v) => { commit(v, to) }}
          aria-label={`${ariaLabel}起始日期`}
          id={idFrom}
          placeholderHint="起始日期"
        />
        <span className={css.dateRangeSep} aria-hidden="true">至</span>
        <DateField
          value={to}
          onChange={(v) => { commit(from, v) }}
          aria-label={`${ariaLabel}结束日期`}
          id={idTo}
          placeholderHint="结束日期"
        />
        {onClear && (from || to) && (
          <button type="button" className={css.dateRangeClear} onClick={onClear} aria-label="清除日期区间">✕</button>
        )}
      </div>
    </div>
  )
}
