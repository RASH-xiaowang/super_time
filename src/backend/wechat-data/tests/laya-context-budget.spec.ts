/**
 * 上下文字数预算的守卫（2026-09-29）。
 *
 * ## 为什么需要
 *
 * 真机量的延迟曲线：单次 `layaAnalyze` ≈ **10 ms/字**（120 字 1,610 ms / 240 字 2,428 ms /
 * 480 字 4,598 ms / 720 字 7,228 ms）。而上下文原先只按**条数**限（20 条）—— 长短消息能差 10 倍，
 * 于是同一屏里有的推理 1 s、有的 12 s，用户看到的就是 `analyzeVisibleMessages 7–24s`。
 * `budgetDialogue` 把上下文按**字数**裁到预算内，这里用真实数字钉住它的三条性质：
 * 尾部必须留住、头部的旧消息先丢、最后一行（正在分析的那条）永不丢。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { budgetDialogue, MAX_CONTEXT_CHARS } from '../src/laya/analysis.ts'

/** 造一行 `对方：…`，长度可控。 */
function line (chars: number, tag = '对方'): string {
  return `${tag}：` + '字'.repeat(Math.max(0, chars - 3))
}

describe('对话上下文字数预算', () => {
  it('预算内：原样返回（不许无故裁剪）', () => {
    const lines = [line(20), line(20), line(20)]
    expect(budgetDialogue(lines, 240)).toBe(lines.join('\n'))
  })

  it('超预算：**从最旧的丢**，尾部（语义焦点）必须留住', () => {
    // ⚠️ 每一行都必须**唯一**：两行文本一样的话 `includes` 会被后面那行命中，
    // 断言就变成永远为真（第一版就踩了这个，等于判据空转）。
    const lines = [
      line(100, '对方') + '①', line(100, '我') + '②', line(100, '对方') + '③', line(100, '我') + '④',
    ]
    const out = budgetDialogue(lines, 240)
    expect(out.endsWith(lines[3] ?? ''), '最后一行必须在').toBe(true)
    expect(out.includes(lines[0] ?? ''), '最旧那行应当被丢掉').toBe(false)
  })

  it('最后一行（正在分析的消息）即使自己就超预算也永不丢', () => {
    const lines = [line(10), line(500)]
    const out = budgetDialogue(lines, 240)
    expect(out).toBe(lines[1])
  })

  it('默认预算就是 MAX_CONTEXT_CHARS：240 字上下文的推理实测 ≈2.4 s', () => {
    const lines = Array.from({ length: 20 }, () => line(60))
    const out = budgetDialogue(lines)
    // 允许最后一行微微超出（整行保留），但总量必须远小于原来的 20×60=1200+ 字
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 70)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('空输入返回空串（调用方原样走「没有可分析的文本」分支）', () => {
    expect(budgetDialogue([], 240)).toBe('')
  })

  it('反例自证：不设预算（旧行为 = 全量拼接）长度为 1200+，就是被修掉的那种请求', () => {
    const lines = Array.from({ length: 20 }, () => line(60))
    const unbudgeted = lines.join('\n')
    expect(unbudgeted.length).toBeGreaterThan(1200)
    expect(budgetDialogue(lines).length, '带上预算必须明显更短').toBeLessThan(unbudgeted.length / 4)
  })
})
