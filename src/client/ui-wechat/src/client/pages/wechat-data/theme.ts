/**
 * 微信+主题管理：深色 / 浅色。
 *
 * - 默认跟随系统 prefers-color-scheme（首次启动时决定）。
 * - 用户手动切换后写入 localStorage（super-time-wechat-theme）。
 * - 通过 <html class="theme-light"> 切换 light-theme.css 覆盖层。
 */

export type ThemeMode = 'dark' | 'light'

import { clearTokenColorCache } from './utils/theme-color.ts'

const STORAGE_KEY = 'super-time-wechat-theme'
const _listeners = new Set<() => void>()

function systemMode(): ThemeMode {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

function storedMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function apply(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('theme-light', mode === 'light')
  document.documentElement.dataset.theme = mode
  // 主题一换，之前解析出的令牌颜色全部失效（ECharts / canvas 用的是具体颜色值）。
  clearTokenColorCache()
}

let _mode: ThemeMode = storedMode() ?? systemMode()
apply(_mode)

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  // 未手动选择时跟随系统主题切换
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (storedMode() !== null) return
    const next: ThemeMode = e.matches ? 'light' : 'dark'
    if (next === _mode) return
    _mode = next
    apply(next)
    for (const fn of _listeners) { try { fn() } catch { /* ignore */ } }
  })
}

/** 当前主题模式。 */
export function getThemeMode(): ThemeMode {
  return _mode
}

/** 订阅主题模式变化。 */
export function subscribeThemeMode(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

/** 设置主题模式并持久化。 */
export function setThemeMode(mode: ThemeMode): void {
  if (mode !== 'dark' && mode !== 'light') return
  if (mode === _mode) return
  _mode = mode
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 持久化失败不影响当前会话 */
  }
  apply(mode)
  for (const fn of _listeners) { try { fn() } catch { /* ignore */ } }
}

/** 深色 ⇄ 浅色切换。 */
export function toggleThemeMode(): void {
  setThemeMode(_mode === 'light' ? 'dark' : 'light')
}
