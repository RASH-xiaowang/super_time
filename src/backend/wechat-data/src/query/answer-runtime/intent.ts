/**
 * Answer runtime v2 的统一意图识别。
 *
 * 这一层不替代 `query/retrieval/intent.ts`：旧分类器继续服务检索流水线，
 * 这里把它映射成更适合「工具调用 + 多轮上下文」的统一意图，并补上旧分类器
 * 没有表达的范围线索：会话、联系人、时间、消息序号、媒体类型、聚合维度。
 *
 * 设计约束：
 * 1. 规则分类是默认路径，零网络、可离线、可单测；
 * 2. LLM 只是注入式补充，未注入时不依赖模型；
 * 3. LLM 不得覆盖规则已经高置信识别的明确问法，只能补字段或修正低置信结果；
 * 4. 每个结论都带 reason / confidence / toolHints，可直接写入 AnswerTrace。
 *
 * @module query/answer-runtime/intent
 */
import type { IntentKind } from '../retrieval/types.ts'
import {
  RECENCY_RE,
  classifyIntent as classifyLegacyIntent,
} from '../retrieval/intent.ts'
import { normalizeQuestion, resolveRelativeDate } from '../retrieval/rewrite.ts'
import { ENTITY_ATTR_RE, toolHintsFor } from './intent-tool-hints.ts'
import {
  resolveAnchoredRecentDateRange,
  resolveExplicitDateRange,
  resolveRecentDateRange,
  strictIsoDay,
} from './explicit-time-range.ts'

/** 统一回答意图。 */
export type AnswerIntentKind =
  | 'lookup'
  | 'aggregate'
  | 'relation'
  | 'timeline'
  | 'content_media'
  | 'open_qa'
  | 'clarify'

/** 兼容更短的领域命名。 */
export type AnswerIntent = AnswerIntentKind

/** 所有统一意图，供 LLM 输出校验与外部枚举。 */
export const ANSWER_INTENT_KINDS: readonly AnswerIntentKind[] = [
  'lookup',
  'aggregate',
  'relation',
  'timeline',
  'content_media',
  'open_qa',
  'clarify',
]

/** 媒体类型。 */
export type AnswerMediaType = 'image' | 'video' | 'file' | 'voice' | 'link' | 'sticker' | 'other'

/** 聚合维度。 */
export type AnswerAggregationDimension =
  | 'count'
  | 'sum'
  | 'average'
  | 'ranking'
  | 'distinct'
  | 'group_by_session'
  | 'group_by_contact'
  | 'group_by_time'
  | 'group_by_keyword'
  | 'compare'

/** 时间粒度。 */
export type AnswerTimeGranularity = 'day' | 'week' | 'month' | 'year' | 'range' | 'unknown'

/** 时间范围的来源。 */
export type AnswerTimeSource = 'explicit' | 'inherited' | 'progression' | 'llm'

/** 结构化时间范围。 */
export interface AnswerTimeRange {
  from: string
  to: string
  granularity: AnswerTimeGranularity
  source: AnswerTimeSource
  label: string
}

/** 历史消息的最小形状（与 Ask / ClawBot 的 history 对齐）。 */
export interface AnswerHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 从上一轮 trace / thread state 继承的上下文。 */
export interface AnswerIntentContext {
  activeSession?: string
  activeContact?: string
  lastTimeRange?: AnswerTimeRange | { from: string; to: string }
  lastEntity?: string
  lastReferencedMessage?: string
  lastIntent?: AnswerIntentKind
}

/** 场景允许的扩展分类选项（精确入口所需字段仍可直接传）。 */
export interface ClassifyAnswerIntentOptions {
  knownEntities?: string[]
  now?: Date
  history?: ReadonlyArray<AnswerHistoryMessage>
  /** 当前会话 username；用于解析「这个群 / 当前会话」。 */
  currentSession?: string
  /** 已知会话名或 username，用于显式会话点名。 */
  knownSessions?: string[]
  /** 已知联系人名。 */
  knownContacts?: string[]
  /** 上一轮结构化上下文。 */
  context?: AnswerIntentContext
  /** 预置的 LLM 建议；运行时异步拿到后可用 `applyAnswerIntentSuggestion` 合并。 */
  llmSuggestion?: AnswerIntentLlmSuggestion
  /** 规则置信度低于该值时才采纳 LLM 的意图覆盖；默认 0.72。 */
  llmOverrideThreshold?: number
}

/** 兼容别名。 */
export type AnswerIntentOptions = ClassifyAnswerIntentOptions

/** 消息引用提示。 */
export interface AnswerMessageReference {
  kind: 'ordinal' | 'latest' | 'previous' | 'contextual' | 'media'
  ordinal?: number
  fromEnd?: boolean
  mediaTypes?: AnswerMediaType[]
  session?: string
  explicit: boolean
  reason: string
}

/** 主运行时可直接消费的范围提示。 */
export interface AnswerScopeHints {
  session?: string
  contact?: string
  from?: string
  to?: string
  media?: AnswerMediaType
  ordinal?: number
  /** `session` 未解析但用户明确指当前会话时使用。 */
  sessionRef?: 'current'
  mediaTypes?: AnswerMediaType[]
  messageRef?: AnswerMessageReference
  timeRange?: AnswerTimeRange
  aggregationDimensions?: AnswerAggregationDimension[]
  relationTargets?: string[]
  entities?: string[]
}

/** 用户显式重述的范围字段。 */
export type AnswerScopeField =
  | 'session'
  | 'contact'
  | 'timeRange'
  | 'messageRef'
  | 'mediaTypes'
  | 'aggregation'
  | 'relationTargets'

/** 统一分类结果。 */
export interface AnswerIntentDecision {
  /** 统一意图。 */
  kind: AnswerIntentKind
  /** 可直接传给旧检索流水线的意图。 */
  legacy: IntentKind
  /** 0~1；越高越不应让 LLM 覆盖。 */
  confidence: number
  /** 可解释依据。 */
  reason: string
  /** 建议调用的工具名（按优先级排序）。 */
  toolHints: string[]
  /** 主运行时是否应先澄清再检索。 */
  needsClarification?: boolean
  /** 主运行时可直接消费的范围字段。 */
  scopeHints?: AnswerScopeHints
  /** 人类可读的线索（最多若干条）。 */
  signals?: string[]
  /** 用户本轮显式重述的字段；未列出的字段可继承线程状态。 */
  overrides?: AnswerScopeField[]
  /** 分类器来源。 */
  classifier?: 'rules' | 'llm' | 'hybrid'
  /** 若 kind=clarify，保留补全上下文后本来要走的意图。 */
  candidateKind?: AnswerIntentKind
}

/** LLM 分类建议；所有字段都可选，非法值会被丢弃。 */
export interface AnswerIntentLlmSuggestion {
  kind?: AnswerIntentKind | string
  confidence?: number
  reason?: string
  toolHints?: string[]
  needsClarification?: boolean
  scopeHints?: {
    session?: string
    contact?: string
    from?: string
    to?: string
    media?: string
    ordinal?: number
  }
}

