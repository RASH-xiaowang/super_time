/**
 * 任务中心的纯数据清洗工具。
 *
 * 这些函数既不读库也不依赖运行时状态，抽出来可避免任务中心主文件继续膨胀，
 * 同时保持 `task-center.ts` 的既有导出面不变。
 */

/** 一次批量删除最多处理多少条；超过时整单拒绝，避免静默只删一部分。 */
export const TASK_BATCH_DELETE_MAX = 500

/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
export function taskErrorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

export function taskCellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

export function taskCellNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 整数夹取（非数字按 fallback，其余夹到 [min, max]）。 */
export function clampTaskInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 清洗批量删除 id：只保留唯一正整数，并拒绝空选择和过大批次。
 *
 * Remote 入参来自序列化 JSON，不能只靠 TypeScript 类型；重复 id 去重后返回，
 * 超过上限时整单拒绝而不是截断 —— 用户勾了 501 条却只删 500 条更难排查。
 */
export function cleanTaskBatchIds(
  raw: unknown,
  max = TASK_BATCH_DELETE_MAX,
): { ids: number[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ids: [], error: '请至少选择一条记录' }
  const ids: number[] = []
  const seen = new Set<number>()
  for (const value of raw) {
    const id = Math.trunc(Number(value))
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) return { ids: [], error: '请至少选择一条有效记录' }
  if (ids.length > max) {
    return { ids: [], error: '一次最多删除 ' + String(max) + ' 条，请分批操作' }
  }
  return { ids }
}
