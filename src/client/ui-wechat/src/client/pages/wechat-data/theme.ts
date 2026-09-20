/**
 * Super Time 主题管理：深色 / 浅色。
 *
 * - 默认深色：NEON MATRIX 本身就是深色设计，不再跟随系统 prefers-color-scheme
 *   （系统处于浅色时会让「默认」变成浅色，与默认深色的预期相反）。
 * - 用户手动切换后写入 localStorage（super-time-wechat-theme），此后以它为准。
 * - 通过 <html class="theme-light"> 切换 light-theme.css 覆盖层。
 *
 * ## 切换动效：全页颜色过渡（theme color transition）
 *
 * 一次主题切换会同时改动几十个 CSS 令牌，整页（背景、卡片、文字、边框）本来是在**同一帧**
 * 里一起变色的 —— 直接切过去就是一次全局跳变。这里把它变成一段颜色过渡。
 * 观感契约固定如下，改任何一条都是在改契约，先把这段读完：
 *
 * - **触发条件**：`setThemeMode` / `toggleThemeMode` 被调用，且目标模式 ≠ 当前模式时触发，
 *   **一次切换只触发一次**。重复设置同一模式不触发（有对应用例守着）。
 * - **持续时间**：400ms（`THEME_TRANSITION_DURATION`）；
 *   用户开了「减少动效」时由 CSS 降到 120ms（`THEME_TRANSITION_REDUCED_DURATION`）。
 * - **缓动**：`cubic-bezier(0.22, 1, 0.36, 1)`（`THEME_TRANSITION_EASING`，先快后慢）。
 * - **适用范围**：`<html>`（`:root`）上登记为可插值颜色的**主题令牌**，
 *   覆盖由令牌取值的一切颜色 —— `background-color` / `color` / `border-color` /
 *   `outline-color` / `fill` / `stroke` 等，作用于**所有引用这些令牌的元素与伪元素**，
 *   不需要任何元素级选择器（伪元素、createPortal 出去的浮层因此都不会漏）。
 *   不含 `background-image`（CSS 无法插值两个渐变，写了也只是终点突变）、
 *   不含阴影令牌（值是 `0 0 8px rgba(…)` 这类阴影简写而不是颜色，拿去注册 <color>
 *   会让阴影直接失效）、不含 `transform` / `opacity`（不是颜色，主题切换不该顺手动画位移与透明）。
 *
 * 实现只有一条：切换期间给 `<html>` 挂一次性的 `.theme-transition` 类，由 scifi-theme.css
 * 让那批颜色令牌走同一条 400ms 过渡（`transition-property` 列的是**令牌名**而不是 CSS
 * 属性名 —— 令牌逐帧插值后，引用它的元素自然逐帧拿到中间色）。到点摘掉。
 * **不在 JS 里逐元素写行内样式**，也**不给元素挂过渡** —— 前者要枚举元素（createPortal
 * 出去的浮层、画布旁的工具条很容易漏）并把行内样式永久留在 DOM 上；后者是真机量化过的
 * 性能缺陷：`color` 是继承属性，元素级写法会让文档里 880 个元素各建一条过渡、累计卡顿
 * 265ms，而令牌级只有 93 个过渡对象、累计卡顿 40ms 上下（隔离实验 34ms，产品整段复测
 * 45ms —— 同一轮基线噪声本身就有 42ms；详见 scifi-theme.css 那节注释与
 * working/check-output/cdp-theme-cost2.txt、cdp-theme-token.txt）。
 *
 * 同一个任务里「先加类、后改令牌」即可，不需要中间强制一次样式计算：CSS Transitions 判定
 * 「是否起过渡」看的是**变更后样式**里有没有覆盖该属性的 transition（以及时长 > 0），
 * 而加类与改令牌都会被同一次样式计算采纳，所以变更后样式里两者都在。
 *
 * ## 为什么不用 View Transitions 的圆形扩散
 *
 * 上一版用 `document.startViewTransition` + `clip-path: circle()` 做「新主题从按钮圆心扩散」。
 * 它在可见窗口下逐帧量是像素级正确的，但**恰好不满足「平滑的颜色过渡」**，而且有三种
 * 静默失效的形态 —— 三者都表现为「没有过渡、直接跳」，且都不会报错：
 *
 *  1. **它本来就不是颜色过渡**：新旧两张整页快照，中间是一条**硬边圆盘** —— 圆内是真新色、
 *     圆外是真旧色，没有任何一帧是「两种颜色之间的中间色」。用户看到的仍是一次跳变，
 *     只是跳变的位置被推着走。
 *  2. **窗口不可见时 Chromium 会整段跳过 View Transition**：`document.visibilityState`
 *     为 `hidden`（窗口被完全遮挡 / 最小化）时 `transition.ready` 直接被拒
 *     （`InvalidStateError: Transition was aborted because of invalid state`），
 *     而主题已经在更新回调里提交了 → 动画不播、主题已换。
 *     本机实测反复落到这一路（`working/check-output/cdp-theme-diag2.txt`）。
 *  3. `prefers-reduced-motion: reduce` 时旧实现是**直接切换、不做任何过渡**，
 *     于是 Windows 里关掉「动画效果」的用户**永远**看不到过渡。
 *
 * 颜色过渡没有这些前提：它是普通 CSS 过渡，只要样式引擎在算样式就会插值，与窗口可见性、
 * 动效偏好都无关。降级路径也从「无动画」改成「更短的动画」—— 全页底色瞬间翻转恰恰是
 * 减少动效用户最难受的一下，120ms 的渐变既尊重了偏好，也不制造硬跳。
 */