/** 注入式轻量 LLM 分类器（signal 用于独立 deadline）。 */
export type AnswerIntentLlmClassifier = (input: {
  question: string
  rule: AnswerIntentDecision
  now: Date
  signal?: AbortSignal
}) => Promise<AnswerIntentLlmSuggestion | null> | AnswerIntentLlmSuggestion | null
const LEGACY_TO_ANSWER: Record<IntentKind, AnswerIntentKind> = {
  recency_lookup: 'lookup',
  entity_lookup: 'lookup',
  time_range: 'timeline',
  aggregation: 'aggregate',
  comparison: 'relation',
  open_qa: 'open_qa',
}

/**
 * 旧意图 -> 统一意图。
 * @param kind - 旧检索意图。
 * @returns 统一意图。
 */
export function mapLegacyIntent(kind: IntentKind): AnswerIntentKind {
  return LEGACY_TO_ANSWER[kind] ?? 'open_qa'
}

/**
 * 统一意图 -> 旧检索意图。
 * @param kind - 统一意图。
 * @param options - lookup 是否带「最近 / 最新」排序语义。
 * @returns 旧检索意图。
 */
export function toLegacyIntent(
  kind: AnswerIntentKind,
  options: { recency?: boolean; comparison?: boolean } = {},
): IntentKind {
  switch (kind) {
    case 'lookup':
      return options.recency === true ? 'recency_lookup' : 'entity_lookup'
    case 'aggregate':
      return 'aggregation'
    case 'relation':
      return options.comparison === true ? 'comparison' : 'entity_lookup'
    case 'timeline':
      return 'time_range'
    case 'content_media':
      return 'entity_lookup'
    case 'open_qa':
    case 'clarify':
      return 'open_qa'
  }
}

/** 判断一个值是否是统一意图。 */
export function isAnswerIntentKind(value: unknown): value is AnswerIntentKind {
  return typeof value === 'string' && (ANSWER_INTENT_KINDS as readonly string[]).includes(value)
}

const MEDIA_PATTERNS: ReadonlyArray<readonly [AnswerMediaType, RegExp]> = [
  ['image', /图片|照片|图像|截图|相片|自拍|头像|(?:这|那|哪)张图|图里|图中|图上|\.(?:jpe?g|png|gif|webp|heic|bmp)\b/i],
  ['video', /视频|录像|影片|短片|\.(?:mp4|mov|avi|mkv|webm|flv)\b/i],
  ['file', /文件|文档|附件|资料|压缩包|\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt)\b/i],
  ['voice', /语音|音频|录音|声音|\.(?:mp3|wav|m4a|amr|silk)\b/i],
  ['link', /链接|网址|\burl\b|https?:\/\//i],
  ['sticker', /表情包|贴纸|emoji/i],
]

const MEDIA_DEICTIC_RE =
  /(?:这|那|哪)(?:张|个|份|段|条)?(?:图|照片|视频|文件|文档|语音|录音)|刚才(?:那|这)?(?:个|张|份|段|条)?(?:图|照片|视频|文件|文档|语音|录音)|刚刚(?:那|这)?(?:个|张|份|段|条)?(?:图|照片|视频|文件|文档|语音|录音)/

const AGG_COUNT_RE = /一共|总共|合计|总计|汇总|加起来|统计|数量|总数|多少次|几次|几回|几笔|多少(?:条|个|次|笔|份|张|位|人|元|块|小时|天|月|年)?/i
const AGG_RANK_RE = /哪个.*(?:最多|最少)|谁.*(?:最多|最少)|最多的是|最少的是|排行|排名|top\s*\d+/i
const AGG_SUM_RE = /总金额|总额|合计金额|多少钱|一共.*(?:元|块|钱)|花费|收入|支出/i
const AGG_AVG_RE = /平均|均值/i
const AGG_DISTINCT_RE = /多少(?:个|位|人|种|类)|几个(?:人|群|会话|联系人)/i
const AGG_TIME_GROUP_RE = /按天|按日|按周|按月|按年|每天|每周|每月|哪天|哪一天|哪个月/i
const AGG_SESSION_GROUP_RE = /哪个群|哪个会话|按会话|按群|群聊.*最多|会话.*最多/i
const AGG_CONTACT_GROUP_RE = /谁.*最多|谁.*最少|按人|按联系人|联系人.*最多/i
const COMPARE_RE = /对比|比较|区别|差异|哪个更|谁更|哪个好|相比|\bvs\b|versus/i
const RELATION_RE = /什么关系|啥关系|关系(?:怎么样|如何|好吗)?|认识|熟不熟|熟吗|来往|交集|互动|联系(?:多|少|频繁|密切)|共同(?:好友|群|朋友|联系人)|谁跟谁|谁和谁|经常和谁|和谁.*聊/i
const TIMELINE_RE = /聊(?:了|过|啥|什么)?|说了(?:什么|啥)?|发生(?:了)?(?:什么|啥)?|经历|记录|时间线|经过|来龙去脉|回顾|复盘|总结|整理|做了(?:什么|啥)?|干嘛|忙(?:什么|啥)?|情况|动态|活动|安排/i
const WHO_RE = /是谁|谁的|哪个人|哪一位|哪位|何人/
const LOOKUP_VERB_RE = /找一下|查一下|查查|搜一下|搜索|定位|看看|看一下|发过|说过|提过|哪一条|哪一句|消息记录|聊天记录/i
const OPEN_ANALYSIS_RE = /为什么|为何|怎么|如何|分析|概括|判断|建议|怎么办|是否|能不能|可不可以|值不值|靠不靠谱|怎么样|什么情况|怎么回事/i
const CHITCHAT_RE = /^(?:你好|您好|hi|hello|谢谢|多谢|在吗|早上好|晚上好|再见)[\s!！。,.，?？]*$/i
const CAPABILITY_RE = /^(?:你|您)(?:能|会|可以|支持).{0,12}(?:什么|啥|哪些)|^(?:你|您)是谁[\s?？!！。]*$/i

const DEICTIC_SESSION_RE = /这个群|这群|本群|该群|当前群|这个群聊|当前群聊|这个会话|该会话|当前会话|本会话|这个聊天|当前聊天|这里|这边/
const PERSON_PRONOUN_RE = /(?:^|[^其])他(?!们|人)|她(?!们)|对方|这个人|那个人|这位|那位/
const GENERIC_REFERENCE_RE =
  /(?:^|[，,。！？?\s])(?:刚才|刚刚|之前|上面|前面|那个|这个|那条|这条|它|那个东西|那件事)/

