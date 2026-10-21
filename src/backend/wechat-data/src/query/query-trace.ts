/**
 * 首屏查询分段打点（`SUPERTIME_QUERY_TRACE=1` 门控，默认零开销）。
 *
 * 为什么需要：`getOverview`（约 350–460ms）与 `getOverviewInsights`（约 450–500ms）
 * 是首屏剩下的两笔最大 CPU 成本，但二者都是一个 `@Remote` 方法一个总时长，
 * 已经排除了「缓存打穿」这个解释（全局 8MB 页缓存实验对它们无效果），
 * 下一步必须知道**钱花在哪一段**（联系人表、消息分片扫描、朋友圈整表游标、
 * DB 目录遍历……）。这里只打时间戳，不做任何业务动作，是定位而不是优化。
 *
 * 用法：设 `SUPERTIME_QUERY_TRACE=1` 起应用，日志里会出现
 *   `[query-trace] overview.contacts t=12`
 * （`t` 是本次查询从 begin 起的毫秒数；同名查询每次 begin 重置计时。）
 */
const ENABLED = process.env.SUPERTIME_QUERY_TRACE === '1'

/** 当前正在计时的查询起点（每个查询串行执行，单槽位足够）。 */
let startedAt = 0

/**
 * 开始一次查询的分段计时。
 * @param name - 查询名（`overview` / `insights`）。
 */
export function queryTraceBegin(name: string): void {
  if (!ENABLED) return
  startedAt = Date.now()
  try {
    console.log('[query-trace] ' + name + '.begin t=0')
  } catch { /* 打点失败绝不影响查询 */ }
}

/**
 * 打一条查询分段。
 * @param name - 查询名（与 begin 一致）。
 * @param label - 阶段名（固定词表，便于日志侧统计）。
 * @param n - 可选计数（行数/条目数），用于判断「慢在量上还是常数开销」。
 */
export function queryTraceMark(name: string, label: string, n = 0): void {
  if (!ENABLED) return
  try {
    console.log('[query-trace] ' + name + '.' + label + ' t=' + String(Date.now() - startedAt) + (n > 0 ? ' n=' + String(n) : ''))
  } catch { /* 打点失败绝不影响查询 */ }
}
