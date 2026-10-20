/**
 * 会话列表的键盘导航（Alpha 的“统一虚拟行 + 键盘可达”在我们列表上的最小落地）。
 *
 * 为什么单独成纯函数：
 * - ChatsView / ChatsPanel 都已经贴着长函数棘轮，不能在里面长出新分支；
 * - 键盘导航的边界（首行按上、末行按下、从非行元素进入）可以用表格直接测，
 *   不需要挂 React 或模拟点击；
 * - 只处理**焦点移动**，Enter/Space 继续走原生 `<button>` 行为，避免再造一套激活逻辑。
 *
 * 行选择器用 `data-session-row` 而不是 CSS Module 类名：类名是哈希的，写判据时
 * 无法稳定命中；data 属性同时是“这一行可被键盘导航”的显式声明。
 */
import type { KeyboardEvent } from 'react'

/** 支持的导航键；其余按键返回 -1，交还给原生行为。 */
const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

/**
 * 计算下一个应该获得焦点的行下标。
 * @param key - KeyboardEvent.key。
 * @param currentIndex - 当前焦点在行的下标；不在任何行上时传 -1。
 * @param length - 行数。
 * @returns 下一行下标；非导航键或空列表返回 -1。
 */
export function nextListFocusIndex(key: string, currentIndex: number, length: number): number {
  if (length <= 0 || !NAV_KEYS.has(key)) return -1
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : Math.min(currentIndex + 1, length - 1)
  // ArrowUp
  return currentIndex < 0 ? length - 1 : Math.max(currentIndex - 1, 0)
}

/**
 * 在一组带 `data-session-row` 的按钮之间移动焦点。
 *
 * 只接管四个导航键；不 `preventDefault` 其它键（Tab/Enter/Space 必须保持原生语义）。
 * @param event - 列表容器上的 keydown 事件。
 * @param root - 列表容器；缺省用 `event.currentTarget`。
 * @param selector - 行选择器，默认 `[data-session-row]`。
 * @returns 是否处理了这次按键（调用方一般不需要，但便于单测/诊断）。
 */
export function focusListRow(
  event: KeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
  selector = '[data-session-row]',
): boolean {
  const container = root ?? event.currentTarget
  if (!container) return false
  const rows = Array.from(container.querySelectorAll<HTMLElement>(selector))
  if (rows.length === 0) return false
  const active = document.activeElement
  const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
  const next = nextListFocusIndex(event.key, current, rows.length)
  if (next < 0) return false
  event.preventDefault()
  rows[next]?.focus()
  return true
}