const ORDINAL_MESSAGE_RE = /(倒数)?第\s*([0-9一二三四五六七八九十百两]+)\s*条(?:消息|微信|聊天记录|记录|话)?/
const LATEST_MESSAGE_RE = /最后(?:一)?条(?:消息)?|最新(?:一)?条(?:消息)?|最近(?:一)?条(?:消息)?/
const PREVIOUS_MESSAGE_RE = /上一条(?:消息)?|前一条(?:消息)?|刚才(?:那|这)?条(?:消息)?|刚刚(?:那|这)?条(?:消息)?/
const CONTEXTUAL_MESSAGE_RE =
  /这条(?:消息)?|那条(?:消息)?|这个(?:消息|文件|图片|视频|语音)|那个(?:消息|文件|图片|视频|语音)|刚才那个|刚刚那个|刚才的|之前的那个|上面那个|那个东西|它/

const SORT_ONLY_RECENCY_RE =
  /(?:最近|上一次|上次)(?:的)?(?:一)?(?:次|条|个|回|笔|份|张|句|位)|最新|最后(?:一)?(?:次|条|个)/

function unique(values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = String(raw ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function uniqueMedia(values: readonly AnswerMediaType[]): AnswerMediaType[] {
  const out: AnswerMediaType[] = []
  for (const value of values) if (!out.includes(value)) out.push(value)
  return out
}

function uniqueDimensions(values: readonly AnswerAggregationDimension[]): AnswerAggregationDimension[] {
  const out: AnswerAggregationDimension[] = []
  for (const value of values) if (!out.includes(value)) out.push(value)
  return out
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(0.99, Math.round(value * 100) / 100))
}

function ymd(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function parseYmd(value: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return undefined
  return date
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function startOfWeekMonday(now: Date): Date {
  const offset = (now.getDay() + 6) % 7
  return addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -offset)
}

function daysInclusive(from: string, to: string): number {
  const a = parseYmd(from)
  const b = parseYmd(to)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1
}

function makeRange(
  from: string,
  to: string,
  granularity: AnswerTimeGranularity,
  source: AnswerTimeSource,
  label: string,
): AnswerTimeRange {
  return { from, to, granularity, source, label }
}

interface ProgressionSpec {
  kind: 'day' | 'week' | 'month' | 'year' | 'span'
  amount: number
  label: string
}

function detectProgression(q: string): ProgressionSpec | undefined {
  const hasLead = /^(?:那|那么|呃|嗯|再|还有|另外|继续)/.test(q) || /再往前|更早|之前/.test(q)
  if (!hasLead) return undefined
  // 「去年 9 月 3 号」是显式日期，不是相对上一轮整年前移。
  if (/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/.test(q)) return undefined
  if (/再往前\s*(?:三|3)\s*(?:周|星期|礼拜)/.test(q)) return { kind: 'week', amount: -3, label: '相对上一轮再前移三周' }
  if (/再往前\s*(?:两|2)\s*(?:周|星期|礼拜)/.test(q)) return { kind: 'week', amount: -2, label: '相对上一轮再前移两周' }
  if (/再往前\s*(?:一|1)?\s*(?:周|星期|礼拜)/.test(q)) return { kind: 'week', amount: -1, label: '相对上一轮再前移一周' }
  if (/再往前\s*(?:三|3)\s*天/.test(q)) return { kind: 'day', amount: -3, label: '相对上一轮再前移三天' }
  if (/再往前\s*(?:两|2)\s*天/.test(q)) return { kind: 'day', amount: -2, label: '相对上一轮再前移两天' }
  if (/再往前\s*(?:一|1)?\s*天/.test(q)) return { kind: 'day', amount: -1, label: '相对上一轮再前移一天' }
  if (/上上(?:个)?(?:周|星期|礼拜)/.test(q)) return { kind: 'week', amount: -2, label: '相对上一轮前移两周' }
  if (/(?:上|前)(?:个)?(?:周|星期|礼拜)/.test(q)) return { kind: 'week', amount: -1, label: '相对上一轮前移一周' }
  if (/上上(?:个)?月/.test(q)) return { kind: 'month', amount: -2, label: '相对上一轮前移两个月' }
  if (/(?:上|前)(?:个)?月/.test(q)) return { kind: 'month', amount: -1, label: '相对上一轮前移一个月' }
  if (/前年/.test(q)) return { kind: 'year', amount: -2, label: '相对上一轮前移两年' }
  if (/去年|上一年/.test(q)) return { kind: 'year', amount: -1, label: '相对上一轮前移一年' }
  if (/大前天/.test(q)) return { kind: 'day', amount: -3, label: '相对上一轮前移三天' }
  if (/前天/.test(q)) return { kind: 'day', amount: -2, label: '相对上一轮前移两天' }
  if (/昨天|昨日/.test(q)) return { kind: 'day', amount: -1, label: '相对上一轮前移一天' }
  const n = /(?:再往前|更早|之前)\s*(\d{1,3})\s*天/.exec(q)
  if (n) {
    const amount = Number(n[1])
    if (Number.isFinite(amount) && amount > 0) {
      return { kind: 'day', amount: -amount, label: `相对上一轮前移 ${String(amount)} 天` }
    }
  }
  if (/再往前|更早|之前/.test(q)) return { kind: 'span', amount: -1, label: '相对上一轮前移同样长度的时间窗' }
  return undefined
}

function shiftMonthRange(previous: AnswerTimeRange, delta: number): AnswerTimeRange | undefined {
  const from = parseYmd(previous.from)
  if (!from) return undefined
  const first = new Date(from.getFullYear(), from.getMonth() + delta, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  return makeRange(ymd(first), ymd(last), 'month', 'progression', `相对上一轮前移${String(Math.abs(delta))}个月`)
}

function shiftYearRange(previous: AnswerTimeRange, delta: number): AnswerTimeRange | undefined {
  const from = parseYmd(previous.from)
  if (!from) return undefined
  const year = from.getFullYear() + delta
  return makeRange(
    `${String(year)}-01-01`,
    `${String(year)}-12-31`,
    'year',
    'progression',
    `相对上一轮前移${String(Math.abs(delta))}年`,
  )
}

function shiftProgression(previous: AnswerTimeRange, spec: ProgressionSpec): AnswerTimeRange | undefined {
  const previousFrom = parseYmd(previous.from)
  const previousTo = parseYmd(previous.to)
  if (!previousFrom || !previousTo) return undefined
  if (spec.kind === 'month') {
    const shifted = shiftMonthRange(previous, spec.amount)
    return shifted ? { ...shifted, label: spec.label } : undefined
  }
  if (spec.kind === 'year') {
    const shifted = shiftYearRange(previous, spec.amount)
    return shifted ? { ...shifted, label: spec.label } : undefined
  }
  let days = 0
  if (spec.kind === 'day') days = spec.amount
  else if (spec.kind === 'week') days = spec.amount * 7
  else days = -Math.max(1, daysInclusive(previous.from, previous.to))
  return makeRange(
    ymd(addDays(previousFrom, days)),
    ymd(addDays(previousTo, days)),
    previous.granularity === 'day' ? 'day' : 'range',
    'progression',
    spec.label,
  )
}

function weekdayIndex(value: string): number | undefined {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
  return map[value]
}

function resolveWeekdayWindow(q: string, now: Date): AnswerTimeRange | undefined {
  const m = /(上上|上|这|本|下)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(q)
  if (!m) return undefined
  const idx = weekdayIndex(m[2] ?? '')
  if (!idx) return undefined
  const prefix = m[1] ?? ''
  const weekDelta = prefix === '上上' ? -2 : prefix === '上' ? -1 : prefix === '下' ? 1 : 0
  const target = addDays(startOfWeekMonday(now), weekDelta * 7 + idx - 1)
  const day = ymd(target)
  return makeRange(day, day, 'day', 'explicit', `${prefix || '本'}周${m[2] ?? ''}`)
}

function resolveBareWeekWindow(q: string, now: Date): AnswerTimeRange | undefined {
  const m = /(上上|上|这|本|下)(?:个)?(?:周|星期|礼拜)(?![一二三四五六日天])/.exec(q)
  if (!m) return undefined
  const prefix = m[1] ?? ''
  const delta = prefix === '上上' ? -2 : prefix === '上' ? -1 : prefix === '下' ? 1 : 0
  const start = addDays(startOfWeekMonday(now), delta * 7)
  const end = delta === 0
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : addDays(start, 6)
  return makeRange(ymd(start), ymd(end), 'week', 'explicit', `${prefix}周`)
}

function resolveBareMonthWindow(q: string, now: Date): AnswerTimeRange | undefined {
  const m = /(上上|上|这|本|下)(?:个)?月(?!\s*\d)/.exec(q)
  if (!m) return undefined
  const prefix = m[1] ?? ''
  const delta = prefix === '上上' ? -2 : prefix === '上' ? -1 : prefix === '下' ? 1 : 0
  const first = new Date(now.getFullYear(), now.getMonth() + delta, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const end = delta === 0
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : last
  return makeRange(ymd(first), ymd(end), 'month', 'explicit', `${prefix}个月`)
}

function resolveBareYearWindow(q: string, now: Date): AnswerTimeRange | undefined {
  if (/前年/.test(q)) {
    const year = now.getFullYear() - 2
    return makeRange(`${String(year)}-01-01`, `${String(year)}-12-31`, 'year', 'explicit', '前年')
  }
  if (/去年|上一年/.test(q)) {
    const year = now.getFullYear() - 1
    return makeRange(`${String(year)}-01-01`, `${String(year)}-12-31`, 'year', 'explicit', '去年')
  }
  if (/明年/.test(q)) {
    const year = now.getFullYear() + 1
    return makeRange(`${String(year)}-01-01`, `${String(year)}-12-31`, 'year', 'explicit', '明年')
  }
  if (/今年|本年度/.test(q)) {
    return makeRange(`${String(now.getFullYear())}-01-01`, ymd(now), 'year', 'explicit', '今年')
  }
  return undefined
}

/**
 * 把问题里的时间表达解析成绝对范围。
 *
 * 旧 `resolveRelativeDate` 继续负责日期 / 周几 / 月日，保证行为兼容；
 * 这里补充裸「上周 / 上个月 / 最近 N 天」窗口，以及相对上一轮时间窗的递进。
 * @param text - 用户问题。
 * @param options.now - 当前时刻（可注入）。
 * @param options.previous - 上一轮时间范围；仅用于递进问法。
 * @returns 结构化时间范围；没有时间线索时返回 undefined。
 */
export function resolveAnswerTimeRange(
  text: string,
  options: { now?: Date; previous?: AnswerTimeRange } = {},
): AnswerTimeRange | undefined {
  const q = normalizeQuestion(text)
  if (!q) return undefined
  const now = options.now ?? new Date()

  const progression = options.previous ? detectProgression(q) : undefined
  if (progression && options.previous) {
    const shifted = shiftProgression(options.previous, progression)
    if (shifted) return shifted
  }

  const explicitRange = resolveExplicitDateRange(q)
  if (explicitRange) return explicitRange

  const anchoredRecent = resolveAnchoredRecentDateRange(q)
  if (anchoredRecent) return anchoredRecent

  const absoluteDay = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(q)
  if (absoluteDay) {
    const value = strictIsoDay(Number(absoluteDay[1]), Number(absoluteDay[2]), Number(absoluteDay[3]))
    if (value) {
      return makeRange(value, value, 'day', 'explicit', value)
    }
  }
  const absoluteCnd = /(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/.exec(q)
  if (absoluteCnd) {
    const value = strictIsoDay(Number(absoluteCnd[1]), Number(absoluteCnd[2]), Number(absoluteCnd[3]))
    if (value) {
      return makeRange(value, value, 'day', 'explicit', value)
    }
  }
  const relativeYearDay = /(去年|今年|前年|明年)(\d{1,2})月(\d{1,2})[日号]/.exec(q)
  if (relativeYearDay) {
    const prefix = relativeYearDay[1] ?? ''
    const year = prefix === '去年'
      ? now.getFullYear() - 1
      : prefix === '前年'
        ? now.getFullYear() - 2
        : prefix === '明年'
          ? now.getFullYear() + 1
          : now.getFullYear()
    const date = new Date(year, Number(relativeYearDay[2]) - 1, Number(relativeYearDay[3]))
    if (!Number.isNaN(date.getTime())) {
      const value = ymd(date)
      return makeRange(value, value, 'day', 'explicit', `${prefix}${String(relativeYearDay[2])}月${String(relativeYearDay[3])}号`)
    }
  }
  const absoluteMonth = /(\d{4})年(\d{1,2})月/.exec(q)
  if (absoluteMonth) {
    const year = Number(absoluteMonth[1])
    const month = Number(absoluteMonth[2]) - 1
    const first = new Date(year, month, 1)
    const last = new Date(year, month + 1, 0)
    return makeRange(ymd(first), ymd(last), 'month', 'explicit', `${String(year)}年${String(month + 1)}月`)
  }
  const absoluteYear = /(\d{4})年/.exec(q)
  if (absoluteYear) {
    const year = Number(absoluteYear[1])
    return makeRange(`${String(year)}-01-01`, `${String(year)}-12-31`, 'year', 'explicit', `${String(year)}年`)
  }

  if (/大前天/.test(q)) {
    const day = ymd(addDays(now, -3))
    return makeRange(day, day, 'day', 'explicit', '大前天')
  }
  if (/前天/.test(q)) {
    const day = ymd(addDays(now, -2))
    return makeRange(day, day, 'day', 'explicit', '前天')
  }
  if (/昨天|昨日/.test(q)) {
    const day = ymd(addDays(now, -1))
    return makeRange(day, day, 'day', 'explicit', '昨天')
  }
  if (/今天|今日|当天|当日/.test(q)) {
    const day = ymd(now)
    return makeRange(day, day, 'day', 'explicit', '今天')
  }

  const weekday = resolveWeekdayWindow(q, now)
  if (weekday) return weekday
  const week = resolveBareWeekWindow(q, now)
  if (week) return week
  const month = resolveBareMonthWindow(q, now)
  if (month) return month
  const year = resolveBareYearWindow(q, now)
  if (year) return year
  const recent = resolveRecentDateRange(q, now)
  if (recent) return recent

  // 「最近一次 / 最新一条」是排序意图，不是时间窗；不能悄悄缩成最近 7 天。
  if (SORT_ONLY_RECENCY_RE.test(q)) return undefined

  const legacy = resolveRelativeDate(q, now)
  if (legacy.from || legacy.to) {
    const from = legacy.from || legacy.to
    const to = legacy.to || legacy.from
    const yearOnly = /^(?:\d{4}-01-01)$/.test(from) && /^(?:\d{4}-12-31)$/.test(to)
      && !/月份?/.test(q)
    if (!yearOnly) {
      return makeRange(from, to, from === to ? 'day' : 'range', 'explicit', from === to ? from : `${from} 至 ${to}`)
    }
  }
  if (/最近|近期|近来/.test(q)) {
    return makeRange(ymd(addDays(now, -6)), ymd(now), 'range', 'explicit', '最近 7 天')
  }
  return undefined
}

function asTimeRange(
  value: AnswerIntentContext['lastTimeRange'],
): AnswerTimeRange | undefined {
  if (!value || (!value.from && !value.to)) return undefined
  if ('granularity' in value) return value
  return makeRange(
    value.from,
    value.to,
    value.from === value.to ? 'day' : 'range',
    'inherited',
    value.from === value.to ? value.from : `${value.from} 至 ${value.to}`,
  )
}

function inferMediaTypes(text: string): AnswerMediaType[] {
  const q = String(text ?? '')
  const out: AnswerMediaType[] = []
  for (const [kind, re] of MEDIA_PATTERNS) {
    re.lastIndex = 0
    if (re.test(q) && !out.includes(kind)) out.push(kind)
  }
  return out
}

/**
 * 从文本推断媒体类型（也用于把历史 / trace 里的 `[图片]`、文件名归一化）。
 * @param text - 原始文本。
 * @returns 去重后的媒体类型。
 */
export function inferMediaTypesFromText(text: string): AnswerMediaType[] {
  return inferMediaTypes(text)
}

function inferAggregationDimensions(q: string): AnswerAggregationDimension[] {
  const out: AnswerAggregationDimension[] = []
  if (AGG_COUNT_RE.test(q)) out.push('count')
  if (AGG_SUM_RE.test(q)) out.push('sum')
  if (AGG_AVG_RE.test(q)) out.push('average')
  if (AGG_RANK_RE.test(q)) out.push('ranking')
  if (AGG_DISTINCT_RE.test(q)) out.push('distinct')
  if (AGG_TIME_GROUP_RE.test(q)) out.push('group_by_time')
  if (AGG_SESSION_GROUP_RE.test(q)) out.push('group_by_session')
  if (AGG_CONTACT_GROUP_RE.test(q)) out.push('group_by_contact')
  if (COMPARE_RE.test(q)) out.push('compare')
  return uniqueDimensions(out)
}

function parseChineseOrdinal(value: string): number | undefined {
  const raw = String(value ?? '').trim()
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (raw === '十') return 10
  if (raw === '百') return 100
  if (raw.length === 1) return digits[raw]
  if (raw.length === 2) {
    const first = digits[raw[0] ?? '']
    const second = digits[raw[1] ?? '']
    if (raw[1] === '十' && first) return first * 10
    if (raw[0] === '十' && second) return 10 + second
  }
  if (raw.length === 3) {
    const first = digits[raw[0] ?? '']
    const second = digits[raw[2] ?? '']
    if (raw[1] === '十' && first && second) return first * 10 + second
  }
  return undefined
}

function detectMessageReference(
  q: string,
  mediaTypes: readonly AnswerMediaType[],
  session?: string,
): AnswerMessageReference | undefined {
  const ordinal = ORDINAL_MESSAGE_RE.exec(q)
  if (ordinal) {
    const number = parseChineseOrdinal(ordinal[2] ?? '')
    if (number) {
      return {
        kind: 'ordinal',
        ordinal: number,
        fromEnd: Boolean(ordinal[1]),
        ...(session ? { session } : {}),
        explicit: true,
        reason: `${ordinal[1] ? '倒数' : ''}第 ${String(number)} 条消息`,
      }
    }
  }
  if (mediaTypes.length > 0 && (MEDIA_DEICTIC_RE.test(q) || /刚才那个|刚刚那个|那个东西/.test(q))) {
    return {
      kind: 'media',
      ...(session ? { session } : {}),
      mediaTypes: [...mediaTypes],
      explicit: true,
      reason: `媒体指代：${mediaTypes.join('/')}`,
    }
  }
  if (LATEST_MESSAGE_RE.test(q)) {
    return { kind: 'latest', ...(session ? { session } : {}), explicit: true, reason: '指代最新一条消息' }
  }
  if (PREVIOUS_MESSAGE_RE.test(q)) {
    return { kind: 'previous', ...(session ? { session } : {}), explicit: true, reason: '指代上一条消息' }
  }
  if (CONTEXTUAL_MESSAGE_RE.test(q)) {
    return { kind: 'contextual', ...(session ? { session } : {}), explicit: true, reason: '指代对话中的某条消息' }
  }
  return undefined
}

function findKnownEntity(q: string, values: readonly string[]): string | undefined {
  let hit: string | undefined
  for (const raw of values) {
    const value = String(raw ?? '').trim()
    if (value.length < 2 || !q.includes(value)) continue
    if (!hit || value.length > hit.length) hit = value
  }
  return hit
}

function extractQuotedSession(q: string): string | undefined {
  const m = /(?:会话|群聊|群|聊天)[：:\s]*[“"「『]([^”"」』]{1,30})[”"」』]/.exec(q)
  if (m?.[1]) return m[1].trim()
  const named = /(?:在|打开)\s*[“"「『]([^”"」』]{1,30})[”"」』]/.exec(q)
  if (named?.[1]) return named[1].trim()
  // 「最近和「z_卖酒」聊了什么」：和/跟/与 + 引号名 是明确的会话线索。
  // 不把任意引号短语都当会话，避免把字段名、文件名误识别成聊天对象。
  const withTarget = /(?:和|跟|与)\s*[“"「『]([^”"」』]{1,30})[”"」』]/.exec(q)
  return withTarget?.[1]?.trim()
}

function extractContactFromHistory(
  history: readonly AnswerHistoryMessage[],
  knownEntities: readonly string[],
): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i]
    if (!m || m.role !== 'user') continue
    const hit = findKnownEntity(m.content, knownEntities)
    if (hit) return hit
    const named = /(?:和|跟|与)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})\s*(?:的)?(?:聊天|对话|聊|说|联系)/.exec(m.content)
    if (named?.[1]) return named[1]
  }
  return undefined
}