import { useSyncExternalStore } from 'react'
import { clearTokenColorCache } from './utils/theme-color.ts'

export type ThemeMode = 'dark' | 'light'

/**
 * 颜色过渡时长（ms）。
 *
 * 与 scifi-theme.css 里那条 `.theme-transition` 规则的 `transition-duration` **必须一致**
 * —— `theme.spec.ts` 会读该 CSS 文本比对，只改一处会转红。
 * 区间：低于 ~250ms 只像闪一下，高于 ~700ms 会让人觉得界面在「慢慢褪色」。
 */
export const THEME_TRANSITION_DURATION = 400

/**
 * 「减少动效」时的时长（ms）。**刻意不是 0**：切换主题必然要改整页底色，
 * 瞬间翻转是这类用户最难受的一下 —— 缩短 3 倍多既尊重了偏好，也保住了「平滑」。
 * 与 CSS 的 `prefers-reduced-motion` 分支保持一致（同一处用例守着）。
 */
export const THEME_TRANSITION_REDUCED_DURATION = 120

/**
 * 颜色过渡缓动。先快后慢的 ease-out 系：改色这件事「早变完、慢收尾」最像自然衰减，
 * 线性缓动会让整页颜色以匀速爬过去，观感发木。与 CSS 里的取值必须一致。
 */
export const THEME_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * 过渡期间挂在 `<html>` 上的一次性类名 —— scifi-theme.css 里那条规则的唯一开关。
 * 名字里带 `theme-` 前缀是为了跟 `theme-light` 并排时一眼看出是同一套主题机制。
 */
export const THEME_TRANSITION_CLASS = 'theme-transition'

/**
 * 摘掉 `.theme-transition` 的等待时间：过渡时长 + 一帧余量。
 * 余量的作用：`transitionend` 的到达时刻与 setTimeout 并不对齐，卡在正点摘掉有可能
 * 让最后 1~2 帧失去过渡（表现为收尾一顿）。多等 80ms 的代价只是「类多挂 80ms」，
 * 而这段时间里没有任何令牌在变，不会有副作用。
 */
const THEME_TRANSITION_LINGER = 80

const STORAGE_KEY = 'super-time-wechat-theme'
const _listeners = new Set<() => void>()

