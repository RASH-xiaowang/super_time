/**
 * 实时同步节拍的触发合并器（2026-10-18）。
 *
 * ## 解决什么
 *
 * `sync.ts` 的 tick 有「一轮没跑完不开第二轮」的闸门。WAL 监听在 tick 运行期间
 * 到达的触发，原实现直接丢掉 —— 之后只能等 10s 兜底轮询，用户看到的是「消息已经
 * 写进 WAL，界面却要愣一下才出来」。消息成簇到达（一次发图会连着写多个库）或某拍
 * 恰好较慢（整库重解密 / 网络盘）时，这个空窗最明显。
 *
 * ## 口径
 *
 * 1. **不丢触发**：tick 在跑时到达的触发记成 pending，跑完立刻补一拍；
 * 2. **不叠加**：pending 期间的多次触发合并成一拍（trailing 延迟只为把同一簇写入收拢）；
 * 3. **不并发**：任何时刻最多一个 `run` 在途；
 * 4. **stop 之后静默**：已排的 trailing 定时器清掉，不会再产生新拍。
 *
 * 定时器可注入（单测用假调度，生产走 `setTimeout`）。
 */

/** 补拍延迟：只用来把「同一簇 WAL 写入」收拢，不是新鲜度本身。 */
export const SYNC_TRAILING_DELAY_MS = 80

/** 可注入依赖：单测给假调度/假时钟；缺省走真 `setTimeout`。 */
export interface SyncTriggerDeps {
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

/** 调用方拿到的句柄。 */
export interface SyncTrigger {
  /** 请求一拍：空闲则立刻跑；在跑/已排队则合并进 pending。 */
  trigger(): void
  /** 当前是否真的空闲（没有在跑、没有排队的补拍）。 */
  idle(): boolean
  /** 停止（清掉已排的定时器；在跑的那一拍任其自然结束）。 */
  stop(): void
}

/**
 * 创建合并器。
 * @param opts - `run` 是要串行化的异步节拍；`trailingDelayMs` 可覆盖补拍延迟。
 * @param deps - 测试注入点（缺省走真 `setTimeout` / `clearTimeout`）。
 * @returns `trigger` / `idle` / `stop` 句柄。
 */
export function createSyncTrigger(
  opts: { run: () => Promise<void>; trailingDelayMs?: number },
  deps: SyncTriggerDeps = {},
): SyncTrigger {
  const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  const trailingDelayMs = opts.trailingDelayMs ?? SYNC_TRAILING_DELAY_MS
  let running = false
  let pending = false
  let stopped = false
  let timer: unknown = null

  const execute = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      await opts.run()
    } catch {
      // run 自己的错误由它记录；合并器只保证下一个触发还能进来、不会卡死在这里。
    } finally {
      running = false
      // pending 期间到达的触发不再叠加：补一拍即可把最新状态解出来。
      if (stopped || !pending || timer !== null) return
      pending = false
      timer = schedule(() => {
        timer = null
        if (!stopped) void execute()
      }, trailingDelayMs)
    }
  }

  return {
    trigger(): void {
      if (stopped) return
      // 在跑或已排补拍 ⇒ 只合并，不并发、不叠加。
      if (running || timer !== null) {
        pending = true
        return
      }
      void execute()
    },
    idle(): boolean {
      return !running && timer === null && !pending
    },
    stop(): void {
      stopped = true
      pending = false
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
    },
  }
}
