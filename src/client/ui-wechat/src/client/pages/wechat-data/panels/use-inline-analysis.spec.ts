// @vitest-environment node
/**
 * 单会话内联分析结果的资源上界。
 *
 * 分析条目包含原文和多条答案；逐条点开长会话时，Map 若不淘汰，会把整段会话的
 * 分析结果一直留在 renderer 里直到切会话。这里钉住「最近写入优先、超过上限淘汰最旧」。
 */
import { describe, expect, it } from 'vitest'
import {
  rememberInlineAnalysis,
  type InlineAnalysisEntry,
} from './use-inline-analysis.ts'

const done = (sourceText: string): InlineAnalysisEntry => ({
  state: 'done',
  answers: [],
  sourceText,
  fromVoice: false,
  inferenceMs: 1,
  cached: false,
})

describe('rememberInlineAnalysis', () => {
  it('超过上限后淘汰最早写入的条目，保留最近的分析结果', () => {
    let entries = new Map<number, InlineAnalysisEntry>()
    entries = rememberInlineAnalysis(entries, 1, done('一'), 3)
    entries = rememberInlineAnalysis(entries, 2, done('二'), 3)
    entries = rememberInlineAnalysis(entries, 3, done('三'), 3)
    entries = rememberInlineAnalysis(entries, 4, done('四'), 3)

    expect(entries.size).toBe(3)
    expect(entries.has(1), '最旧条目没有被淘汰').toBe(false)
    expect([...entries.keys()]).toEqual([2, 3, 4])
  })

  it('再次写入同一条时按最近使用排序，不会额外占一条', () => {
    let entries = new Map<number, InlineAnalysisEntry>()
    entries = rememberInlineAnalysis(entries, 1, done('旧'), 3)
    entries = rememberInlineAnalysis(entries, 2, done('二'), 3)
    entries = rememberInlineAnalysis(entries, 3, done('三'), 3)
    entries = rememberInlineAnalysis(entries, 1, done('新'), 3)
    entries = rememberInlineAnalysis(entries, 4, done('四'), 3)

    expect(entries.size).toBe(3)
    expect(entries.has(2), '刷新第一条后，第二条才应该成为最旧条目').toBe(false)
    const first = entries.get(1)
    expect(first?.state === 'done' ? first.sourceText : '').toBe('新')
    expect([...entries.keys()]).toEqual([3, 1, 4])
  })
})
