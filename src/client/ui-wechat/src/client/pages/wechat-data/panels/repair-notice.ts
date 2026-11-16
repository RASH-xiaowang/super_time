/**
 * 「修复损坏的库」结果 → 一句用户能直接读懂的话。
 *
 * 为什么单独成模块：后端 `DbRepairResult` 有六种不同的失败面（任务占用、配置类错误、
 * 重解密失败、复检仍坏、原始库缺失、`ok:false`），而面板此前只按 `found` 分支 ——
 * 于是 `{ found: 0, error: '已有解密任务进行中' }` 会被说成「体检没有发现损坏的库」，
 * `ok:false` 也照样报「修复完成」。判定是纯逻辑，放在这里才能用表驱动单测把每一格钉住；
 * `health-actions.ts` 的 `repair()` 只负责把这里的返回值交给提示条。
 */
import type { DbRepairResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 「原始库缺失」的补充说明；没有这一类时不出现。 */
function unrepairableNote(r: DbRepairResult): string {
  return r.unrepairable.length > 0 ? `，修不了 ${String(r.unrepairable.length)} 个（原始库缺失）` : ''
}

/**
 * 把修复结果翻成提示语。判定顺序即优先级，前面命中就返回：
 *   ① 后端在开跑前就拒绝了（任务占用 / 配置错误）—— 它和「没坏」是两件事；
 *   ② 重解密这一步就失败 —— 给出首个文件与原因，用户才知道下一步做什么；
 *   ③ 确实一个都没坏 —— 只有既无 error 又无 failed 才允许说这句话；
 *   ④ 复检仍坏或 `ok:false` —— 如实报「原来坏几个、恢复几个、还剩几个」；
 *   ⑤ 其余才是真正的「修复完成」。
 * @param r - 后端 `repairCorruptDbs` 的返回值。
 * @returns 可直接展示给用户的单句提示。
 */
export function repairNotice(r: DbRepairResult): string {
  if (r.error) {
    // 同步/解密任务占用是高频且可自愈的：别把后端的长错误原样倒给用户。
    return /进行中|已有解密任务/.test(r.error)
      ? '已有解密任务进行中，请稍后再试'
      : `修复未完成：${r.error}`
  }
  const firstFailed = r.failed[0]
  if (firstFailed !== undefined) {
    return `修复未完成：${String(r.found)} 个损坏中恢复 ${String(r.repaired)} 个，${String(r.failed.length)} 个重解密失败（首个：${firstFailed.db}：${firstFailed.error}）`
  }
  // 没有任何 error / failed 时才允许说「没坏」。任务占用那一格曾经就是在这里被误报的。
  if (r.found === 0) return '体检没有发现损坏的库，无需修复'
  if (r.ok === false || r.stillCorrupted.length > 0) {
    return `修复未完成：${String(r.found)} 个损坏中恢复 ${String(r.repaired)} 个，仍坏 ${String(r.stillCorrupted.length)} 个${unrepairableNote(r)}`
  }
  return `修复完成：${String(r.found)} 个损坏中恢复 ${String(r.repaired)} 个${unrepairableNote(r)}`
}
