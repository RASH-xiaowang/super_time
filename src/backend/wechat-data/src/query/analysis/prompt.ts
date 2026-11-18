/**
 * 「消息分析」的提示词与输出校验。
 *
 * 一次调用产出一份结构化 JSON。设计上刻意的三件事：
 *
 *  1. **单聊与群聊用不同的问题域**。单聊问「他想要什么、我该怎么回」；
 *     群聊问「这条消息是否针对我、他在群里做什么、我该不该接话」。旧实现把
 *     「对方意图」硬套到群聊，于是「@我 报价多少」会被判成「想确认你的态度」。
 *  2. **输出是 JSON 而不是自由文本**，由 {@link parseAnalysisJson} 严格校验并夹紧：
 *     模型多写一层包裹、少给字段、给出越界枚举值时都降级而不是抛错。
 *  3. **不生成可直接发送的回复**。分析只做研判；「推荐回复」是另一条链路，
 *     两者共用同一个模型但提示词不同，混在一起会让分析滑向写稿。
 *
 * @module query/analysis/prompt
 */
import type {
  MessageAnalysis,
  MessageAnalysisAction,
  MessageAnalysisConfidence,
  MessageAnalysisScope,
} from '../../types-analysis.ts'

/** 单字段字数上限：分析是摘要，不是长文。 */
const HEADLINE_MAX = 120
const LABEL_MAX = 40
const DETAIL_MAX = 300
const SIGNAL_MAX = 80
const EVIDENCE_MAX = 160
const SIGNALS_LIMIT = 3
const EVIDENCE_LIMIT = 3

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 把模型偶尔多写的 ```json 围栏剥掉。 */
function stripFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced === null ? trimmed : (fenced[1] ?? '').trim()
}

/** 从一段文本里取出第一个平衡的 JSON 对象（模型可能前后加解释）。 */
function firstJsonObject(raw: string): string {
  const start = raw.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return ''
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function confidenceOf(value: unknown): MessageAnalysisConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low'
}

function channelOf(value: unknown, scope: MessageAnalysisScope): MessageAnalysisAction['channel'] {
  if (scope === 'private') return 'private'
  return value === 'public' || value === 'private' || value === 'either' ? value : 'either'
}

function stringsOf(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const line = text(item, max)
    if (line !== '') out.push(line)
    if (out.length >= limit) break
  }
  return out
}

/** 解析结果：成功时带上经过夹紧的分析，失败时给一句可展示的原因。 */
export type ParseAnalysisResult =
  | { ok: true; analysis: MessageAnalysis }
  | { ok: false; error: string }

/**
 * 校验并夹紧模型输出。
 *
 * 只保留**能展示的最小充分集**：结论、置信、意图、氛围、动作。缺其中任何一项都算失败——
 * 与其显示半张空卡片，不如让用户看到「模型没给出可用结论」并重试。
 * @param raw - 模型原始输出文本。
 * @param scope - 会话类型，决定是否要求 `addressed`。
 * @param addressedFallback - 群聊专用兜底：模型没给出可用「是否针对我」时，用结构化
 *   `atuserlist` 的已知事实代替。宁可给一个**有据可依**的判断，也不要显示半张卡片。
 * @returns 已夹紧的分析，或失败原因。
 */
export function parseAnalysisJson(
  raw: string,
  scope: MessageAnalysisScope,
  addressedFallback?: { targeted: boolean; reason: string },
): ParseAnalysisResult {
  const body = firstJsonObject(stripFence(String(raw ?? '')))
  if (body === '') return { ok: false, error: '模型没有返回 JSON' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, error: '模型返回的 JSON 无法解析' }
  }
  const root = objectOf(parsed)
  const intent = objectOf(root['intent'])
  const mood = objectOf(root['mood'])
  const action = objectOf(root['action'])
  const addressed = objectOf(root['addressed'])

  const headline = text(root['headline'], HEADLINE_MAX)
  const intentLabel = text(intent['label'], LABEL_MAX)
  const actionTitle = text(action['title'], LABEL_MAX)
  if (headline === '' || intentLabel === '' || actionTitle === '') {
    return { ok: false, error: '模型返回的分析缺少结论、意图或建议动作' }
  }

  const analysis: MessageAnalysis = {
    scope,
    headline,
    confidence: confidenceOf(root['confidence']),
    intent: {
      label: intentLabel,
      detail: text(intent['detail'], DETAIL_MAX),
    },
    mood: {
      label: text(mood['label'], LABEL_MAX) || '不明',
      detail: text(mood['detail'], DETAIL_MAX),
    },
    action: {
      // 只有明确的 false 才算「不必回」；缺字段时按「应该回」处理更保守。
      shouldReply: action['shouldReply'] !== false,
      channel: channelOf(action['channel'], scope),
      title: actionTitle,
      guidance: text(action['guidance'], DETAIL_MAX),
      avoid: text(action['avoid'], DETAIL_MAX),
    },
    signals: stringsOf(root['signals'], SIGNAL_MAX, SIGNALS_LIMIT),
    evidence: stringsOf(root['evidence'], EVIDENCE_MAX, EVIDENCE_LIMIT),
  }
  // 群聊必须回答「是否针对我」——这正是旧实现缺的那一问。
  if (scope === 'group') {
    const reason = text(addressed['reason'], DETAIL_MAX)
    if (typeof addressed['targeted'] === 'boolean' && reason !== '') {
      analysis.addressed = { targeted: addressed['targeted'], reason }
    } else if (addressedFallback !== undefined) {
      analysis.addressed = addressedFallback
    } else {
      return { ok: false, error: '群聊分析缺少「是否针对我」的判断' }
    }
  }
  return { ok: true, analysis }
}

/** 输出格式说明：单聊与群聊共用外壳，字段差异单独说明。 */
function outputSpec(scope: MessageAnalysisScope): string[] {
  const lines = [
    '只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释文字。字段如下：',
    '{',
    '  "headline": "一句话结论，最重要的判断，40 字以内",',
    '  "confidence": "high | medium | low（你对这次判断的把握）",',
    scope === 'private'
      ? '  "intent": { "label": "对方的真实意图，10 字以内", "detail": "为什么这么判断，60 字以内" },'
      : '  "intent": { "label": "这条消息在群里的性质，10 字以内（提问/表态/回应某人/寒暄/转述）", "detail": "为什么这么判断，60 字以内" },',
    '  "mood": { "label": "情绪或氛围，6 字以内", "detail": "依据，40 字以内" },',
    scope === 'private'
      ? '  "action": { "shouldReply": true, "title": "该怎么做，12 字以内", "guidance": "具体怎么说，80 字以内", "avoid": "要避免什么，40 字以内" },'
      : '  "action": { "shouldReply": true, "channel": "public | private | either", "title": "该不该接、怎么接，12 字以内", "guidance": "具体怎么做，80 字以内", "avoid": "要避免什么，40 字以内" },',
    '  "signals": ["关键信号，最多 3 条，每条 20 字以内"],',
    '  "evidence": ["你依据的上下文原话片段，最多 3 条，每条照抄不要改写"]',
    '}',
  ]
  if (scope === 'group') {
    lines.push(
      '另外必须包含（群聊专属）：',
      '"addressed": { "targeted": true 或 false, "reason": "凭什么说针对/不针对我，40 字以内" }',
    )
  }
  return lines
}

/**
 * 组装分析提示词。
 *
 * 上下文行已由调用方带好 `[时间] 发言者：内容`，这里只负责提问与输出约束。
 * @param input - 会话类型、上下文行、被分析的那句、是否群里点了我的名。
 * @returns 可直接作为 user 消息的提示词。
 */
export function buildAnalysisPrompt(input: {
  scope: MessageAnalysisScope
  /** 时间正序的上下文行（已带时间前缀）。 */
  lines: readonly string[]
  /** 被分析的那一条的正文。 */
  targetText: string
  /** 群聊：结构化 @ 列表里是否点名了本机账号。 */
  mentionsMe?: boolean
  /** 群里最近有没有人接话（用于判断这轮对话走向）；可选。 */
  recentSpeakers?: readonly string[]
}): string {
  const group = input.scope === 'group'
  const head = group
    ? '以下是某个微信群最近的对话（时间正序，每行以 [年-月-日 时:分] 开头，格式为「发言者：内容」）。'
    : '以下是微信单聊最近的对话（时间正序，每行以 [年-月-日 时:分] 开头，格式为「发言者：内容」）。'
  const task = group
    ? [
        '请分析【最后一行】这条群消息，重点回答三个问题：',
        '1. 这条消息是不是在找我（@我、引用我的话、接着我的话说、点名我的名字）？',
        '2. 他在群里做的是什么动作（提问、表态、回应某个具体的人、寒暄、转述）？',
        '3. 我该不该接话？如果要接，是直接在群里回，还是更适合私聊？',
      ]
    : [
        '请分析【最后一行】这条对方发来的消息，重点回答三个问题：',
        '1. 他真正想要的是什么（要一个具体答案、想确认态度、只是寒暄……）？',
        '2. 他现在的情绪状态如何？',
        '3. 我该怎么回，才能既解决问题又不引起误会？',
      ]
  return [
    head,
    ...input.lines,
    '',
    '【要分析的那条】',
    input.targetText,
    '',
    ...(group && input.mentionsMe === true
      ? [
          '已确认：这条消息的结构化 @ 列表里点名了你。',
          '',
        ]
      : []),
    ...(group && (input.recentSpeakers?.length ?? 0) > 0
      ? [
          '这一轮里出现过这些发言者：' + (input.recentSpeakers ?? []).join('、') + '。',
          '',
        ]
      : []),
    ...task,
    '',
    ...outputSpec(input.scope),
    '',
    '要求：',
    '· 只依据上面的对话判断，不要编造对话里没有的事实；',
    '· 不确定就降低 confidence，并在文案里说明「信息有限」；',
    '· 说话直接、具体，不要写「建议根据实际情况处理」这类空话；',
    '· 不要输出可直接发送的回复正文，这里只做研判。',
  ].join('\n')
}

/** 群聊分析里「是否针对我」的兜底：模型没答好时用结构化 @ 反推。 */
export function fallbackAddressed(
  mentionsMe: boolean,
  talkerName: string,
): { targeted: boolean; reason: string } {
  return mentionsMe
    ? { targeted: true, reason: '结构化 @ 列表里点名了你' }
    : { targeted: false, reason: '结构化 @ 列表里没有你，正文也未点名「' + talkerName + '」' }
}
