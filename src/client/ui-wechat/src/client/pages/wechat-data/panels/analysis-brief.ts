/**
 * 把 laya 的六项概率读数整理成用户可以直接行动的分析简报。
 *
 * 模型输出是「意图选项 / 是否不悦 / 紧张度 / 建议动作」等彼此独立的概率，
 * 直接铺给用户会显得像六道问卷。这里不改模型结果，只做**确定性的归纳与措辞收敛**：
 *   · 先给一句需要小心的结论；
 *   · 再给意图、情绪、建议动作三条主线；
 *   · 原始概率仍由调用方放在「底层判断」里，保留可追溯性。
 *
 * 因此这里的文案必须保持「倾向 / 可能」语气，不能把概率写成事实。
 */
import type { LayaAnswer, LayaAnswerOption } from '@deepseek-ai/dsh-wechat-data/types'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'

type DoneEntry = Extract<InlineAnalysisEntry, { state: 'done' }>

export interface AnalysisBriefChoice {
  key: string
  label: string
  probability: number
}

export interface AnalysisBriefSignal {
  qid: string
  label: string
  probability: number
  detail: string
}

export interface AnalysisBrief {
  headline: string
  confidenceLabel: string
  confidenceTone: 'high' | 'medium' | 'low'
  intent: {
    primary: AnalysisBriefChoice
    alternative?: AnalysisBriefChoice
  }
  mood: {
    label: string
    detail: string
    upsetProbability: number
    tension: number
    tensionScale: number
  }
  action: {
    key: string
    title: string
    probability: number
    guidance: string
    avoid: string
  }
  signals: AnalysisBriefSignal[]
}

const INTENT_LABELS: Record<string, string> = {
  care_check: '想确认你的态度',
  memory_test: '在确认你是否记得',
  want_fight: '带有冲突或施压意味',
  keep_talking: '想把对话继续下去',
}

const ACTION_COPY: Record<string, { title: string; guidance: string; avoid: string }> = {
  search_history: {
    title: '先查上下文，再回应',
    guidance: '先确认之前聊过什么，再针对事实回答，避免凭印象接话。',
    avoid: '不要在没弄清原委时猜答案。',
  },
  answer_directly: {
    title: '直接回答具体内容',
    guidance: '对方问的是具体信息，先把事实、结论或明确答复说清楚。',
    avoid: '不要绕开问题，也不要用客套话替代答案。',
  },
  admit_and_apologize: {
    title: '先承认遗漏，再补答',
    guidance: '如果确实忘了或漏了，先承认并道歉，再继续说明后续安排。',
    avoid: '不要硬撑，也不要把问题反推给对方。',
  },
  ask_back: {
    title: '先澄清一句，再回答',
    guidance: '用一句具体问题缩小范围，确认对方指的是哪件事或哪句话。',
    avoid: '不要连续追问，容易让对方觉得被审问。',
  },
  change_topic: {
    title: '先缓和，再自然换话题',
    guidance: '先接住当前情绪，再自然过渡到对方更容易接受的下一件事。',
    avoid: '不要在对方情绪明显时生硬岔开。',
  },
  play_dumb: {
    title: '暂缓回应，但给明确信号',
    guidance: '先给自己一点整理时间，同时告诉对方稍后再答复，不要直接消失。',
    avoid: '不要把沉默当成解决方案。',
  },
}

const GENERIC_ACTION = {
  title: '先接住原话，再回应',
  guidance: '先复述你理解到的重点，再给出明确答复，减少双方继续猜的空间。',
  avoid: '不要在没确认前替对方下结论。',
}

function findAnswer(answers: readonly LayaAnswer[], qid: string): LayaAnswer | undefined {
  return answers.find((answer) => answer.qid === qid)
}

function topChoice(answer: LayaAnswer | undefined, index = 0): LayaAnswerOption | undefined {
  return answer?.options[index]
}

function intentLabel(option: LayaAnswerOption | undefined): string {
  if (option === undefined) return '意图不够明确'
  return INTENT_LABELS[option.key] ?? option.label
}

function temperatureOf(score: number): { label: string; detail: string } {
  if (score < 2.5) return { label: '轻松', detail: '整体语气平稳，可以按字面自然回应。' }
  if (score < 4.5) return { label: '平稳', detail: '暂未看到明显冲突信号，保持正常回应即可。' }
  if (score < 6) return { label: '略有张力', detail: '对方可能在等一个明确回应，避免敷衍带过。' }
  if (score < 7.5) return { label: '偏紧张', detail: '局势已经开始收紧，先确认重点再回答。' }
  if (score < 8.8) return { label: '紧张', detail: '回应不当容易升级，先处理情绪再处理事实。' }
  return { label: '高压', detail: '对方情绪或期待很强，建议先承接感受，再给明确答复。' }
}

