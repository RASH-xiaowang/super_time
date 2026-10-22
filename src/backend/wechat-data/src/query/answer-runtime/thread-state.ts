/**
 * 多轮线程状态（answer runtime v2）。
 *
 * 目标不是把历史全文再塞一遍给模型，而是把「上一轮已经确定的范围」变成
 * 可继承、可覆盖、可解释的结构化状态：
 *
 *   · 显式本轮范围优先，绝不拿历史覆盖用户明说的会话 / 时间；
 *   · 「那上周呢 / 再往前」相对上一轮时间窗递进，而不是重新按今天算；
 *   · 「他 / 这个群第二条 / 刚才那个文件」从上一轮联系人、会话、引用消息继承；
 *   · 历史只保留最近若干条并受字符预算约束，避免无限增长与无关内容泄漏。
 *
 * 这个模块是纯函数，不读写数据库、不调用模型。
 *
 * @module query/answer-runtime/thread-state
 */
import type { AnswerIntentKind } from './intent.ts'
import {
  classifyAnswerIntent,
  resolveAnswerTimeRange,
  type AnswerHistoryMessage,
  type AnswerMessageReference,
  type AnswerTimeRange,
} from './intent.ts'
import {
  resolveAnchoredRecentDateRange,
  resolveExplicitDateRange,
} from './explicit-time-range.ts'

/** 默认保留的最近历史条数（约 8 轮）。 */
export const THREAD_STATE_MAX_MESSAGES = 16

/** 默认历史字符预算。 */
export const THREAD_STATE_MAX_CHARS = 4000

/** 单条用户消息最多保留多少字符。 */
const USER_MESSAGE_MAX_CHARS = 400

/** 单条助手消息最多保留多少字符。 */
const ASSISTANT_MESSAGE_MAX_CHARS = 1200

/** 可序列化、可持久化的线程状态。 */
export interface ThreadState {
  activeSession?: string
  activeContact?: string
  lastTimeRange?: { from: string; to: string }
  lastEntity?: string
  /**
   * 稳定引用串，优先 `username:local_id`，否则 `message:<摘要>`。
   *
   * 保留字符串而不是整个对象，是为了能安全落库 / 写 trace；
   * 需要完整消息时由运行时再用 key 调 `get_message_context`。
   */
  lastReferencedMessage?: string
  lastIntent?: AnswerIntentKind
  turns: number
  /** 最近保留的历史（已过滤、截断）。 */
  history?: AnswerHistoryMessage[]
  /** 最近一轮的时间粒度与时区无关标签，便于下一轮递进。 */
  lastTimeGranularity?: AnswerTimeRange['granularity']
  /** 时间范围是否来自 UI / 服务端硬筛选；硬筛选优先于问题里的相对时间。 */
  lastTimeHard?: boolean
  /** 被截断掉的条数（只用于 trace 与调试，不参与继承）。 */
  historyOmitted?: number
}

/** 显式范围：由 UI 筛选器 / SessionAsk 服务端强制传入。 */
export interface ThreadExplicitScope {
  username?: string
  from?: string
  to?: string
}

/** `applyThreadState` 的结果。 */
export interface AppliedThreadState {
  from?: string
  to?: string
  session?: string
  contact?: string
  referencedMessage?: string
  reason: string[]
  /** 结构化时间范围（包含递进后的粒度与来源）。 */
  timeRange?: AnswerTimeRange
  /** 本轮中用户明确重述的字段。 */
  overrides?: ThreadScopeField[]
  /** 分类器给出的意图（若调用方需要）。 */
  intent?: AnswerIntentKind
  /** 媒体追问提示。 */
  mediaTypes?: AnswerMessageReference['mediaTypes']
  /** 消息序号 / 引用方式。 */
  messageRef?: AnswerMessageReference
  /** 本轮最终采用的时间范围是否仍是硬筛选。 */
  timeHard?: boolean
}

/** `applyThreadState` 可用的选项。 */
export interface ApplyThreadStateOptions {
  now?: Date
  /** 已知联系人（用于识别「李四」并写入 activeContact）。 */
  knownEntities?: string[]
  /** 已知会话。 */
  knownSessions?: string[]
  /** 当前会话（会话内问答由服务端强制传入）。 */
  currentSession?: string
}

