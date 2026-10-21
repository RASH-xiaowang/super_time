/**
 * WeChat data backend plugin: registers the WechatDataGateway Remote service.
 */
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from './gateway.ts'

export type * from './types.ts'
export { WechatDataGateway } from './gateway.ts'
export { fetchWithRetry } from './net/fetch-retry.ts'
export { configureSqliteCachePolicy } from './query/db-open.ts'
/**
 * 原图自动下载（实验）的后端启动钩子：宿主在 `createWechatBackend` 建好 gateway 后调用，
 * 上次开关是打开的就在后台恢复注入；宿主 dispose 时调用返回的 `stop()` 还原微信进程。
 */
export { startWechatImageAutoDownloadOnBoot } from './query/wechat-image-autodownload.ts'

/**
 * H2（2026-09-28）：把「慢调用的耗时」落进审计表的能力单独导出给宿主层。
 *
 * 为什么不在网关内部做：`@Remote` 方法的耗时只有**分发处**知道 —— 宿主
 * `wechat-host.js#call()` 已经是那条唯一必经之路（它本来就在计时，见 `startedAt`），
 * 在网关里再包一层等于把同一件事做两遍，而且拦不住将来绕过网关直接调的路径。
 * 这里只导出「怎么写」，把「什么时候写」（阈值、是否失败也记）留给宿主。
 */
export { recordOperation, SLOW_OPERATION_MS } from './query/operation-log.ts'
export type { OperationLogEntry, OperationCategory, OperationStatus } from './types.ts'

/**
 * 进程内**受控缓存的运行时占用**（条数/字节/上限）。
 *
 * 给宿主的 worker 内存哨兵用：`[mem]` 那行从此能带上每个缓存的当前/上限，
 * 让「有界缓存真的在界内」从单测事实变成运行时事实，也便于定位 RSS 高的来源。
 */
export { cacheBudgetSnapshot } from './query/cache-budget.ts'
export type { CacheBudgetUsage } from './query/cache-budget.ts'

/**
 * sqlite 连接统计（当前打开数 / 峰值），给 `[mem]` 行做堆外内存归因用：
 * 每条连接至少持有一份页缓存，`external` 异常时可先看是不是连接数出了问题。
 */
export { sqliteConnectionStats } from './sqlite-connection.ts'

/**
 * Register the WeChat data gateway.
 * @param ctx - Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(WechatDataGateway)
}
