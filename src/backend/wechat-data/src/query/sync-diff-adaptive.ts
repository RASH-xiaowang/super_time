/**
 * page-diff 的自适应止损状态（2026-10-18）。
 *
 * 真机日志里检查点的 page-diff 几乎必被 quick_check 拒绝：每次白扫全量页指纹
 * （92MB 实测 88ms）+ staging 拷贝/补丁/校验，然后还是整库重解。连续失败 2 次后
 * 5 分钟内不再尝试（到期再探一次，确认根因是否已修复）；抑制期间 full 之后也不再
 * 重扫全量指纹。键是快照**绝对路径**，测试之间互不串状态。
 */
const streak = new Map<string, number>()
const probeAfter = new Map<string, number>()
const DISABLE_AFTER = 2
export const DIFF_RETRY_AFTER_MS = 5 * 60_000

/** 该快照现在还要不要尝试 page-diff（抑制期内 false）。 */
export function pageDiffSuppressed(target: string): boolean {
  return (probeAfter.get(target) ?? 0) > Date.now()
}

/**
 * 记录一次 page-diff 被拒。
 * @returns 本次是否刚跨过阈值进入抑制期（true 时调用方补一条日志即可，避免刷屏）。
 */
export function notePageDiffRejected(target: string): boolean {
  const n = (streak.get(target) ?? 0) + 1
  streak.set(target, n)
  if (n < DISABLE_AFTER || pageDiffSuppressed(target)) return false
  probeAfter.set(target, Date.now() + DIFF_RETRY_AFTER_MS)
  return true
}

/** page-diff 成功（或已能稳定走通）：清空抑制状态，重新参与判定。 */
export function notePageDiffSuccess(target: string): void {
  streak.delete(target)
  probeAfter.delete(target)
}