/** 用户本轮显式覆盖的字段。 */
export type ThreadScopeField =
  | 'session'
  | 'contact'
  | 'timeRange'
  | 'referencedMessage'
  | 'mediaTypes'

const SESSION_RULES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(?:在|和|跟|与)\s*群聊\s*[“"「『]?([^”"」』，,。？?\s]{1,30})/, label: '群聊点名' },
  { re: /(?:会话|聊天)\s*[“"「『]([^”"」』]{1,30})[”"」』]/, label: '会话引号点名' },
  { re: /(?:在|打开)\s*[“"「『]([^”"」』]{1,30})[”"」』]/, label: '引号点名' },
]

const TIME_PROGRESSION_RE =
  /^(?:那|那么|再|还有|另外|继续)|再往前|更早|之前|(?:上|前)(?:个)?(?:周|星期|礼拜|月)|上上|去年|前年|昨天|前天|大前天/

const REFERENCE_PRONOUN_RE = /(?:^|[^其])他(?!们|人)|她(?!们)|对方|这个人|那个人|这位|那位/
const SESSION_DEICTIC_RE = /这个群|这群|本群|该群|当前群|这个群聊|当前群聊|这个会话|该会话|当前会话|本会话|这个聊天|当前聊天/
const MEDIA_MENTION_RE = /\[(图片|视频|文件|语音|链接|表情)\]|(?:这|那|刚才|刚刚)(?:个|张|份|段|条)?(?:图|照片|视频|文件|文档|语音|录音)/
const MESSAGE_KEY_RE = /\b(?:username|session|会话)\s*[=:：]\s*([^\s,，;；]+)\s*[,，;；\s]+(?:local_?id|msg_?id|消息)\s*[=:：]\s*(\d+)/i
const MESSAGE_REF_LABEL_RE = /(?:消息|聊天记录|引用|原文)\s*#?\s*(\d+)/

const MEDIA_LABEL_MAP: Record<string, string> = {
  图片: 'image',
  照片: 'image',
  视频: 'video',
  文件: 'file',
  文档: 'file',
  语音: 'voice',
  录音: 'voice',
  链接: 'link',
  表情: 'sticker',
}

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

function clip(value: string, max: number): string {
  const text = String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function normalizeYmd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(year ?? 0, (month ?? 0) - 1, day ?? 0)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== (month ?? 0) - 1
    || date.getDate() !== day
  ) return undefined
  return text
}

function trimHistory(
  history: ReadonlyArray<AnswerHistoryMessage>,
  options: { maxMessages?: number; maxChars?: number } = {},
): { history: AnswerHistoryMessage[]; omitted: number } {
  const maxMessages = Math.max(1, options.maxMessages ?? THREAD_STATE_MAX_MESSAGES)
  const maxChars = Math.max(80, options.maxChars ?? THREAD_STATE_MAX_CHARS)
  const normalized = (Array.isArray(history) ? history : [])
    .filter(
      (m): m is AnswerHistoryMessage =>
        Boolean(m)
        && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string'
        && m.content.trim().length > 0,
    )
  const selected = normalized.slice(-maxMessages)
  const omitted = Math.max(0, normalized.length - selected.length)
  const kept: AnswerHistoryMessage[] = []
  let used = 0
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const message = selected[i]
    if (!message) continue
    const room = maxChars - used
    if (room <= 40) break
    const limit = Math.min(
      message.role === 'assistant' ? ASSISTANT_MESSAGE_MAX_CHARS : USER_MESSAGE_MAX_CHARS,
      room,
    )
    const content = clip(message.content, limit)
    kept.unshift({ role: message.role, content })
    used += content.length
  }
  return { history: kept, omitted: omitted + (selected.length - kept.length) }
}

function inferMessageKeyFromText(text: string): string | undefined {
  const keyed = MESSAGE_KEY_RE.exec(text)
  if (keyed?.[1]) {
    return keyed[2] ? `${keyed[1]}:${keyed[2]}` : keyed[1]
  }
  const labeled = MESSAGE_REF_LABEL_RE.exec(text)
  return labeled?.[1] ? `message:${labeled[1]}` : undefined
}

function firstMediaType(text: string): string | undefined {
  const tagged = /\[(图片|视频|文件|语音|链接|表情)\]/.exec(text)
  if (tagged?.[1]) return MEDIA_LABEL_MAP[tagged[1]]
  for (const [label, kind] of Object.entries(MEDIA_LABEL_MAP)) {
    if (text.includes(label)) return kind
  }
  return undefined
}

