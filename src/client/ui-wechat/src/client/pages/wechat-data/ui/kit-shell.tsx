/**
 * `kit.tsx` 的「布局外壳：可点击语义助手、面板头/工具栏/搜索框/卡片/统计卡与栅格」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kit-shell
 */

import * as React from 'react'
import clsx from 'clsx'
import css from './kit.module.css'

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

export type Tone = 'default' | 'cyan' | 'green' | 'red' | 'amber' | 'purple' | 'blue'

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
