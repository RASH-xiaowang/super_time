/**
 * AI 回复扫描的汇总留痕。
 *
 * 每一拍扫描只写一条操作日志，且必须「有事实才写」：后台每 10 秒一拍、
 * 会话一多就会把操作日志刷成噪音。这里按 detail 文本做 10 分钟去重，
 * 只记录计数与原因码，**不记录会话正文、模型输出或错误原文**。
 */

/** 同一份汇总 10 分钟内只落一次。 */
export const CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS = 10 * 60_000

const lastWritten = new Map<string, number>()

/**
 * 判断这份汇总现在该不该写。
 *
 * `now` 可注入，便于测试确定性；生产使用真实时钟。
 */
export function shouldWriteChatAiReplyScanReport(
  detail: string,
  now: number = Date.now(),
): boolean {
  const previous = lastWritten.get(detail)
  if (previous !== undefined && now - previous < CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS) {
    return false
  }
  lastWritten.set(detail, now)
  // 汇总种类有限；顺手清理过期键，避免长时间运行时无限增长。
  if (lastWritten.size > 64) {
    for (const [key, at] of lastWritten) {
      if (now - at >= CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS) lastWritten.delete(key)
    }
  }
  return true
}

/** 仅用于测试：清空去重记忆。 */
export function resetChatAiReplyScanReportDedupe(): void {
  lastWritten.clear()
}

/**
 * 把一次扫描里的事件计数拼成稳定的原因串。
 *
 * 顺序固定，保证同一组事实总得到同一段文本（去重才有意义）。
 */
export function formatChatAiReplyScanDetail(
  counts: Readonly<Record<string, number>>,
): string {
  const order = [
    'queued',
    'replied',
    'resumed',
    'lease_miss',
    'control_changed',
    'stale_closed',
    'coalesced',
    'cancelled',
    'skipped',
  ] as const
  const parts: string[] = []
  for (const key of order) {
    const value = counts[key] ?? 0
    if (value > 0) parts.push(key + '=' + String(value))
  }
  for (const key of Object.keys(counts)) {
    if ((order as readonly string[]).includes(key)) continue
    const value = counts[key] ?? 0
    if (value > 0) parts.push(key + '=' + String(value))
  }
  return parts.join(' ')
}