function latestHistoryMessage(
  history: readonly AnswerHistoryMessage[],
): AnswerHistoryMessage | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message?.role === 'user' && message.content.trim()) return message
  }
  return undefined
}

function inferSessionFromHistory(
  history: readonly AnswerHistoryMessage[],
  knownSessions: readonly string[],
): string | undefined {
  const known = knownSessions
    .map(value => String(value ?? '').trim())
    .filter(value => value.length >= 2)
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message?.role !== 'user') continue
    for (const rule of SESSION_RULES) {
      const m = rule.re.exec(message.content)
      if (m?.[1]) return m[1].trim()
    }
    const hit = known
      .filter(value => message.content.includes(value))
      .sort((a, b) => b.length - a.length)[0]
    if (hit) return hit
  }
  return undefined
}

function inferContactFromHistory(
  history: readonly AnswerHistoryMessage[],
  knownEntities: readonly string[],
): { contact?: string; entity?: string } {
  const candidates = knownEntities
    .map(value => String(value ?? '').trim())
    .filter(value => value.length >= 2)
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message?.role !== 'user') continue
    const known = candidates
      .filter(value => message.content.includes(value))
      .sort((a, b) => b.length - a.length)[0]
    if (known) return { contact: known, entity: known }
    const named = /(?:和|跟|与|问|找|联系)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})\s*(?:的|聊|说|联系|问|要|发|在)/.exec(message.content)
    if (named?.[1] && !REFERENCE_PRONOUN_RE.test(named[1])) {
      return { contact: named[1], entity: named[1] }
    }
  }
  return {}
}

/**
 * 从历史构建线程状态。
 *
 * 继承优先级：
 * 1. 本轮 `explicitScope`（服务端强制 / UI 筛选）；
 * 2. 上一轮 `prev`（结构化的 activeSession / activeContact / lastEntity）；
 * 3. 历史文本中最后一个可识别的人名 / 会话 / 消息引用；
 * 4. 兜底无。
 *
 * @param history - 最近对话历史（纯文本消息）。
 * @param prev - 上一轮状态；缺省表示新线程。
 * @param explicitScope - 本轮显式范围。
 * @param now - 当前时刻（仅用于历史中的时间表达，可注入）。
 * @returns 新线程状态。
 */
export function buildThreadState(
  history: ReadonlyArray<AnswerHistoryMessage>,
  prev?: ThreadState,
  explicitScope?: ThreadExplicitScope,
  now: Date = new Date(),
): ThreadState {
  const { history: kept, omitted } = trimHistory(history)
  const latest = latestHistoryMessage(kept)
  const inferred = latest
    ? classifyAnswerIntent(latest.content, {
      history: kept,
      now,
      ...(prev ? { context: prev } : {}),
    })
    : undefined
  const sessionFromHistory = inferSessionFromHistory(kept, [])
  const contactFromHistory = inferContactFromHistory(kept, [prev?.activeContact, prev?.lastEntity]
    .filter((x): x is string => Boolean(x)))
  const latestReference = latest ? inferMessageKeyFromText(latest.content) : undefined
  const explicitUsername = String(explicitScope?.username ?? '').trim()
  const explicitFrom = normalizeYmd(explicitScope?.from)
  const explicitTo = normalizeYmd(explicitScope?.to)

  const timeRange = explicitFrom || explicitTo
    ? {
      from: explicitFrom ?? explicitTo ?? '',
      to: explicitTo ?? explicitFrom ?? '',
    }
    : inferred?.scopeHints?.from || inferred?.scopeHints?.to
      ? {
        from: inferred.scopeHints.from ?? inferred.scopeHints.to ?? '',
        to: inferred.scopeHints.to ?? inferred.scopeHints.from ?? '',
      }
      : prev?.lastTimeRange

  const activeSession = explicitUsername
    || inferred?.scopeHints?.session
    || sessionFromHistory
    || prev?.activeSession
  const activeContact = inferred?.scopeHints?.contact
    || contactFromHistory.contact
    || prev?.activeContact
    || prev?.lastEntity
  const lastEntity = inferred?.scopeHints?.entities?.[0]
    || contactFromHistory.entity
    || prev?.lastEntity
    || activeContact
  const lastReferencedMessage = latestReference
    ?? prev?.lastReferencedMessage
    ?? (inferred?.scopeHints?.messageRef
      ? inferMessageKeyFromText(latest?.content ?? '')
      : undefined)
  const lastIntent = inferred?.kind ?? prev?.lastIntent

  return {
    ...(activeSession ? { activeSession: activeSession } : {}),
    ...(activeContact ? { activeContact: activeContact } : {}),
    ...(timeRange ? { lastTimeRange: timeRange } : {}),
    ...(timeRange && (explicitFrom || explicitTo || prev?.lastTimeHard)
      ? { lastTimeHard: Boolean(explicitFrom || explicitTo) || prev?.lastTimeHard === true }
      : {}),
    ...(lastEntity ? { lastEntity: lastEntity } : {}),
    ...(lastReferencedMessage ? { lastReferencedMessage: lastReferencedMessage } : {}),
    ...(lastIntent ? { lastIntent: lastIntent } : {}),
    turns: (prev?.turns ?? 0) + (kept.some(m => m.role === 'user') ? 1 : 0),
    history: kept,
    ...(omitted > 0 ? { historyOmitted: (prev?.historyOmitted ?? 0) + omitted } : {}),
  }
}

