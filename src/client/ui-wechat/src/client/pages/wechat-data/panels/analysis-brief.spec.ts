/**
 * 分析简报的产品口径：
 *   · 概率不是事实，短文本必须先降级；
 *   · 情绪紧张与「考验记性」要能把结论带到前台；
 *   · 建议动作必须同时给做法和要避免的事，而不是只复述模型选项。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { LayaAnswer, LayaAnswerOption } from '@deepseek-ai/dsh-wechat-data/types'
import { buildAnalysisBrief } from './analysis-brief.ts'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'

type DoneEntry = Extract<InlineAnalysisEntry, { state: 'done' }>

function choice(qid: string, options: Array<[string, string, number]>): LayaAnswer {
  const sorted: LayaAnswerOption[] = options
    .map(([key, label, probability]) => ({ key, label, probability }))
    .sort((a, b) => b.probability - a.probability)
  return {
    qid, kind: 'choice', question: qid, options: sorted,
    top: sorted[0]?.key ?? '', topProbability: sorted[0]?.probability ?? 0,
    confidence: 0.5,
  }
}

function noul(qid: string, yes: number): LayaAnswer {
  const options: LayaAnswerOption[] = [
    { key: 'false', label: '不是', probability: 1 - yes },
    { key: 'true', label: '是', probability: yes },
  ].sort((a, b) => b.probability - a.probability)
  return {
    qid, kind: 'noul', question: qid, options,
    top: options[0]?.key ?? '', topProbability: options[0]?.probability ?? 0,
    yes, confidence: 0.5,
  }
}

function score(qid: string, value: number): LayaAnswer {
  return {
    qid, kind: 'score', question: qid, options: [], top: String(Math.round(value)),
    topProbability: 0.3, score: value, scale: 10, confidence: 0.4,
  }
}

function entry(answers: LayaAnswer[], lowConfidence = false): DoneEntry {
  return {
    state: 'done', answers, sourceText: '你是不是忘了？', fromVoice: false,
    inferenceMs: 812, cached: false, ...(lowConfidence ? { lowConfidence: true } : {}),
  }
}

describe('buildAnalysisBrief', () => {
  it('高概率「考验记性」会把结论落到记忆确认，而不是按字面问题回答', () => {
    const brief = buildAnalysisBrief(entry([
      noul('literal_question', 0.22),
      noul('is_testing', 0.78),
      noul('is_upset', 0.32),
      choice('real_intent', [
        ['memory_test', '单纯考验对方的记忆力', 0.66],
        ['care_check', '想确认对方在不在乎自己', 0.18],
      ]),
      score('tension', 4.2),
      choice('best_action', [
        ['admit_and_apologize', '先承认自己忘了并道歉，再往下说', 0.61],
        ['search_history', '先搜索历史聊天记录，确认对方之前说过什么', 0.19],
      ]),
    ]))

    expect(brief.headline).toContain('确认你是否记得')
    expect(brief.intent.primary.label).toBe('在确认你是否记得')
    expect(brief.action.title).toBe('先承认遗漏，再补答')
    expect(brief.action.avoid).toContain('不要硬撑')
    expect(brief.confidenceTone).toBe('high')
  })

  it('高不悦且高紧张时优先提示处理情绪', () => {
    const brief = buildAnalysisBrief(entry([
      noul('literal_question', 0.7),
      noul('is_testing', 0.3),
      noul('is_upset', 0.82),
      choice('real_intent', [
        ['want_fight', '生气，想吵架', 0.58],
        ['keep_talking', '只是想把话聊下去，没有别的目的', 0.2],
      ]),
      score('tension', 8.1),
      choice('best_action', [
        ['ask_back', '反问回去，让对方先提示', 0.4],
        ['change_topic', '转移话题', 0.25],
      ]),
    ]))

    expect(brief.headline).toContain('先回应情绪')
    expect(brief.mood.label).toBe('紧张')
    expect(brief.mood.upsetProbability).toBeCloseTo(0.82)
    expect(brief.action.guidance).toContain('缩小范围')
  })

  it('短消息一律标为信息有限，不输出确定口吻', () => {
    const brief = buildAnalysisBrief(entry([
      noul('literal_question', 0.5),
      noul('is_testing', 0.5),
      noul('is_upset', 0.5),
      choice('real_intent', [['care_check', '想确认对方在不在乎自己', 0.9]]),
      score('tension', 9),
      choice('best_action', [['play_dumb', '先不回，等对方再说', 0.9]]),
    ], true))

    expect(brief.confidenceLabel).toBe('信息有限')
    expect(brief.confidenceTone).toBe('low')
    expect(brief.headline).toContain('先用一句澄清确认')
  })

  it('缺少动作答案时给出保守兜底，不渲染空卡片', () => {
    const brief = buildAnalysisBrief(entry([
      noul('is_upset', 0.2),
      choice('real_intent', [['keep_talking', '只是想把话聊下去，没有别的目的', 0.48]]),
      score('tension', 2.1),
    ]))

    expect(brief.action.title).toBe('先接住原话，再回应')
    expect(brief.action.probability).toBe(0)
    expect(brief.signals).toHaveLength(1)
    expect(brief.headline).toContain('延续对话')
  })
})