function confidenceOf(entry: DoneEntry, intentProbability: number): {
  label: string
  tone: 'high' | 'medium' | 'low'
} {
  if (entry.lowConfidence === true) return { label: '信息有限', tone: 'low' }
  if (intentProbability >= 0.6) return { label: '倾向较明显', tone: 'high' }
  if (intentProbability >= 0.45) return { label: '中等倾向', tone: 'medium' }
  return { label: '信号偏弱', tone: 'low' }
}

function buildHeadline(input: {
  lowConfidence: boolean
  intentKey: string
  intentText: string
  upsetProbability: number
  tension: number
  testingProbability: number
  literalProbability: number
}): string {
  if (input.lowConfidence) return '单看这句话，信息还不够明确。先用一句澄清确认，再决定怎么回。'
  if (input.intentKey === 'want_fight' || (input.upsetProbability >= 0.65 && input.tension >= 6)) {
    return '对方有明显不悦或施压迹象。先回应情绪，再处理具体问题。'
  }
  if (input.intentKey === 'memory_test' || input.testingProbability >= 0.6) {
    return '对方更像是在确认你是否记得，重点不是获取一条新信息。'
  }
  if (input.intentKey === 'care_check' || (input.literalProbability < 0.45 && input.upsetProbability >= 0.45)) {
    return '这句话更像是在确认你的态度，事实答案之外还需要情感回应。'
  }
  if (input.intentKey === 'keep_talking') {
    return '对方更可能是在延续对话，不必把这句话当成一次考验。'
  }
  return `对方可能在${input.intentText}，建议先接住原话再回应。`
}

/**
 * 构造可直接展示的分析简报。
 * @param entry - 已成功完成的单条分析。
 * @returns 归纳后的意图、情绪、动作与底层信号。
 */
export function buildAnalysisBrief(entry: DoneEntry): AnalysisBrief {
  const intentAnswer = findAnswer(entry.answers, 'real_intent')
  const actionAnswer = findAnswer(entry.answers, 'best_action')
  const tensionAnswer = findAnswer(entry.answers, 'tension')
  const upsetAnswer = findAnswer(entry.answers, 'is_upset')
  const testingAnswer = findAnswer(entry.answers, 'is_testing')
  const literalAnswer = findAnswer(entry.answers, 'literal_question')

  const primaryIntent = topChoice(intentAnswer)
  const alternativeIntent = topChoice(intentAnswer, 1)
  const primaryAction = topChoice(actionAnswer)
  const tension = Number(tensionAnswer?.score ?? 0)
  const tensionScale = Number(tensionAnswer?.scale ?? 10)
  const upsetProbability = Number(upsetAnswer?.yes ?? 0)
  const testingProbability = Number(testingAnswer?.yes ?? 0)
  const literalProbability = Number(literalAnswer?.yes ?? 0)
  const intentText = intentLabel(primaryIntent)
  const temperature = temperatureOf(tension)
  const confidence = confidenceOf(entry, primaryIntent?.probability ?? 0)
  const action = ACTION_COPY[primaryAction?.key ?? ''] ?? GENERIC_ACTION

  const moodDetail = upsetProbability >= 0.65
    ? `不稳定信号较明显（${Math.round(upsetProbability * 100)}%），先回应感受更稳妥。`
    : temperature.detail

  const signals: AnalysisBriefSignal[] = [
    { qid: 'literal_question', label: '字面提问', answer: literalAnswer },
    { qid: 'is_testing', label: '确认记性', answer: testingAnswer },
    { qid: 'is_upset', label: '不悦信号', answer: upsetAnswer },
  ].flatMap(({ qid, label, answer }) => {
    if (answer === undefined) return []
    const option = topChoice(answer)
    return [{
      qid,
      label,
      probability: option?.probability ?? 0,
      detail: option?.label ?? '',
    }]
  })

  return {
    headline: buildHeadline({
      lowConfidence: entry.lowConfidence === true,
      intentKey: primaryIntent?.key ?? '',
      intentText,
      upsetProbability,
      tension,
      testingProbability,
      literalProbability,
    }),
    confidenceLabel: confidence.label,
    confidenceTone: confidence.tone,
    intent: {
      primary: {
        key: primaryIntent?.key ?? '',
        label: intentText,
        probability: primaryIntent?.probability ?? 0,
      },
      ...(alternativeIntent === undefined
        ? {}
        : {
            alternative: {
              key: alternativeIntent.key,
              label: intentLabel(alternativeIntent),
              probability: alternativeIntent.probability,
            },
          }),
    },
    mood: {
      label: temperature.label,
      detail: moodDetail,
      upsetProbability,
      tension,
      tensionScale,
    },
    action: {
      key: primaryAction?.key ?? '',
      title: action.title,
      probability: primaryAction?.probability ?? 0,
      guidance: action.guidance,
      avoid: action.avoid,
    },
    signals,
  }
}
