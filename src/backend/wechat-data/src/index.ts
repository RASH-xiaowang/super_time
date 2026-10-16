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
 * Register the WeChat data gateway.
 * @param ctx - Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(WechatDataGateway)
}
