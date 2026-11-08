/**
 * 工具循环的有界缓存与参数归一化小工具。
 *
 * 这些函数不依赖模型或数据库，抽出后可单独验证缓存淘汰与 deadline 参数解析。
 * @module query/answer-runtime/tool-loop-cache
 */
import type { CachedToolResult, ToolLoopInput } from './types.ts'

export const MAX_CACHE_ENTRIES = 64

export function safeOp(
  input: ToolLoopInput,
  status: 'ok' | 'fail' | 'skip',
  target: string,
  detail?: string,
): void {
  try {
    input.op?.('task', 'answer_runtime_tool', status, target, detail)
  } catch {
    // 日志失败同样不应中断工具循环。
  }
}

export function rememberResult(
  cache: Map<string, CachedToolResult>,
  order: CachedToolResult[],
  entry: CachedToolResult,
): void {
  cache.set(entry.key, entry)
  order.push(entry)
  while (order.length > MAX_CACHE_ENTRIES) {
    const oldest = order.shift()
    if (oldest) cache.delete(oldest.key)
  }
}

export function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value))
}

/** 允许 0 的整数参数（0 = 关闭对应 deadline）。 */
export function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}
