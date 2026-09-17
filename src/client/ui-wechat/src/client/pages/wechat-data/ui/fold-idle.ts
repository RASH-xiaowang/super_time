/**
 * 「向上折叠」条的展开/收起与空闲自动折叠语义（纯逻辑，不 import react）。
 *
 * 为什么单独抽出来：这条组件的全部风险都在**什么时候该收起**上 ——
 * 指针离开后多久收、离开期间又回来了算不算、收起状态下再收到 leave 要不要重新计时、
 * 卸载后定时器还会不会把状态写回去。这些写死在组件里等于零回归信号，
 * 而它们恰好都能用注入时钟的纯对象钉住（见 fold-idle.spec.ts）。
 *
 * 复用 `panels/timers.ts` 的 `createRestartableTimer`：「静默期合并」的语义与
 * 「离开后 N 秒无操作才收起」完全同构 —— 每次活动都 restart，只有最后一次之后的
 * N 秒才真正触发，不需要自己再写一套句柄管理。
 */
import { createRestartableTimer, type TimerPort } from '../panels/timers.ts'

/** 空闲自动折叠的默认时长（10 秒）。 */
export const DEFAULT_FOLD_IDLE_MS = 10_000

/** 折叠/展开动画时长（与 kit.module.css 里 `.foldableBody` 的 transition 保持一致）。 */
export const FOLD_ANIM_MS = 280

/**
 * 折叠条的事件。
 *
 * `interact` 与 `pointer-enter` 的区别：进入是「指针又回来了」，交互是「在区域内有操作」
 * （点击、键盘、滚动）。两者对计时器的效果相同（取消待折叠），分开只是为了把语义写清楚，
 * 将来若要「交互后重新计时而不是取消」只改一处。
 */
export type FoldEvent =
  | { type: 'open' }
  | { type: 'collapse' }
  | { type: 'pointer-enter' }
  | { type: 'pointer-leave' }
  | { type: 'interact' }

/** 折叠条控制器。 */
export interface FoldController {
  /** 当前是否展开。 */
  isOpen(): boolean
  /** 喂一个事件；返回是否发生了展开态变化（用于决定要不要 setState）。 */
  dispatch(ev: FoldEvent): boolean
  /** 卸载：停掉定时器，之后 dispatch 一律无效。 */
  dispose(): void
}

/**
 * 造一个折叠条控制器。
 *
 * 状态机（`open` 为展开态）：
 * ```
 *   collapsed --open--> open            （并取消待折叠计时）
 *   open      --collapse--> collapsed   （同上）
 *   open      --pointer-leave--> open   （启动/重启 N 秒计时）
 *   open      --pointer-enter|interact--> open （取消计时）
 *   collapsed --其余事件--> collapsed   （no-op，不重启计时）
 * ```
 * 折叠态下收到 leave **不**计时：否则「已经收起了，鼠标划过又开始倒计时」毫无意义，
 * 还会在下拉菜单从收起条上方划过时平白多一次定时器。
 * @param options.onChange - 展开态真正变化时回调（只在变化时调，重复 open/collapse 不回调）。
 * @param options.idleMs - 空闲时长。
 * @param options.timer - 时钟注入点（测试用）。
 * @returns 控制器。
 */
export function createFoldController(options: {
  onChange: (open: boolean) => void
  idleMs?: number
  timer?: TimerPort
}): FoldController {
  const idleMs = options.idleMs ?? DEFAULT_FOLD_IDLE_MS
  const idle = createRestartableTimer({
    run: () => { apply(false) },
    delayMs: idleMs,
    ...(options.timer ? { timer: options.timer } : {}),
  })
  let open = false
  let disposed = false
  /** 写入展开态；只在真的变化时回调 onChange（否则父组件会无谓重渲染）。 */
  function apply(next: boolean): void {
    if (disposed || next === open) return
    open = next
    options.onChange(next)
  }
  return {
    isOpen: () => open,
    dispatch(ev: FoldEvent): boolean {
      if (disposed) return false
      const before = open
      switch (ev.type) {
        case 'open':
          idle.cancel()
          apply(true)
          break
        case 'collapse':
          idle.cancel()
          apply(false)
          break
        case 'pointer-leave':
          // 只在展开时计时（见函数头注释）
          if (open) idle.restart(idleMs)
          break
        case 'pointer-enter':
        case 'interact':
          idle.cancel()
          break
      }
      return open !== before
    },
    dispose(): void {
      disposed = true
      idle.dispose()
    },
  }
}
