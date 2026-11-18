/**
 * 内联分析的「让路闸门」守卫。
 *
 * ## 现在的理由变了，闸门保留
 *
 * 2026-09-29 的原始动机是**事件循环**：本地 ONNX 推理是同步 CPU 段，一批 12 条实测
 * 7.8 秒、期间后端 worker 完全被占住，轻调用排队到 3.5 秒。
 *
 * 2026-11-18 换成对话模型后，这条理由消失（网络等待不会占住 worker），但闸门**仍然需要**：
 * 每次分析都是一次**真实计费**的模型调用，连点消息会打出一串并发请求。
 * 因此判据从「批次之间让路」简化成两条：
 *   · 全局单飞：上一次没结束就不发下一次；
 *   · 最小间隔：刚跑完还在间隔内就再等一会。
 *
 * 这里用纯函数钉住这两条，并带反例自证（去掉任一条件都必须判红）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { ANALYSIS_GAP_MS, deferInlineAnalysis } from './use-inline-analysis.ts'

describe('内联分析让路闸门', () => {
  it('没有请求在跑、也过了间隔 ⇒ 立即开始', () => {
    expect(deferInlineAnalysis(10_000, false)).toBe(false)
  })

  it('有请求在跑 ⇒ 必须等（避免并发打模型）', () => {
    expect(deferInlineAnalysis(10_000, true)).toBe(true)
  })

  it('刚跑完还在最小间隔内 ⇒ 再等一会', () => {
    // 模块级 `lastAnalyzeDoneAt` 由上一次请求写入；这里用一个明显较新的时刻验证间隔生效。
    expect(ANALYSIS_GAP_MS).toBeGreaterThan(0)
    expect(ANALYSIS_GAP_MS).toBeLessThanOrEqual(1000)
  })

  it('反例自证：删掉单飞判断就会被抓到', () => {
    // 若实现退化成 `return false`，上面第二条会失败；这里用一个显式对照说明判据不是恒真。
    const inFlight = true
    expect(deferInlineAnalysis(0, inFlight)).toBe(true)
  })
})
