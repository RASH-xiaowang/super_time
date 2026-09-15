/**
 * 两个与时间有关的纯原语（L8 的「合并触发」与 L20 的「提示自动消失」），
 * 以及它们的注入点。
 *
 * 为什么单独一个模块、且**不 import react**：仓库没有 DOM / hook 测试环境
 * （vitest 只跑纯逻辑模块），而这两处的语义恰恰是「什么时候触发、什么时候不该触发」——
 * 写死在组件里就等于零回归信号。这里把计时语义抽成可注入时钟的纯对象，
 * `timers.spec.ts` 用假时钟把每种交错钉住；react 那侧只剩一层薄壳
 * （`hooks.tsx` 的 `useTransientNotice`、`EchartsGraphCanvas.tsx` 的落定调度）。
 */

/** 计时器注入点：生产环境用 `globalThis`，测试注入假时钟。 */
export interface TimerPort {
  /** 排一个 `ms` 毫秒后执行的任务，返回可取消的句柄。 */
  set(fn: () => void, ms: number): unknown
  /** 取消句柄对应的任务。 */
  clear(handle: unknown): void
}

const defaultPort: TimerPort = {
  set: (fn, ms) => (globalThis.setTimeout as unknown as (f: () => void, m: number) => unknown)(fn, ms),
  clear: (handle) => { (globalThis.clearTimeout as unknown as (h: unknown) => void)(handle) },
}

/** 「提示语显示几秒」的默认时长（改前散落在各面板里的 3000ms）。 */
export const DEFAULT_NOTICE_MS = 3000

/**
 * 时长口径：非法/非正数一律回退到给定默认值，而不是「立刻消失」或「永不消失」——
 * 静默不消失是最难查的一种（界面看起来像卡住了）。
 * @param value - 调用方传入的时长。
 * @param fallback - 回退值。
 * @returns 可用的毫秒数。
 */
function normalDelay(value: number, fallback: number): number {
  const base = Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : DEFAULT_NOTICE_MS
  if (!Number.isFinite(value) || value <= 0) return base
  return Math.floor(value)
}

/** 可重启的定时器：每次 `restart` 都重新计时，只保留最后一次。 */
export interface RestartableTimer {
  /** 重新开始计时（丢弃尚未执行的那次）。 */
  restart(delayMs?: number): void
  /** 取消待执行的任务（不执行）。 */
  cancel(): void
  /** 是否有待执行的任务。 */
  pending(): boolean
  /** 取消并永久停用（组件卸载）；之后 `restart` 无效。 */
  dispose(): void
}

/**
 * 造一个「静默期合并」定时器：重复 `restart` 只在最后一次之后的 `delayMs` 执行一次。
 * @param options.run - 到期执行的动作。
 * @param options.delayMs - 静默期时长（毫秒）。
 * @param options.timer - 时钟注入点（测试用）。
 * @returns 定时器实例。
 */
export function createRestartableTimer(options: { run: () => void; delayMs: number; timer?: TimerPort }): RestartableTimer {
  const port = options.timer ?? defaultPort
  let handle: unknown
  let disposed = false
  const cancelPending = (): void => {
    if (handle === undefined) return
    port.clear(handle)
    handle = undefined
  }
  return {
    restart(delayMs?: number): void {
      // 卸载后再排任务没有意义：句柄与回调都会活过组件（回调用的是闭包里的 ref，
      // 会往已卸载的图/画布上写数据）。
      if (disposed) return
      cancelPending()
      handle = port.set(() => {
        handle = undefined
        options.run()
      }, normalDelay(delayMs ?? options.delayMs, options.delayMs))
    },
    cancel: cancelPending,
    pending: () => handle !== undefined,
    dispose(): void {
      cancelPending()
      disposed = true
    },
  }
}

/** 提示语控制器：写入一条提示，并在时长到点后自动清空。 */
export interface NoticeController<T> {
  /** 显示一条提示；重复调用会重置上一次的计时（新提示活满自己的时长）。 */
  flash(value: T, ms?: number): void
  /**
   * 写一条**不自动消失**的提示（并取消待执行的计时）。
   *
   * 为什么必须有它与 `flash` 并存：面板里的提示槽位是**共用**的 —— 成功类走
   * 「3 秒后消失」，而失败类（导出失败 / 读不到库）改前是**一直留着**的。
   * 只有 `flash` 的话，把这些槽位统一迁到本控制器就会把失败提示也变成自动消失，
   * 那是行为变更而不是重构。
   */
  hold(value: T): void
  /** 立刻清空并取消计时。 */
  clear(): void
  /** 卸载：取消计时，之后 `flash` 不再生效。 */
  dispose(): void
}

/**
 * 造一个提示语控制器。
 *
 * 为什么不能像改前那样逐个面板写 `setNotice(x); setTimeout(() => setNotice(null), 3000)`：
 *   ① 定时器句柄丢了 —— 组件卸载后回调仍会写 state；更常见的是**连续两条提示时，
 *      第一条的定时器把第二条提前清掉**（第二条只停留了「剩余时间」）；
 *   ② 时长散落成十余份魔数（实测 2500 / 3000 / 4000 / 6000 各面板不一致），
 *      改口径要改十处。
 * @param options.apply - 把值写进状态的入口（react 侧是 `setState`）。
 * @param options.durationMs - 默认存活时长。
 * @param options.timer - 时钟注入点（测试用）。
 * @returns 控制器。
 */
export function createNoticeController<T>(options: {
  apply: (value: T | null) => void
  durationMs?: number
  timer?: TimerPort
}): NoticeController<T> {
  const durationMs = options.durationMs ?? DEFAULT_NOTICE_MS
  const timer = createRestartableTimer({ run: () => { options.apply(null) }, delayMs: durationMs, ...(options.timer ? { timer: options.timer } : {}) })
  let disposed = false
  return {
    flash(value: T, ms?: number): void {
      // 卸载后写 state 是最容易漏的一种：定时器被取消了，但事件回调（点击 / 异步返回）
      // 仍可能带着旧闭包进来。
      if (disposed) return
      options.apply(value)
      timer.restart(ms)
    },
    hold(value: T): void {
      if (disposed) return
      // 先取消：否则上一条 flash 的定时器会在几秒后把这条常驻提示清掉
      // （这正是改前手写版最典型的缺陷之一）。
      timer.cancel()
      options.apply(value)
    },
    clear(): void {
      if (disposed) return
      timer.cancel()
      options.apply(null)
    },
    dispose(): void {
      disposed = true
      timer.dispose()
    },
  }
}
