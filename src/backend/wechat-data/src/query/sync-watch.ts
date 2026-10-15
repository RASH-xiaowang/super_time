/**
 * WAL 实时监听（2026-10-13，用户要求「WAL 实时推送更新，而不是定时轮询」）。
 *
 * ## 背景与实测
 *
 * 实时同步原先只有 `SYNC_INTERVAL_MS = 10s` 一轮的 mtime 轮询：微信写 WAL 后，
 * 最长要等一拍才解密并推送 `wechat-data/updated` —— 界面（聊天信息统计、新消息）
 * 最坏滞后 ~10s。本模块在原始库目录上挂 `fs.watch`（recursive），WAL 一写就
 * **立即**触发一次同步节拍，把「WAL 写入 → 推送」压到亚秒级。
 *
 * 本机实测（NTFS，一次性脚本 `working/watch-latency-probe.mjs` / `watch-append-probe.mjs`，
 * 用完即弃）：
 *   · 新建文件 → 目录级 watch `rename` 事件：20/20 次到达，min/median/p90/max = 0/0/1/1 ms；
 *   · 既有 `-wal` 文件**内容追加**（微信写 WAL 的真实形态）→ 目录级 watch `change` 事件：0 ms；
 *   · 检查点 rename → 目录级 watch `rename` 事件：1 ms。
 * 结论：目录级 recursive watch 一条就够，不必逐个挂文件监听。
 *
 * ## 为什么 10s 轮询仍保留
 *
 * fs.watch 在部分文件系统（网络盘、部分移动盘）上会丢事件甚至直接报错 —— 它只是
 * **时延优化**，不是新的正确性来源：轮询照旧跑，「宁可慢，不可错」（一次漏事件最多
 * 回到 10s 级新鲜度，不会显示旧数据）。监听报错时摘掉自己，下一拍 `refresh` 重挂。
 *
 * ## 防抖与限频
 *
 * 微信写 WAL 是成簇的（一条消息可能触发多库多次写），检查点还会 rename：
 * 事件先过 `WATCH_DEBOUNCE_MS` 防抖合并，再受 `WATCH_MIN_GAP_MS` 最小间隔限频。
 * 一个活跃会话最坏每秒 ~0.7 次额外节拍；节拍本身是 0.4ms 级热探测
 * （`sync-state.ts` 的实测表），增量 WAL 补丁也只解真正变化的部分。
 *
 * 环境变量 `SUPERTIME_SYNC_WATCH=0` 关掉监听（只留轮询），供对比测量/排障。
 */
import { watch } from 'node:fs'

/** 事件防抖：一个写入簇合并成一次触发。 */
export const WATCH_DEBOUNCE_MS = 400
/** 触发限频：两次监听触发的最小间隔（轮询兜底不受影响）。 */
export const WATCH_MIN_GAP_MS = 1_500

/** 监听器的最小接口（真机是 `node:fs` 的 FSWatcher，单测注入假件）。 */
export interface SyncWatcherLike {
  close(): void
  on(event: 'error', cb: (err: Error) => void): unknown
}

/** 可注入依赖：单测给假 watch / 假时钟；缺省走真 `node:fs` 与 `Date.now`。 */
export interface SyncWatchDeps {
  watchDir?: (dir: string, onChange: (eventType: string, filename: string | null) => void) => SyncWatcherLike | null
  now?: () => number
}

export interface SyncWatchHandle {
  /** 每拍都带当前 raw 根调用：目录变了就重挂监听（报错后也靠它自愈）。 */
  refresh(dir: string): void
  stop(): void
}

/**
 * 启动原始库目录的 WAL 监听：目录内任何写入（追加/新建/rename）经防抖与限频后
 * 调一次 `onTrigger`。挂载失败或运行期报错只上报一次（`onWatchError`），
 * 且监听被摘掉后由调用方下一拍 `refresh` 重挂。
 * @param opts - `onTrigger` 是合并后的一次触发；`onAttached` 在每次新挂载成功时回调
 *   （供诊断日志/探针确认监听真的挂在哪个目录上）；`onWatchError` 可选。
 * @param deps - 测试注入点（缺省走真 fs.watch / Date.now）。
 * @returns `refresh` / `stop` 句柄。
 */
export function startSyncWatch(
  opts: { onTrigger: () => void; onAttached?: (dir: string) => void; onWatchError?: (message: string) => void },
  deps: SyncWatchDeps = {},
): SyncWatchHandle {
  const watchDir = deps.watchDir ?? ((dir, onChange) => watch(dir, { recursive: true }, onChange))
  const now = deps.now ?? (() => Date.now())
  let watcher: SyncWatcherLike | null = null
  let watchedDir = ''
  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastTriggerAt = -Infinity
  let errorNoted = false

  const fire = (): void => {
    debounce = null
    const at = now()
    if (at - lastTriggerAt < WATCH_MIN_GAP_MS) return
    lastTriggerAt = at
    opts.onTrigger()
  }

  const schedule = (): void => {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(fire, WATCH_DEBOUNCE_MS)
  }

  const detach = (): void => {
    if (watcher !== null) {
      try { watcher.close() } catch { /* 已关/半关：摘掉即可 */ }
      watcher = null
    }
    watchedDir = ''
  }

  const attach = (dir: string): void => {
    try {
      watcher = watchDir(dir, schedule)
    } catch (e) {
      watcher = null
      if (!errorNoted) {
        errorNoted = true
        opts.onWatchError?.(`fs.watch 挂载失败：${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (watcher === null) return
    watchedDir = dir
    errorNoted = false
    opts.onAttached?.(dir)
    watcher.on('error', (err) => {
      // 报错的监听器多半已失效：摘掉，让调用方下一拍 refresh 重挂（轮询兜底仍在）。
      detach()
      if (!errorNoted) {
        errorNoted = true
        opts.onWatchError?.(`fs.watch 报错：${err.message}`)
      }
    })
  }

  return {
    refresh(dir) {
      if (dir === watchedDir) return
      detach()
      if (dir === '') return
      attach(dir)
    },
    stop() {
      if (debounce !== null) clearTimeout(debounce)
      debounce = null
      detach()
    },
  }
}