function explicitSession(question: string, knownSessions: readonly string[]): string | undefined {
  for (const rule of SESSION_RULES) {
    const m = rule.re.exec(question)
    if (m?.[1]) return m[1].trim()
  }
  return knownSessions
    .map(value => String(value ?? '').trim())
    .filter(value => value.length >= 2 && question.includes(value))
    .sort((a, b) => b.length - a.length)[0]
}

/**
 * 将本轮问题应用到已有线程状态。
 *
 * 显式覆盖 vs 继承：
 *   · 本轮明确会话 / 时间 / 联系人 / 引用对象 → 直接覆盖；
 *   · 「那上周呢」这类递进 → 相对上轮时间窗前移；
 *   · 「这个群第二条」「刚才那个文件」→ 继承会话并解析消息引用；
 *   · 「他」无历史 → `reason` 中标记需要澄清，不伪造联系人。
 *
 * @param question - 本轮用户问题。
 * @param state - `buildThreadState` 或上一轮运行结果。
 * @param opts - 当前时间、已知实体/会话、服务端强制会话。
 * @returns 可传给检索运行时的范围与可解释 reason。
 */
export function applyThreadState(
  question: string,
  state: ThreadState,
  opts: ApplyThreadStateOptions = {},
): AppliedThreadState {
  const now = opts.now ?? new Date()
  const q = String(question ?? '').trim()
  const reason: string[] = []
  const overrides: ThreadScopeField[] = []
  const previousTime: AnswerTimeRange | undefined = state.lastTimeRange
    ? {
      from: state.lastTimeRange.from,
      to: state.lastTimeRange.to,
      granularity: state.lastTimeGranularity
        ?? (state.lastTimeRange.from === state.lastTimeRange.to ? 'day' : 'range'),
      source: 'inherited',
      label: state.lastTimeRange.from === state.lastTimeRange.to
        ? state.lastTimeRange.from
        : `${state.lastTimeRange.from} 至 ${state.lastTimeRange.to}`,
    }
    : undefined
  const explicitTime = resolveAnswerTimeRange(q, {
    now,
    ...(previousTime ? { previous: previousTime } : {}),
  })
  const followUp = /^(?:那|那么|还有|再|继续|然后)|刚才|刚刚|这个|那个|他|她|对方|上面|前面/.test(q)
  const hardInherited = state.lastTimeHard === true && previousTime !== undefined
  // 本轮问题写明了时间（尤其完整起止区间）时，用户的新指令高于上一轮或
  // UI 遗留的硬筛选。否则界面停在上次单日、问题却明确要求一个月时，
  // 工具层虽然会被执行范围纠正，线程状态却仍保存旧单日，下一轮继续错。
  // 只认「完整起止区间」或「带截止锚点的最近 N」。单纯说「最近说了什么」
  // 仍是模糊追问，必须继续服从界面 / 服务端已锁定的硬范围。
  const restatedRange = resolveExplicitDateRange(q) ?? resolveAnchoredRecentDateRange(q)
  const useExplicit = hardInherited
    ? restatedRange !== undefined && explicitTime !== undefined
    : explicitTime !== undefined
  const timeRange = useExplicit
    ? explicitTime
    : hardInherited
      ? previousTime
      : followUp
        ? previousTime
        : undefined
  if (useExplicit && explicitTime) {
    overrides.push('timeRange')
    reason.push(
      explicitTime.source === 'progression'
        ? `时间递进：${explicitTime.label} → ${explicitTime.from}~${explicitTime.to}`
        : hardInherited
          ? `用户重述时间，覆盖遗留硬筛选：${explicitTime.label}`
          : `显式时间：${explicitTime.label}`,
    )
  } else if (hardInherited) {
    reason.push(`显式筛选范围优先：${previousTime?.from ?? ''}~${previousTime?.to ?? ''}`)
  } else if (timeRange) {
    reason.push(`时间沿用上一轮：${previousTime?.from ?? ''}~${previousTime?.to ?? ''}`)
  } else {
    reason.push('本轮时间独立：问题含新的时间/浏览语义，不沿用上一轮窄时间窗')
  }

  const sessionExplicit = explicitSession(q, opts.knownSessions ?? [])
  const deictic = SESSION_DEICTIC_RE.test(q)
  const session = sessionExplicit
    ?? opts.currentSession
    ?? (deictic ? state.activeSession : undefined)
    ?? state.activeSession
  if (sessionExplicit) {
    overrides.push('session')
    reason.push(`显式会话：${sessionExplicit}`)
  } else if (deictic) {
    overrides.push('session')
    reason.push(session
      ? `当前会话语境：${session}`
      : '用户指代当前会话，但调用方未提供会话标识')
  } else if (state.activeSession) {
    reason.push(`会话沿用上一轮：${state.activeSession}`)
  }

  const knownContacts = unique([
    ...(opts.knownEntities ?? []),
    ...(state.activeContact ? [state.activeContact] : []),
    ...(state.lastEntity ? [state.lastEntity] : []),
  ])
  const namedContact = knownContacts
    .filter(value => value.length >= 2 && q.includes(value))
    .sort((a, b) => b.length - a.length)[0]
  const pronoun = REFERENCE_PRONOUN_RE.test(q)
  const contact = namedContact
    || (pronoun ? state.activeContact ?? state.lastEntity : undefined)
    || state.activeContact
    || state.lastEntity
  if (namedContact) {
    overrides.push('contact')
    reason.push(`显式联系人：${namedContact}`)
  } else if (pronoun) {
    overrides.push('contact')
    reason.push(contact
      ? `代词继承联系人：${contact}`
      : '出现代词「他/她/对方」，但历史中没有可继承的联系人（需要澄清）')
  } else if (state.activeContact) {
    reason.push(`联系人沿用上一轮：${state.activeContact}`)
  }

  const referenceInQuestion = inferMessageKeyFromText(q)
  const mediaMention = MEDIA_MENTION_RE.test(q)
  const referencedMessage = referenceInQuestion ?? state.lastReferencedMessage
  if (referenceInQuestion) {
    overrides.push('referencedMessage')
    reason.push(`显式引用消息：${referenceInQuestion}`)
  } else if (state.lastReferencedMessage) {
    if (mediaMention || /这(?:个|条|张|份|段)|那(?:个|条|张|份|段)|刚才|刚刚|它/.test(q)) {
      reason.push(`指代继承上一轮引用：${state.lastReferencedMessage}`)
    } else {
      reason.push(`保留上一轮引用以备追问：${state.lastReferencedMessage}`)
    }
  }

  const intent = classifyAnswerIntent(q, {
    knownEntities: knownContacts,
    ...(opts.knownSessions ? { knownSessions: opts.knownSessions } : {}),
    ...(session ? { currentSession: session } : {}),
    history: state.history ?? [],
    context: {
      ...(session ? { activeSession: session } : {}),
      ...(contact ? { activeContact: contact } : {}),
      ...(previousTime ? { lastTimeRange: previousTime } : {}),
      ...(state.lastEntity ? { lastEntity: state.lastEntity } : {}),
      ...(state.lastReferencedMessage ? { lastReferencedMessage: state.lastReferencedMessage } : {}),
      ...(state.lastIntent ? { lastIntent: state.lastIntent } : {}),
    },
    now,
  })
  if (intent.scopeHints?.mediaTypes && intent.scopeHints.mediaTypes.length > 0) {
    overrides.push('mediaTypes')
    reason.push(`媒体追问：${intent.scopeHints.mediaTypes.join('/')}`)
  }
  const resolvedContact = intent.scopeHints?.contact ?? contact
  const resolvedSession = intent.scopeHints?.session ?? session
  if (resolvedContact && !contact) reason.push(`联系人来自意图：${resolvedContact}`)
  if (resolvedSession && !session) reason.push(`会话来自意图：${resolvedSession}`)
  if (intent.needsClarification) {
    reason.push(`需要澄清：${intent.reason}`)
  }

  return {
    ...(timeRange?.from ? { from: timeRange.from } : {}),
    ...(timeRange?.to ? { to: timeRange.to } : {}),
    ...(resolvedSession ? { session: resolvedSession } : {}),
    ...(resolvedContact ? { contact: resolvedContact } : {}),
    ...(referencedMessage ? { referencedMessage } : {}),
    ...(timeRange ? { timeRange } : {}),
    // 用户本轮重述的时间已经取代旧硬筛选，下一轮应可按新范围正常递进。
    ...(timeRange ? { timeHard: hardInherited && !useExplicit } : {}),
    ...(overrides.length > 0 ? { overrides: unique(overrides) as ThreadScopeField[] } : {}),
    ...(intent.scopeHints?.mediaTypes ? { mediaTypes: intent.scopeHints.mediaTypes } : {}),
    ...(intent.scopeHints?.messageRef ? { messageRef: intent.scopeHints.messageRef } : {}),
    intent: intent.kind,
    reason,
  }
}

