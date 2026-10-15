// @vitest-environment node
/**
 * W3-2.4：预热泵要**按积压水位分档**，不是固定值。
 *
 * ## 为什么固定值两头不讨好
 *
 * 固定 300ms 的真正问题不是「占时太多」，而是**两种状态下都不合适**：
 *   · 空闲时只剩 3 张要解，却按 300ms 拉满 —— 真空转；
 *   · 紧要时积压几小时的解密，却仍然每拍 300ms —— 让用户干等。
 * 所以改成「先花 100ms 探针读出水位，再按水位决定要不要加时间」。
 *
 * ## 判据怎么量
 *
 * `prewarmBudgetMs` 是纯函数，三条边界 + 一条不变式直接钉：
 *   ① 无积压 ⇒ 不加时间（只留探针那一步）；
 *   ② 有积压 ⇒ 给满上限；
 *   ③ 上限本身有界（500ms = 每 10s 节拍的 5%，不挑战「共享事件循环」这条约束）；
 *   ④ 探针必须 > 0（否则「自适应」退化成「永远用上一拍的陈旧数据」）。
 * 另外钉 pump 的返回体真的带 `backlog`（否则调用方无从分档）。
 */
import { describe, expect, it } from 'vitest'
import { PREWARM_MAX_MS, PREWARM_PROBE_MS, prewarmBudgetMs } from '../src/query/sns-image.ts'

describe('W3-2.4：预热预算按积压水分档', () => {
  it('① 无积压 ⇒ 不加时间（空闲时不该把 300ms 拉满）', () => {
    expect(prewarmBudgetMs(0)).toBe(PREWARM_PROBE_MS)
    expect(prewarmBudgetMs(-1), '负数按无积压处理，别当异常').toBe(PREWARM_PROBE_MS)
    expect(prewarmBudgetMs(Number.NaN), 'NaN 也不能加时间').toBe(PREWARM_PROBE_MS)
  })

  it('② 有积压 ⇒ 给满上限（有人等着，多花的 200ms 能少等一会的解）', () => {
    expect(prewarmBudgetMs(1)).toBe(PREWARM_MAX_MS)
    expect(prewarmBudgetMs(3262)).toBe(PREWARM_MAX_MS)
  })

  it('③ 上界有界：占每 10s 节拍不超过 5%', () => {
    // 同步节拍 SYNC_INTERVAL_MS = 10s；预热最多占 500ms ⇒ 5%。
    expect(PREWARM_MAX_MS).toBeLessThanOrEqual(500)
    expect(PREWARM_MAX_MS / 10_000, '上界再大就开始挑战「共享事件循环」').toBeLessThanOrEqual(0.05)
  })

  it('④ 探针必须 > 0（否则水位永远是陈旧的，自适应名存实亡）', () => {
    expect(PREWARM_PROBE_MS).toBeGreaterThan(0)
    expect(PREWARM_PROBE_MS).toBeLessThan(PREWARM_MAX_MS)
  })

  it('⑤ pump 的返回体带 backlog（调用方按它分档）', async () => {
    // 形状判据：源码里返回体必须含 backlog。真实预热要真 attach 目录 + 密钥，
    // 而这条要钉的只是「接线在不在」。
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/query/sns-image.ts', import.meta.url), 'utf8'))
    expect(src).toMatch(/backlog\?: number/)
    expect(src).toMatch(/backlog: idx\.pending\.length/)
    // 早退分支也要带 backlog：拿不到就分不了档（那条路上会当成 0 ⇒ 不加时间）。
    expect(src).toMatch(/advanced: false, steps: 0, backlog: 0/)
  })
})