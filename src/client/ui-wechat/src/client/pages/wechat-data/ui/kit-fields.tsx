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
export function DateRangeField({ from, to, onFrom, onTo, onClear, presets, ariaLabel = '日期区间', idFrom, idTo, className }: {
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
    <div className={clsx(css.dateRange, className)} role="group" aria-label={ariaLabel}>
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