/**
 * 本轮回答完成后推进线程状态（供运行时在 `persistAnswerTrace` 后调用）。
 *
 * `buildThreadState` 偏重「从纯历史重建」；这个函数偏重「在已有状态上追加
 * 本轮结果」，避免运行时为了更新状态再把全部历史跑一遍。
 * @param prev - 上一轮状态。
 * @param turn - 本轮问题、意图与回答（回答只留短摘要，不落全文）。
 * @param options - 字符预算等。
 * @returns 新状态。
 */
export function advanceThreadState(
  prev: ThreadState,
  turn: {
    question: string
    answer?: string
    intent?: AnswerIntentKind
    applied?: AppliedThreadState
    referencedMessage?: string
  },
  options: { maxMessages?: number; maxChars?: number } = {},
): ThreadState {
  const nextHistory = [
    ...(prev.history ?? []),
    { role: 'user' as const, content: turn.question },
    ...(turn.answer?.trim() ? [{ role: 'assistant' as const, content: turn.answer }] : []),
  ]
  const { history, omitted } = trimHistory(nextHistory, options)
  const applied = turn.applied
  const range = applied?.timeRange
  return {
    ...(applied?.session ?? prev.activeSession ? { activeSession: applied?.session ?? prev.activeSession } : {}),
    ...(applied?.contact ?? prev.activeContact ? { activeContact: applied?.contact ?? prev.activeContact } : {}),
    ...(range ?? prev.lastTimeRange
      ? { lastTimeRange: range ? { from: range.from, to: range.to } : prev.lastTimeRange }
      : {}),
    ...(range
      ? { lastTimeHard: applied?.timeHard === true }
      : prev.lastTimeHard !== undefined
        ? { lastTimeHard: prev.lastTimeHard }
        : {}),
    ...(applied?.contact ?? prev.lastEntity
      ? { lastEntity: applied?.contact ?? prev.lastEntity }
      : {}),
    ...(turn.referencedMessage ?? applied?.referencedMessage ?? prev.lastReferencedMessage
      ? {
        lastReferencedMessage:
          turn.referencedMessage ?? applied?.referencedMessage ?? prev.lastReferencedMessage,
      }
      : {}),
    ...(turn.intent ?? prev.lastIntent ? { lastIntent: turn.intent ?? prev.lastIntent } : {}),
    turns: prev.turns + 1,
    history,
    ...(range ? { lastTimeGranularity: range.granularity } : prev.lastTimeGranularity
      ? { lastTimeGranularity: prev.lastTimeGranularity }
      : {}),
    ...(omitted > 0 ? { historyOmitted: (prev.historyOmitted ?? 0) + omitted } : {}),
  }
}