/** 摘掉 `.theme-transition` 的定时器句柄；连点两次主题按钮时要重置，否则第一枪会把类提前摘掉。 */
let _stripTimer: ReturnType<typeof setTimeout> | null = null

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

function notifyListeners(): void {
  for (const fn of _listeners) { try { fn() } catch { /* 单个订阅者报错不影响其它订阅者 */ } }
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

/**
 * 当前主题模式（组件里请用这个，不要自己写 `useSyncExternalStore`）。
 *
 * 为什么收敛成一个 hook：四个面板（数据面板 / 日历热力图 / 地区地图 / 社交图谱）各自写了一份
 * `useSyncExternalStore(subscribeThemeMode, getThemeMode)` —— 而 **`useSyncExternalStore` 在
 * 服务端渲染时必须给第三个参数 `getServerSnapshot`**，少了它 React 会直接抛
 * `Missing getServerSnapshot, which is required for server-rendered content`。
 * 本应用是纯客户端渲染，所以一直没有暴露；但 `scripts/ui-ask-smoke` 的 `renderToStaticMarkup`
 * 一渲染这些面板就会红 —— 于是「图谱面板有没有渲染期崩溃」这件事根本没法用 SSR 冒烟来看。
 *
 * `getThemeMode` 本身就是一次模块级变量读取（不碰 localStorage / document），
 * 拿它同时当服务端快照是安全的：初次渲染与服务端一致，挂载后订阅再接管。
 * @returns 主题模式。
 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeThemeMode, getThemeMode, getThemeMode)
}

/* ── 切换：挂一次性类，让这次令牌变化走颜色过渡 ───────────────────────────── */

/**
 * 应用主题，并让**这一次**变化走颜色过渡。
 *
 * 顺序不能反（先挂类、后改令牌）：类必须在「变更后样式」里就已经存在，
 * 否则这次变化没有覆盖它的 transition，浏览器不会起过渡。两者都在同一个任务里，
 * 会被同一次样式计算采纳，所以不需要中间插入强制样式刷新。
 *
 * 非 DOM 环境（node / SSR）下退化为纯同步切换：没有可挂类的元素，也不留任何定时器。
 *
 * @param mode - 已经确定要切过去的模式（调用方负责幂等判断）。
 */
function commitTheme(mode: ThemeMode): void {
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (root) root.classList.add(THEME_TRANSITION_CLASS)

  apply(mode)
  notifyListeners()

  if (!root) return
  if (_stripTimer !== null) clearTimeout(_stripTimer)
  // 等的是 THEME_TRANSITION_DURATION 而不是减少动效那一档：减少动效只是把 CSS 时长改短，
  // 类多挂一会儿没有任何副作用（这段时间里没有令牌在变），而按更短的时长去摘，
  // 一旦偏好读错了就会在过渡中途把类摘掉、把尾巴砍断。
  _stripTimer = setTimeout(() => {
    _stripTimer = null
    root.classList.remove(THEME_TRANSITION_CLASS)
  }, THEME_TRANSITION_DURATION + THEME_TRANSITION_LINGER)
}

/**
 * 设置主题模式并持久化。
 *
 * 模式没变时**直接返回**：这既避免了无谓的持久化写入，也是「一次切换只触发一次过渡」的
 * 实现 —— 否则重复调用会把 `.theme-transition` 反复挂上再等，看不出差别但多了一次重排。
 *
 * @param mode - 目标主题。
 */
export function setThemeMode(mode: ThemeMode): void {
  if (mode !== 'dark' && mode !== 'light') return
  if (mode === _mode) return
  _mode = mode
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 持久化失败不影响当前会话 */
  }
  commitTheme(mode)
}

/** 深色 ⇄ 浅色切换。过渡的触发条件 / 时长 / 缓动 / 范围见文件头。 */
export function toggleThemeMode(): void {
  setThemeMode(_mode === 'light' ? 'dark' : 'light')
}
