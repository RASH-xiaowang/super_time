/**
 * 内联分析的「让路闸门」守卫（2026-09-29）。
 *
 * ## 为什么要它
 *
 * 真机实测（本次会话里用一段一次性 Playwright 脚本量的：真实 profile 起窗口 → 进「聊天会话」
 * 并点开会话 → 40 秒里每 300ms 打一发轻调用 `getSearchIndexStatus`，再对主进程日志里的慢调用）：
 * 改前一次 `analyzeVisibleMessages` 要 **7.8 秒**，而这段时间后端 worker **完全被它占住** ——
 * 同窗口里打一发本该 2–3 ms 的轻调用，实测等到 **3,523 ms / 3,162 ms**。用户在日志里看到的
 * `getSessions 5.3/9.6s`、`getRemoteImages 1.1s × 13`、`getWordCloud 6.9/9.6s` 全都这么来的。
 * 改后（批次 12→4 + 批次间隔 + 全局单飞）同一实验：**130 个样本全部 ≤29 ms**，
 * `analyzeVisibleMessages` 也不再出现在慢调用榜里。
 *
 * 推理本身是同步 ONNX 调用，**中途没法让出**，所以唯一能做的是"批次之间让路"：
 * 一次只跑一批 + 批次之间留间隔。这个判据抽成了纯函数 {@link deferInlineAnalysis}，
 * 这里用真实数字钉住它，并带一组反例自证（去掉闸门必须判红）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { deferInlineAnalysis } from './use-inline-analysis.ts'

const GAP = 700

describe('内联分析让路闸门', () => {
  it('有分析在飞时：必须推迟，且至少按一个间隔来等', () => {
    const r = deferInlineAnalysis(10_000, true, 0, GAP)
    expect(r.defer, '已在飞还发第二批 = 叠着占 worker').toBe(true)
    expect(r.waitMs).toBe(GAP)
  })

  it('距上一批结束不足一个间隔：推迟剩余的那一点（不丢，只推迟）', () => {
    const r = deferInlineAnalysis(10_000, false, 10_000 - 100, GAP)
    expect(r.defer).toBe(true)
    expect(r.waitMs, '还差 600ms 才够间隔').toBe(600)
  })

  it('刚过间隔：立刻放行（别把正常节奏也拖慢）', () => {
    expect(deferInlineAnalysis(10_000, false, 10_000 - GAP, GAP).defer, '恰好等于间隔应放行').toBe(false)
    expect(deferInlineAnalysis(10_000, false, 10_000 - GAP - 1, GAP).defer).toBe(false)
  })

  it('从没跑过（lastDoneAt=0）：第一次不能因为"间隔"被永远挡住', () => {
    // 真实时刻（如 2026 年的时间戳）减去 0 远大于间隔 ⇒ 放行；这条防的是
    // "把 lastDoneAt 初始化成 Date.now()" 这类改动让首屏分析直接卡死。
    const r = deferInlineAnalysis(1_790_000_000_000, false, 0, GAP)
    expect(r.defer).toBe(false)
  })

  it('反例自证：把在飞状态忽略掉（旧行为）必须能判出来', () => {
    // 旧实现没有任何闸门：在飞时照样发 ⇒ 等价于"defer 恒为 false"。
    // 用当前函数与"旧行为"对比，确认这条判据不是空转。
    const withGate = deferInlineAnalysis(10_000, true, 10_000 - GAP * 10, GAP)
    const withoutGate = { defer: false, waitMs: 0 }
    expect(withGate.defer).not.toBe(withoutGate.defer)
  })
})
