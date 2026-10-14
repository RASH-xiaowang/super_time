/**
 * `matchMedia` 的 React 订阅 hook。
 *
 * ## 为什么需要它（而不是写 CSS 媒体查询就够）
 *
 * 手机端要改的不只是样式，还有**结构与行为**：侧栏换成底部标签栏（多一个 DOM 子树）、
 * 抽屉换成全屏 sheet（Radix 的定位与焦点陷阱要跟着变）、浮动卡不再可拖（`use-draggable`
 * 要在粗指针下直接短路）。这些都不是 CSS 能表达的，得让组件知道「现在是窄视口」。
 *
 * 仓库此前没有任何宽度类的 `matchMedia` 用法（只有三处 `prefers-reduced-motion`），
 * 各处改用 `window.innerWidth` + resize 监听 —— 那样每个组件都要自己处理节流与清理。
 *
 * ## 两个刻意的口径
 *
 *   · **SSR / jsdom 安全**：`matchMedia` 在部分测试环境里不存在，缺失时按「不匹配」返回，
 *     并且**不订阅**。判据跑在 node 环境里时这条决定它是绿还是红。
 *   · **用 `addEventListener` 而不是已废弃的 `addListener`**，但保留一次回退探测 ——
 *     老内核（本项目 target 是 chrome120，理论用不到）与某些 jsdom 版本只实现后者。
 *
 * @module ui/use-media-query
 */
import { useEffect, useState } from 'react'

/** 读一次当前的匹配结果；`matchMedia` 不存在时返回 fallback。 */
function read(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback
  try {
    return window.matchMedia(query).matches
  } catch {
    return fallback // 查询串写错时不该让整个界面崩，退回「不匹配」
  }
}

/**
 * 订阅一个媒体查询。
 *
 * @param query - CSS 媒体查询串，例如 `'(max-width: 560px)'`。
 * @param fallback - 环境里没有 `matchMedia` 时的取值（缺省 false）。
 * @returns 当前是否匹配；查询变化或视口跨越断点时会重渲染。
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  // 初值直接读一次：首帧就要对，否则会先按桌面布局渲染一帧再跳（手机上看得见闪一下）。
  const [matches, setMatches] = useState<boolean>(() => read(query, fallback))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(query)
    } catch {
      return undefined
    }
    const onChange = (e: MediaQueryListEvent): void => { setMatches(e.matches) }
    // 挂载后立刻同步一次：query 变了、或在「渲染 → 副作用」之间视口就跨过了断点，
    // 只靠 change 事件会漏掉这一次。
    setMatches(mql.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => { mql.removeEventListener('change', onChange) }
    }
    // 老内核回退（addListener 已废弃，但只在没有 addEventListener 时才走）
    const legacy = mql as unknown as {
      addListener?: (fn: (e: MediaQueryListEvent) => void) => void
      removeListener?: (fn: (e: MediaQueryListEvent) => void) => void
    }
    legacy.addListener?.(onChange)
    return () => { legacy.removeListener?.(onChange) }
  }, [query])

  return matches
}

/**
 * 手机档断点（**第 5 档**）。
 *
 * 为什么不复用已有的 720 档：那一档同时被「桌面窗口拖窄」和「平板」命中，
 * 用它来切手机结构会让桌面上一个 700px 宽的窗口突然长出底部标签栏 ——
 * 而桌面窗口是可以随时拖窄的，那会看起来像界面坏了。
 *
 * 560px 的取值依据：桌面窗口几乎不会窄到这里（主面板的三栏布局在 700px 以下本来就已经
 * 靠容器查询降级了），而主流手机竖屏都在 360–430px、横屏最大也就 900 出头 ——
 * 横屏手机由 `(pointer: coarse)` 那一路单独处理，不靠这个断点。
 */
export const PHONE_QUERY = '(max-width: 560px)'

/** 粗指针（触摸）设备：交互差异（长按代替右键、拖拽短路、常显代替 hover）走这一条。 */
export const COARSE_QUERY = '(pointer: coarse)'