function historyHasReferenceContext(history: readonly AnswerHistoryMessage[]): boolean {
  if (history.length === 0) return false
  return history.some(m =>
    /\[(图片|视频|文件|语音|链接|表情)\]|\.(?:jpe?g|png|gif|webp|mp4|mov|pdf|docx?|xlsx?|zip|mp3|wav)\b/i.test(m.content)
    || CONTEXTUAL_MESSAGE_RE.test(m.content)
    || PREVIOUS_MESSAGE_RE.test(m.content)
    || LATEST_MESSAGE_RE.test(m.content),
  )
}

function decideKind(input: {
  q: string
  timeRange?: AnswerTimeRange
  mediaTypes: readonly AnswerMediaType[]
  messageRef?: AnswerMessageReference
  entities: readonly string[]
  knownEntities: readonly string[]
  hasHistory: boolean
  hasReferenceContext: boolean
  context?: AnswerIntentContext
}): {
  kind: AnswerIntentKind
  confidence: number
  reason: string
  signals: string[]
  needsClarification?: boolean
  candidateKind?: AnswerIntentKind
} {
  const {
    q, timeRange, mediaTypes, messageRef, entities, knownEntities,
    hasHistory, hasReferenceContext, context,
  } = input
  const signals: string[] = []
  if (timeRange) signals.push(`time:${timeRange.label}`)
  if (mediaTypes.length > 0) signals.push(`media:${mediaTypes.join(',')}`)
  if (messageRef) signals.push(`message:${messageRef.reason}`)
  if (entities.length > 0) signals.push(`entity:${entities.join(',')}`)

  if (!q.trim()) {
    return { kind: 'clarify', confidence: 0.99, reason: '空问题，缺少可检索目标', signals, needsClarification: true }
  }

  if (CHITCHAT_RE.test(q) || CAPABILITY_RE.test(q)) {
    return { kind: 'open_qa', confidence: 0.96, reason: '寒暄或能力询问，无需检索微信数据', signals }
  }

  const hasMediaCue = mediaTypes.length > 0
  const hasTimelineCue = timeRange !== undefined || /时间线|经过|来龙去脉|回顾|复盘/.test(q)
  const hasAggregateCue = inferAggregationDimensions(q).length > 0 && /一共|总共|多少|几个|几次|几笔|最多|最少|排行|排名|平均|总额|总金额|统计|按天|按周|按月|按会话|按群/i.test(q)
  const hasCompareCue = COMPARE_RE.test(q)
  const hasRelationCue = RELATION_RE.test(q)
  const hasAttrCue = ENTITY_ATTR_RE.test(q)
  const hasWhoCue = WHO_RE.test(q)
  const hasLookupVerb = LOOKUP_VERB_RE.test(q)
  const hasOpenCue = OPEN_ANALYSIS_RE.test(q)
  const hasDeicticSession = DEICTIC_SESSION_RE.test(q)
  const hasPronoun = PERSON_PRONOUN_RE.test(q)
  const hasGenericRef = GENERIC_REFERENCE_RE.test(q)
  const hasTimelineVerb = TIMELINE_RE.test(q)
  const explicitEntity = entities[0]
  const inheritedContact = context?.activeContact || context?.lastEntity
  const entityContext = explicitEntity || inheritedContact
  const residue = q
    .replace(/最近|最新|上次|上一次|之前|刚才|刚刚|那个|这个|这些|那些|一下|帮我|请问|看看|查查|说说|聊聊/g, '')
    .replace(/[，,。.、？?！!：:；;\s]/g, '')

  if (hasDeicticSession) signals.push('session:current')
  if (hasPronoun) signals.push('contact:pronoun')
  if (hasAggregateCue) signals.push('aggregate')
  if (hasRelationCue) signals.push('relation')
  if (hasTimelineCue) signals.push('timeline')

  if (hasMediaCue) {
    if (hasPronoun && !entityContext) {
      return {
        kind: 'clarify',
        candidateKind: 'content_media',
        confidence: 0.86,
        reason: `识别到${mediaTypes.join('/')}追问，但「他/她/对方」没有可继承联系人`,
        signals,
        needsClarification: true,
      }
    }
    const ambiguousMedia = messageRef?.kind === 'media' && !hasHistory && !hasReferenceContext
    if (ambiguousMedia) {
      return {
        kind: 'clarify',
        candidateKind: 'content_media',
        confidence: 0.84,
        reason: `识别到${mediaTypes.join('/')}追问，但历史里没有可定位的上一份资源`,
        signals,
        needsClarification: true,
      }
    }
    return {
      kind: 'content_media',
      confidence: messageRef ? 0.92 : 0.86,
      reason: `涉及${mediaTypes.join('/')}资源${messageRef ? '，且带消息指代' : ''}`,
      signals,
    }
  }

  if (
    messageRef?.kind === 'contextual'
    && !hasHistory
    && !hasReferenceContext
  ) {
    return {
      kind: 'clarify',
      candidateKind: 'lookup',
      confidence: 0.84,
      reason: '出现「这个/那个/它」等指代，但历史为空，无法确定指代对象',
      signals,
      needsClarification: true,
    }
  }

  if (messageRef && (messageRef.kind === 'ordinal' || messageRef.kind === 'latest' || messageRef.kind === 'previous' || messageRef.kind === 'contextual')) {
    return {
      kind: 'lookup',
      confidence: 0.9,
      reason: `消息引用明确：${messageRef.reason}`,
      signals,
    }
  }

  if (hasPronoun && !entityContext) {
    return {
      kind: 'clarify',
      candidateKind: hasTimelineVerb ? 'timeline' : 'lookup',
      confidence: 0.82,
      reason: '出现「他/她/对方」等代词，但历史与上下文中没有可继承的联系人',
      signals,
      needsClarification: true,
    }
  }

  if (hasPronoun && entityContext) {
    return {
      kind: hasTimelineVerb ? 'timeline' : 'lookup',
      confidence: 0.85,
      reason: `代词指向已继承联系人「${entityContext}」`,
      signals,
    }
  }

  if (hasAggregateCue) {
    return { kind: 'aggregate', confidence: 0.95, reason: '含数量/合计/排名/分组等聚合问法', signals }
  }

  if (hasRelationCue || (hasCompareCue && entities.length >= 2)) {
    return {
      kind: 'relation',
      confidence: hasCompareCue ? 0.93 : 0.9,
      reason: hasCompareCue ? '实体之间的对比问法' : '询问关系、互动或共同联系人',
      signals,
    }
  }

  // 「上周三我和李四聊了什么」首先问的是时间线；不能因为点名了李四就窄化成实体查找。
  if (hasTimelineCue && hasTimelineVerb && !hasAttrCue && !hasAggregateCue) {
    const deferred = inheritedContact ? `；联系人「${inheritedContact}」` : ''
    return {
      kind: 'timeline',
      confidence: timeRange ? 0.94 : 0.86,
      reason: `按时间/经过浏览${timeRange ? `（${timeRange.label}）` : ''}${deferred}`,
      signals,
    }
  }

  if (hasAttrCue || hasWhoCue) {
    return {
      kind: 'lookup',
      confidence: explicitEntity ? 0.95 : 0.82,
      reason: hasAttrCue ? '查找实体属性（电话/地址/账号等）' : '询问主体身份',
      signals,
    }
  }

  if (explicitEntity && (hasLookupVerb || q.length <= 28)) {
    return { kind: 'lookup', confidence: 0.88, reason: `点名实体「${explicitEntity}」并查找信息`, signals }
  }

  // 只有「怎么/什么」这类分析词、没有实际检索动作时，不能仅凭「看看」判 lookup。
  const hasConcreteLookup =
    hasLookupVerb
    && !/看看|看一下/.test(q)
    && !/怎么|什么情况|怎么回事|为什么|为何/.test(q)
  if (hasConcreteLookup && residue.length > 0) {
    return { kind: 'lookup', confidence: 0.78, reason: '含明确检索动词与检索目标', signals }
  }

  if (hasOpenCue) {
    return { kind: 'open_qa', confidence: 0.75, reason: '开放分析/解释问法', signals }
  }

  if (hasGenericRef) {
    if (!hasHistory && !hasReferenceContext) {
      return {
        kind: 'clarify',
        candidateKind: 'lookup',
        confidence: 0.84,
        reason: '出现「刚才/这个/那个」等指代，但历史为空，无法确定指代对象',
        signals,
        needsClarification: true,
      }
    }
    return {
      kind: 'lookup',
      confidence: 0.78,
      reason: '对话指代，沿用上一轮对象继续查',
      signals,
    }
  }

  if (hasTimelineVerb && (residue.length <= 4 || hasTimelineCue)) {
    return { kind: 'timeline', confidence: 0.8, reason: '泛问聊天内容/动态', signals }
  }

  if (hasTimelineCue) {
    const deferred = inheritedContact ? `；沿用联系人「${inheritedContact}」` : ''
    return {
      kind: 'timeline',
      confidence: timeRange ? 0.93 : 0.86,
      reason: `按时间/经过浏览${timeRange ? `（${timeRange.label}）` : ''}${deferred}`,
      signals,
    }
  }

  if (residue.length <= 2) {
    return {
      kind: 'clarify',
      confidence: 0.76,
      reason: '问题过于笼统，缺少会话、时间或检索对象',
      signals,
      needsClarification: true,
    }
  }

  return {
    kind: 'open_qa',
    confidence: knownEntities.length > 0 ? 0.56 : 0.52,
    reason: '未命中特定结构性意图，按开放问答处理',
    signals,
  }
}

