/**
 * `kit.tsx` 的「浮层与分段：Tabs / Segmented / Drawer / Dialog 及 Esc、焦点两个钩子」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kit-overlay
 */

import * as React from 'react'
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import overlayCss from './kit-overlay.module.css'

/** 胶囊标签页（Radix Tabs 样式化）。 */
export function Tabs({ tabs, value, onChange, children }: {
  tabs: ReadonlyArray<{ value: string; label: React.ReactNode }>
  value: string
  onChange: (value: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <TabsPrimitive.Root className={overlayCss.tabs} value={value} onValueChange={onChange}>
      <TabsPrimitive.List className={overlayCss.tabList}>
        {tabs.map(t => (
          <TabsPrimitive.Trigger key={t.value} className={overlayCss.tabTrigger} value={t.value}>
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
      className={overlayCss.seg}
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v) => { if (v) onChange(v) }}
    >
      {options.map(o => (
        <ToggleGroup.Item key={o.value} className={overlayCss.segItem} value={o.value}>
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
        <DialogPrimitive.Overlay className={overlayCss.drawerOverlay} />
        <DialogPrimitive.Content className={overlayCss.drawer} style={width ? { width: Math.min(width, 560) } : undefined}>
          <div className={overlayCss.drawerHd}>
            <DialogPrimitive.Title className={overlayCss.drawerTitle}>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className={overlayCss.drawerClose} aria-label="关闭">×</DialogPrimitive.Close>
          </div>
          <div className={overlayCss.drawerBd}>{children}</div>
          {footer && <div className={overlayCss.drawerFt}>{footer}</div>}
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
        <DialogPrimitive.Overlay className={overlayCss.dialogOverlay} />
        <DialogPrimitive.Content className={clsx(overlayCss.dialog, className)}>
          {title && (
            <div className={overlayCss.drawerHd}>
              <DialogPrimitive.Title className={overlayCss.drawerTitle}>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close className={overlayCss.drawerClose} aria-label="关闭">×</DialogPrimitive.Close>
            </div>
          )}
          <div className={overlayCss.dialogBd}>{children}</div>
          {footer && <div className={overlayCss.drawerFt}>{footer}</div>}
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
export const escStack: Array<() => void> = []

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
