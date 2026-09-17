/**
 * Super Time 主题管理：深色 / 浅色。
 *
 * - 默认深色：NEON MATRIX 本身就是深色设计，不再跟随系统 prefers-color-scheme
 *   （系统处于浅色时会让「默认」变成浅色，与默认深色的预期相反）。
 * - 用户手动切换后写入 localStorage（super-time-wechat-theme），此后以它为准。
 * - 通过 <html class="theme-light"> 切换 light-theme.css 覆盖层。
 */

export type ThemeMode = 'dark' | 'light'

import { clearTokenColorCache } from './utils/theme-color.ts'

const STORAGE_KEY = 'super-time-wechat-theme'
const _listeners = new Set<() => void>()

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

let _mode: ThemeMode = storedMode() ?? 'dark'
apply(_mode)

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