/**
 * 规则分类（默认入口，同步、零依赖）。
 *
 * 规则覆盖：
 * - 「那上周呢 / 再往前」：有历史时间线索时相对上一窗递进，否则按绝对「上周」解析；
 * - 「这个群第二条」：识别当前会话引用 + 序号；
 * - 「他 / 对方」：有历史联系人则继承，否则要求澄清；
 * - 「刚才那个文件」：识别媒体类型与消息引用。
 *
 * @param question - 用户问题。
 * @param opts - 已知实体、历史、当前会话与上一轮上下文。
 * @returns 统一意图结果。
 */
export function classifyAnswerIntent(
  question: string,
  opts: ClassifyAnswerIntentOptions = {},
): AnswerIntentDecision {
  const q = normalizeQuestion(question)
  const now = opts.now ?? new Date()
  const history = (opts.history ?? []).filter(
    (m): m is AnswerHistoryMessage =>
      Boolean(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
  )
  const knownEntities = unique(opts.knownEntities ?? [])
  const knownSessions = unique(opts.knownSessions ?? [])
  const knownContacts = unique([...(opts.knownContacts ?? []), ...knownEntities])
  const explicitEntity = findKnownEntity(q, knownEntities)
  const explicitContact = findKnownEntity(q, knownContacts)
  const explicitSession = findKnownEntity(q, knownSessions) ?? extractQuotedSession(q)
  const historyContact = !explicitContact ? extractContactFromHistory(history, knownEntities) : undefined
  const contextContact = opts.context?.activeContact || opts.context?.lastEntity
  const inheritedContact = explicitContact || historyContact || contextContact
  const entities = unique([explicitEntity, explicitContact, inheritedContact].filter((x): x is string => Boolean(x)))
  const previousRange = asTimeRange(opts.context?.lastTimeRange)
  const timeRange = resolveAnswerTimeRange(q, { now, ...(previousRange ? { previous: previousRange } : {}) })
  const mediaTypes = inferMediaTypes(q)
  const deicticSession = DEICTIC_SESSION_RE.test(q)
  const session = explicitSession
    ?? opts.currentSession
    ?? (deicticSession ? opts.context?.activeSession : undefined)
    ?? opts.context?.activeSession
  const sessionRef: 'current' | undefined =
    deicticSession && !session ? 'current' : undefined
  const messageRef = detectMessageReference(q, mediaTypes, session)
  const dimensions = inferAggregationDimensions(q)
  const relationTargets = unique(
    (entities.length > 0 ? entities : q.match(/[\u4e00-\u9fa5]{2,4}/g) ?? []).slice(0, 4),
  )
  const hasReferenceContext = historyHasReferenceContext(history)
  const base = decideKind({
    q,
    ...(timeRange ? { timeRange } : {}),
    mediaTypes,
    ...(messageRef ? { messageRef } : {}),
    entities,
    knownEntities,
    hasHistory: history.length > 0,
    hasReferenceContext,
    ...(opts.context ? { context: opts.context } : {}),
  })

  const legacyDecision = classifyLegacyIntent(q, knownEntities)
  const recency = legacyDecision.recency || RECENCY_RE.test(q)
  const scopeHints: AnswerScopeHints = {
    ...(session ? { session } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    ...(inheritedContact ? { contact: inheritedContact } : {}),
    ...(timeRange?.from ? { from: timeRange.from } : {}),
    ...(timeRange?.to ? { to: timeRange.to } : {}),
    ...(mediaTypes[0] ? { media: mediaTypes[0] } : {}),
    ...(mediaTypes.length > 0 ? { mediaTypes } : {}),
    ...(messageRef?.ordinal ? { ordinal: messageRef.ordinal } : {}),
    ...(messageRef ? { messageRef } : {}),
    ...(timeRange ? { timeRange } : {}),
    ...(dimensions.length > 0 ? { aggregationDimensions: dimensions } : {}),
    ...(relationTargets.length > 0 ? { relationTargets } : {}),
    ...(entities.length > 0 ? { entities } : {}),
  }

  const overrides: AnswerScopeField[] = []
  if (explicitSession || deicticSession) overrides.push('session')
  if (explicitContact || PERSON_PRONOUN_RE.test(q)) overrides.push('contact')
  if (timeRange && timeRange.source === 'explicit') overrides.push('timeRange')
  if (messageRef) overrides.push('messageRef')
  if (mediaTypes.length > 0) overrides.push('mediaTypes')
  if (dimensions.length > 0) overrides.push('aggregation')
  if (relationTargets.length > 0) overrides.push('relationTargets')

  const toolHints = toolHintsFor(base.kind, {
    q,
    hasMessageRef: messageRef !== undefined,
    hasTime: timeRange !== undefined,
    hasMedia: mediaTypes.length > 0,
    hasContact: Boolean(inheritedContact),
    hasSession: Boolean(session || sessionRef),
    hasAggregate: dimensions.length > 0,
  })

  const decision: AnswerIntentDecision = {
    kind: base.kind,
    legacy: base.kind === 'open_qa' && recency
      ? 'recency_lookup'
      : toLegacyIntent(base.kind, { recency, comparison: COMPARE_RE.test(q) }),
    confidence: clamp(base.confidence),
    reason: base.reason,
    toolHints,
    ...(base.needsClarification ? { needsClarification: true } : {}),
    ...(Object.keys(scopeHints).length > 0 ? { scopeHints } : {}),
    signals: unique(base.signals).slice(0, 8),
    ...(overrides.length > 0 ? { overrides: unique(overrides) as AnswerScopeField[] } : {}),
    classifier: 'rules',
    ...(base.candidateKind ? { candidateKind: base.candidateKind } : {}),
  }

  return opts.llmSuggestion
    ? applyAnswerIntentSuggestion(decision, opts.llmSuggestion, {
      ...(opts.llmOverrideThreshold !== undefined ? { overrideThreshold: opts.llmOverrideThreshold } : {}),
    })
    : decision
}

/**
 * 合并 LLM 建议。
 *
 * 保守策略：规则高置信时不允许模型改 kind，只允许补空字段；
 * 规则低置信或已判 clarify 时，才接受合法且自信的 kind 覆盖。
 * @param rule - 规则结果。
 * @param suggestion - 模型建议。
 * @param options.overrideThreshold - 允许覆盖的规则置信度上限，默认 0.72。
 * @returns 合并后的结果。
 */
export function applyAnswerIntentSuggestion(
  rule: AnswerIntentDecision,
  suggestion: AnswerIntentLlmSuggestion | null | undefined,
  options: { overrideThreshold?: number } = {},
): AnswerIntentDecision {
  if (!suggestion) return rule
  const threshold = options.overrideThreshold ?? 0.72
  const llmConfidence = clamp(suggestion.confidence ?? 0.6)
  const canOverrideKind =
    isAnswerIntentKind(suggestion.kind)
    && llmConfidence >= 0.6
    && (rule.kind === 'clarify' || rule.confidence < threshold)
  const kind = canOverrideKind ? suggestion.kind as AnswerIntentKind : rule.kind
  const kindChanged = kind !== rule.kind
  const scope = rule.scopeHints ?? {}
  const suggested = suggestion.scopeHints ?? {}
  const nextScope: AnswerScopeHints = {
    ...scope,
    ...(!scope.session && typeof suggested.session === 'string' && suggested.session.trim()
      ? { session: suggested.session.trim() }
      : {}),
    ...(!scope.contact && typeof suggested.contact === 'string' && suggested.contact.trim()
      ? { contact: suggested.contact.trim() }
      : {}),
    ...(!scope.from && typeof suggested.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(suggested.from)
      ? { from: suggested.from }
      : {}),
    ...(!scope.to && typeof suggested.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(suggested.to)
      ? { to: suggested.to }
      : {}),
    ...(!scope.media && typeof suggested.media === 'string'
      && ['image', 'video', 'file', 'voice', 'link', 'sticker', 'other'].includes(suggested.media)
      ? { media: suggested.media as AnswerMediaType }
      : {}),
    ...(!scope.ordinal && Number.isFinite(suggested.ordinal) && Number(suggested.ordinal) > 0
      ? { ordinal: Math.floor(Number(suggested.ordinal)) }
      : {}),
  }
  const toolHints = unique([
    ...(Array.isArray(suggestion.toolHints) && suggestion.toolHints.length > 0
      ? suggestion.toolHints
      : rule.toolHints),
    ...(canOverrideKind ? toolHintsFor(kind, {
      q: '',
      hasMessageRef: Boolean(nextScope.messageRef),
      hasTime: Boolean(nextScope.from || nextScope.to),
      hasMedia: Boolean(nextScope.media || nextScope.mediaTypes?.length),
      hasContact: Boolean(nextScope.contact),
      hasSession: Boolean(nextScope.session),
      hasAggregate: Boolean(nextScope.aggregationDimensions?.length),
    }) : []),
  ])
  const needsClarification = suggestion.needsClarification === true
    ? true
    : rule.needsClarification
  return {
    ...rule,
    kind,
    legacy: kind === rule.kind ? rule.legacy : toLegacyIntent(kind, { recency: rule.legacy === 'recency_lookup' }),
    confidence: canOverrideKind ? llmConfidence : rule.confidence,
    reason: canOverrideKind
      ? `${rule.reason}；模型修正为 ${kind}：${String(suggestion.reason ?? '').trim()}`
      : `${rule.reason}${String(suggestion.reason ?? '').trim() ? `；模型补充：${String(suggestion.reason).trim()}` : ''}`,
    toolHints: kindChanged ? toolHints : rule.toolHints.length > 0 ? rule.toolHints : toolHints,
    ...(needsClarification ? { needsClarification: true } : {}),
    ...(Object.keys(nextScope).length > 0 ? { scopeHints: nextScope } : {}),
    classifier: kindChanged ? 'hybrid' : rule.classifier ?? 'rules',
  }
}

/**
 * 规则 + 注入式 LLM 的异步入口。
 *
 * 没有传 `llm` 时与 `classifyAnswerIntent` 完全一致；模型失败也直接回退规则，
 * 不让分类器成为问答链路的单点故障。
 * @param question - 用户问题。
 * @param opts - 分类选项。
 * @param llm - 可选的轻量分类器。
 * @returns 合并后的分类结果。
 */
export async function classifyAnswerIntentWithLlm(
  question: string,
  opts: ClassifyAnswerIntentOptions = {},
  llm?: AnswerIntentLlmClassifier,
): Promise<AnswerIntentDecision> {
  const rule = classifyAnswerIntent(question, opts)
  if (!llm) return rule
  const threshold = opts.llmOverrideThreshold ?? 0.72
  if (rule.confidence >= threshold && rule.kind !== 'clarify') return rule
  try {
    const suggestion = await llm({ question, rule, now: opts.now ?? new Date() })
    return applyAnswerIntentSuggestion(rule, suggestion, { overrideThreshold: threshold })
  } catch {
    return {
      ...rule,
      signals: unique([...(rule.signals ?? []), 'classifier:llm_failed']),
    }
  }
}
