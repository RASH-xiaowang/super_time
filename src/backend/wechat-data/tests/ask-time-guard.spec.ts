/**
 * 时间护栏：当范围内没有消息原文、但材料里有统计事实时，不能强迫模型说
 * 「这段时间没有聊天记录」—— 否则会出现「没有记录」紧跟「消息最多的是…」
 * 的自相矛盾回答（2026-11-13 真机复现）。
 */
import { describe, expect, it } from 'vitest'
import { buildTimeGuardRule } from '../src/remotes/ask-runtime-prompt.ts'
import type { AnswerIntentDecision } from '../src/query/answer-runtime/intent.ts'
import type { EvidenceBundle } from '../src/query/answer-runtime/evidence.ts'

function intent(): AnswerIntentDecision {
  return {
    kind: 'aggregate',
    scopeHints: { timeRange: { from: '2026-11-07', to: '2026-11-13' } },
  } as unknown as AnswerIntentDecision
}

function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return { items: [], facts: [], ...over } as unknown as EvidenceBundle
}

describe('buildTimeGuardRule', () => {
  it('范围内有原文命中时按范围陈述', () => {
    const rule = buildTimeGuardRule(intent(), bundle({
      items: [
        { time: '2026-11-08 10:00' },
        { time: '2026-11-09 21:00' },
        { time: '2026-10-01 09:00' },
      ],
    } as unknown as Partial<EvidenceBundle>))
    expect(rule).toContain('2 条落在 2026-11-07 ~ 2026-11-13 内')
  })

  it('没有原文但有统计事实时，禁止说“没有聊天记录”', () => {
    const rule = buildTimeGuardRule(intent(), bundle({
      facts: [{
        title: '按会话统计消息数（2026-11-07 ~ 2026-11-13，全库共 12273 条消息）',
        body: '  1. 某群：3311 条',
      }],
    }))
    expect(rule).toContain('统计事实')
    expect(rule).toContain('不得说「这段时间没有聊天记录」')
    expect(rule).not.toContain('必须先明确说一句')
  })

  it('既没有原文也没有事实时，仍要求明确说明缺口', () => {
    const rule = buildTimeGuardRule(intent(), bundle())
    expect(rule).toContain('没有找到**消息原文**')
    expect(rule).toContain('必须先明确说一句')
    expect(rule).toContain('2026-11-07 ~ 2026-11-13')
  })

  it('没有时间范围时不生成护栏', () => {
    const rule = buildTimeGuardRule(
      { kind: 'open_qa' } as unknown as AnswerIntentDecision,
      bundle(),
    )
    expect(rule).toBe('')
  })
})
