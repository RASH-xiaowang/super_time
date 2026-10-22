/**
 * 问答运行时的提示词、结果映射与兜底文案（2026-10-22 自 `askdeep.ts` 抽出）。
 *
 * 这一层只放纯函数与不持有状态的辅助逻辑，生产编排在 `ask-runtime.ts`。
 * 拆开的目的不是缩行数，而是把「模型看到什么」与「运行时怎么调工具」分开：
 * 前者可单独审阅，后者才能按 profile 强制边界。
 *
 * @module remotes/ask-runtime-prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { formatAskContext, parseCitedIndexes } from '../query/ask.ts'
import type { AnswerIntentDecision } from '../query/answer-runtime/intent.ts'
import type {
  AnswerRuntimeCitation,
  AnswerRuntimeResourceCitation,
} from '../query/answer-runtime/types.ts'
import type { AnswerStatus, EvidenceBundle } from '../query/answer-runtime/evidence.ts'
import type { AnswerProfileId } from '../query/tools/profiles.ts'
import { auditGrounding, groundingRepairHint, stripCitationMarkers } from '../query/grounding.ts'
import type { GroundingReplyMode } from '../query/grounding.ts'
import type { AskCitation } from '../types.ts'
import type { RunChatFn } from './ask-run-chat.ts'

/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
export interface AskImageInput {
  data: string
  mediaType: string
  name?: string
}

/** 本轮问答的数据面。 */
export type AskDataScope = 'wechat' | 'kb-only'

/** 一次问答的范围。 */
export interface AskScope {
  username?: string
  from?: string
  to?: string
}

/** 自动回复的聊天兜底提示词。 */
export function buildEmptyChatPrompt(
  question: string,
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [],
  imageNote = '',
): string {
  const historyBlock = history.length > 0
    ? '\n\n此前对话（保持连贯，别把上一轮说过的事当没发生）：\n'
      + history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n')
    : ''
  const imageBlock = imageNote !== '' ? '\n\n关于图片：' + imageNote : ''
  return `用户发来一条微信消息：${question}${historyBlock}${imageBlock}

  你**没有**任何可参考的材料（知识库里没检索到相关内容）。请按以下要求回一句：
  1. **像真人发微信那样**：口语、简短、自然，每条不超过 30 字。寒暄就正常寒暄（「在的」「嗯嗯」），问事就说没查到。
  2. **开场跟着对方的话走**：「在的」只在对方问「在吗 / 在不在」时用；对方说别的就直接接话，不要用万能开场。
  3. **先回应对方说的内容，再说别的**：对方说「我明天去北京」，先接「出差啊」再往下；不要一上来就说「我这边没查到」。
  4. **闲聊就闲聊**：对方在开玩笑、发牢骚、说天气，就顺着聊，不要硬往「查资料」上引。不是每句话都需要回答。
  5. **绝对不要编造**具体事实：金额、日期、人名、地址、承诺一律不许猜。不知道就说不知道。
  6. **不要标 [n] 角标**：微信里没有可点的角标，标了就是乱码。要说明是谁说的，直接写名字。
  7. **不要提「知识库」「检索」「材料」这类词** —— 对方不知道你在查什么，说了很奇怪。
  8. **不要解释你自己**：不要写「注：」「说明：」「（不编号了）」这类元信息，也不要提引用、编号、来源。你就是在聊天，不是在写文档。
  9. 需要本人决定的事（借钱、签约、敏感话题），回一句「这个我得问下本人」比硬答更好。
  10. 内容确实长时按语义分段（段间空一行），像人连发几条那样。`
}

/** 解析本次问答要用的系统提示词。 */
export function resolveSystemPrompt(override: string | undefined, dataScope?: AskDataScope): string {
  if (override !== undefined && override.trim() !== '') return override
  if (dataScope === 'kb-only') {
    return '你是用户微信里的自动回复助手。只用下面给出的检索材料回答，像真人发微信一样口语、简短；每段不超过 30 字，不标 [n] 角标；材料里没有的就直说没查到，绝不推测或编造。'
  }
  return '你是用户微信聊天记录里的问答助手。只用下面给出的检索结果回答，说话自然、口语化，像在微信里跟人转述聊天内容；每句事实后面用 [n] 标注来源；记录里没有的就说没找到，绝不推测或编造。'
}

/** 构造用户消息里的回答规则。 */
export function buildSynthRules(dataScope: AskDataScope | undefined, timeGuardRule: string): string {
  if (dataScope === 'kb-only') {
    return `
  请按以下要求回答（你在**微信里跟人聊天**，不是在写报告）：
  1. **只用材料里的事实**：材料里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期。宁可少说，也不要编。
  2. **像真人发微信那样说话**：口语、简短、自然。不要写成报告或分析（不要「综上所述」「根据数据分析」「经梳理」这类腔调），不要复述检索过程，不要罗列来源。
  3. **每条不超过 30 字**：这是硬要求。一句话说不完就**分成几条**，每条独立成段（用空行隔开），像人连发几条微信那样。宁可分 3 条短的，也不要写 1 条长的。
  4. **不要标 [n] 角标**：微信里没有可点的角标，标了就是乱码。要说明是谁说的，直接写名字（如「小何说」）。
  5. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述。
  6. **找不到就直说**：材料不足以回答时，直接说「这个我这边没查到」，再问一句要不要换个说法。不要用推测填空。${timeGuardRule}`
  }
  return `
  请按以下要求回答：
  1. **只用材料里的事实**：上面检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期、时间。宁可少说，也不要编。金额、日期、电话/卡号这类值**只能原样照抄**材料里的写法 —— 要说合计就写明由哪几条相加（如「3500+3500=7000」），不要自行换算单位或推算日期。
  2. **像微信里跟人说话那样自然**：口语化中文，直接把事情讲清楚，不要写成报告或分析（不要「综上所述」「根据数据分析」「经梳理」这类腔调），也不要复述检索过程。要罗列多条时可以分点，但每条都要像在转述聊天内容。
  3. **每条事实后面标 [n]**：例如「小何说收到转账 13.00 元 [1]」，多个来源写 [1][3]。材料里形如「群名 · 某人」的，要说清是谁说的。
  4. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述。
  5. **找不到就直说**：材料不足以回答时，直接说明「聊天记录里没有找到……」，再给 1-2 条改问建议（换关键词、收窄时间或指定会话）。不要用推测填空。
  6. 只引用真正支持结论的那几条来源，不要罗列全部；也不用写「依据本机记录」这类来源说明，界面上已单独显示。${timeGuardRule}`
}

/** 「没检索到原文」时的回答文案。 */
export function emptyAnswerText(
  dataScope: AskDataScope | undefined,
  profile: AnswerProfileId = 'wechat-ask',
): string {
  if (dataScope === 'kb-only') {
    return '知识库里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词，或在实例设置里换一个知识库。'
  }
  if (profile === 'session-ask') {
    return '当前会话里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词，或补充更具体的时间与人物。'
  }
  return '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。'
}

/** 自动回复核对失败后的安全文案。 */
export const CHAT_WITHHELD_ANSWER = '这个数字我这边没法确认，我先问下本人。'

/** 检索范围（只保留非空字段）。 */
export function buildAskScope(options: {
  username?: string
  from?: string
  to?: string
}): AskScope {
  return {
    username: typeof options.username === 'string' && options.username ? options.username : undefined,
    from: typeof options.from === 'string' && options.from ? options.from : undefined,
    to: typeof options.to === 'string' && options.to ? options.to : undefined,
  }
}

/** 多轮上下文裁剪：最多 16 条，并受总字数预算约束。 */
export function trimAskHistory(
  historyRaw: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history = (Array.isArray(historyRaw) ? historyRaw : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-16)
  const budget = 4000
  let used = 0
  const trimmed: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of [...history].reverse()) {
    const room = budget - used
    if (room <= 80) break
    const text = m.content.trim().slice(0, Math.min(m.role === 'assistant' ? 1200 : 400, room))
    trimmed.unshift({ role: m.role, content: text })
    used += text.length
  }
  return trimmed
}

/** 图片准备结果。 */
export interface PreparedAskImages {
  blocks: ImageBlock[]
  note: string
  audit: string
}

async function admitAskImages(ctx: Context, images: readonly AskImageInput[]): Promise<{ blocks: ImageBlock[]; note: string }> {
  if (images.length === 0) return { blocks: [], note: '' }
  const attachments = (ctx as unknown as {
    attachments?: {
      admitPromptContent?: (parts: unknown[]) => Promise<Array<{ type?: string }>>
    }
  }).attachments
  if (attachments?.admitPromptContent === undefined) {
    return { blocks: [], note: '（对方发来图片，但当前运行环境没有可用的附件服务，无法识别图片内容。）' }
  }
  try {
    const parts: unknown[] = [
      { type: 'text', text: '（以下是对方在微信里发来的图片）' },
      ...images.slice(0, 2).map(i => ({
        type: 'image',
        data: i.data,
        mediaType: i.mediaType,
        ...(i.name === undefined ? {} : { name: i.name }),
      })),
    ]
    const admitted = await attachments.admitPromptContent(parts)
    const blocks = admitted.filter((b): b is ImageBlock => b !== null && typeof b === 'object' && b.type === 'image')
    return blocks.length > 0
      ? { blocks, note: '' }
      : { blocks: [], note: '（图片读取失败，无法识别图片内容。）' }
  } catch {
    return { blocks: [], note: '（图片读取失败，无法识别图片内容。）' }
  }
}

/** 把图片准备成消息块；宿主没有附件服务时直接交给桥接层投影。 */
export async function prepareAskImages(
  ctx: Context,
  llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }> } | undefined,
  provider: string,
  model: string,
  images: readonly AskImageInput[],
): Promise<PreparedAskImages> {
  if (images.length === 0) return { blocks: [], note: '', audit: '' }
  const attachments = (ctx as unknown as { attachments?: { admitPromptContent?: unknown } }).attachments
  if (typeof attachments?.admitPromptContent !== 'function') {
    const blocks = images.map(im => ({
      type: 'image',
      data: im.data,
      mediaType: im.mediaType,
      ...(im.name === undefined ? {} : { name: im.name }),
    } as unknown as ImageBlock))
    return { blocks, note: '', audit: `随问题发送图片 ${String(blocks.length)} 张（OpenAI 兼容 image_url）` }
  }
  let vision = false
  try {
    const info = llm?.resolveModelInfo === undefined ? undefined : await llm.resolveModelInfo(provider, model)
    vision = info?.inputModalities?.includes('image') === true
  } catch {
    vision = false
  }
  if (!vision) {
    return {
      blocks: [],
      note: '（对方发来图片，但当前对话模型不支持读图，无法识别图片内容；请如实告诉对方看不到图片内容，不要说「没收到图片」。）',
      audit: '',
    }
  }
  const got = await admitAskImages(ctx, images)
  return {
    blocks: got.blocks,
    note: got.note,
    audit: got.blocks.length > 0 ? `随问题发送图片 ${String(got.blocks.length)} 张` : '',
  }
}

/** 图片被供应商拒绝时的说明。 */
export const IMAGE_UNSUPPORTED_NOTE = '\n\n（注意：当前模型看不到随消息附的图片，无法识别图片内容；请如实告诉对方看不到图片内容，不要说「没收到图片」。）'

/** 累加一次模型调用的 usage。 */
export function addTokenUsage(acc: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (next === undefined) return acc
  const base: TokenUsage = acc ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const sum = (a: number | undefined, b: number | undefined): number => (a ?? 0) + (b ?? 0)
  return {
    inputTokens: sum(base.inputTokens, next.inputTokens),
    outputTokens: sum(base.outputTokens, next.outputTokens),
    totalTokens: sum(base.totalTokens, next.totalTokens),
    ...(sum(base.cacheReadTokens, next.cacheReadTokens) > 0 ? { cacheReadTokens: sum(base.cacheReadTokens, next.cacheReadTokens) } : {}),
    ...(sum(base.cacheWriteTokens, next.cacheWriteTokens) > 0 ? { cacheWriteTokens: sum(base.cacheWriteTokens, next.cacheWriteTokens) } : {}),
    ...(sum(base.reasoningTokens, next.reasoningTokens) > 0 ? { reasoningTokens: sum(base.reasoningTokens, next.reasoningTokens) } : {}),
  }
}

/** 图片被供应商拒绝时按纯文本重试。 */
export async function runChatWithImagesFallback(
  runChat: RunChatFn,
  op: (category: 'task', action: string, status: 'fail', target: string, detail: string) => void,
  system: string,
  userText: string,
  maxTokens: number,
  onDelta?: (text: string) => void,
  onReasoning?: (text: string) => void,
  images?: readonly ImageBlock[],
): Promise<string> {
  if (images === undefined || images.length === 0) return runChat(system, userText, maxTokens, onDelta, onReasoning)
  try {
    return await runChat(system, userText, maxTokens, onDelta, onReasoning, images)
  } catch (e) {
    op('task', 'ask_wechat', 'fail', 'image_send', '图片未能送模型，已按纯文本重试：' + (e instanceof Error ? e.message : String(e)))
    return runChat(system, userText + IMAGE_UNSUPPORTED_NOTE, maxTokens, onDelta, onReasoning)
  }
}

/**
 * 回答的数据来源说明。
 *
 * 「原文」只统计聊天消息；知识库按文件、聚合事实按条、资源按个分别单列。
 */
export function askBasisLine(
  citations: ReadonlyArray<{
    time?: string
    username?: string
    source?: 'msg' | 'kb' | 'agg' | 'resource'
    kb?: { fileId?: number; fileName?: string }
    snippet?: string
  }>,
  dataScope?: AskDataScope,
  resourceCount = 0,
): string {
  if (citations.length === 0 && resourceCount === 0) return ''
  const msgs = citations.filter(c => c.source !== 'kb' && c.source !== 'agg' && c.source !== 'resource')
  const kbItems = citations.filter(c => c.source === 'kb')
  const aggItems = citations.filter(c => c.source === 'agg')
  const sessions = new Set(msgs.map(c => (c.username ?? '').trim()).filter(Boolean)).size
  const days = msgs.map(c => (c.time ?? '').slice(0, 10)).filter(Boolean).sort()
  const span = days.length > 0 ? ` · ${days[0]} ~ ${days[days.length - 1]}` : ''
  const parts: string[] = []
  // 依据行只把聊天消息称作「原文」；知识库、聚合事实与资源各自单列。
  if (msgs.length > 0) {
    parts.push(`${msgs.length} 条聊天原文`)
    if (sessions > 0) parts.push(`${sessions} 个会话`)
  }
  if (kbItems.length > 0) {
    const files = new Set(kbItems.map(c => {
      const fileId = c.kb?.fileId
      if (fileId !== undefined && fileId > 0) return `f${String(fileId)}`
      return (c.kb?.fileName ?? c.snippet ?? '').trim()
    }).filter(Boolean))
    if (files.size > 0) parts.push(`${files.size} 个知识库文件`)
  }
  if (aggItems.length > 0) parts.push(`${aggItems.length} 条统计事实`)
  if (resourceCount > 0) parts.push(`${resourceCount} 个相关资源`)
  return `${dataScope === 'kb-only' ? '依据知识库' : '依据本机记录'}：${parts.join(' · ')}${span}`
}

/** 归一知识库 id。 */
export function normalizeKbId(kbId: number | undefined): number | undefined {
  return Number.isFinite(kbId) && (kbId ?? 0) > 0 ? Math.trunc(kbId as number) : undefined
}

/** 选择入口 profile。 */
export function selectAskProfile(options: {
  source?: string
  dataScope?: AskDataScope
}): AnswerProfileId {
  if (options.source === 'session') return 'session-ask'
  if (options.dataScope === 'kb-only' || options.source === 'auto') return 'clawbot-auto'
  return 'wechat-ask'
}

/** 工具选择阶段的系统提示：只讲规则与范围，不塞原始证据。 */
export function buildToolSelectionSystem(input: {
  profile: AnswerProfileId
  dataScope?: AskDataScope
  scope: AskScope
  kbId?: number
  question: string
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  imageNote: string
  now: Date
}): string {
  const today = `${input.now.getFullYear()}-${String(input.now.getMonth() + 1).padStart(2, '0')}-${String(input.now.getDate()).padStart(2, '0')}`
  const scope = [
    input.profile === 'session-ask'
      ? `当前会话已锁定为 ${input.scope.username ?? '（缺失）'}，不得查询其他会话`
      : input.scope.username ? `会话限定 ${input.scope.username}` : '会话不限',
    input.scope.from ? `起始 ${input.scope.from}` : '',
    input.scope.to ? `截止 ${input.scope.to}` : '',
    input.kbId !== undefined ? `知识库 ${String(input.kbId)}` : '未选择知识库',
    input.dataScope === 'kb-only' ? '数据面仅知识库，禁止访问本机微信数据' : '',
  ].filter(Boolean).join('；')
  const history = input.history.length > 0
    ? '\n最近对话（只用于理解指代，不得当作事实证据）：\n'
      + input.history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n')
    : ''
  const image = input.imageNote !== '' ? `\n图片说明：${input.imageNote}` : ''
  return `今天是 ${today}。你是一个检索工具选择器，不是最终回答器。
用户问题：${input.question}
执行边界：${scope}${history}${image}

你的任务：
1. 只选择并调用必要的检索工具，收集能回答问题的原文或确定性统计；
2. 不要臆造工具结果，不要把常识当成本机记录；
3. 如果问题适合综合检索，优先用 search_hybrid；明确统计用 aggregate_messages；明确会话内上下文用 get_session_messages 或 get_message_context；
4. 同一工具同一参数不要重复调用；参数必须符合 schema；
5. 明确问文件用 search_files、收藏用 search_favorites、朋友圈用 search_moments、转账红包用 search_records、联系人用 search_contacts；
6. 不要用一个泛化检索工具替代这些明确的数据域；对应工具没有命中时再考虑 search_hybrid；
7. 工具阶段不要写最终回答。完成检索后停止调用工具，由后续综合阶段生成答案。`
}

/** 本轮工具范围的人话描述。 */
export function describeAskScope(scope: AskScope, profile: AnswerProfileId): string {
  if (profile === 'clawbot-auto') return '仅知识库'
  const parts = [
    profile === 'session-ask' ? '当前会话' : scope.username ? '会话限定' : '全库',
    scope.from ? `起 ${scope.from}` : '',
    scope.to ? `止 ${scope.to}` : '',
  ].filter(Boolean)
  return parts.join(' ')
}

/** 时间线索护栏：有范围时要求模型逐条写真实日期。 */
export function buildTimeGuardRule(intent: AnswerIntentDecision, evidence: EvidenceBundle): string {
  const range = intent.scopeHints?.timeRange
  if (!range?.from && !range?.to) return ''
  const from = range.from || range.to
  const to = range.to || range.from
  const hits = evidence.items.filter(item => {
    const day = (item.time || '').slice(0, 10)
    return day !== '' && day >= from && day <= to
  }).length
  const label = from === to ? from : `${from} ~ ${to}`
  if (hits > 0) {
    return `\n7. **时间范围**：材料里有 ${String(hits)} 条落在 ${label} 内，可以按该范围陈述。`
  }
  return `\n7. **时间范围（重要）**：检索在 ${label} 内**一条都没找到**，下面列出的片段全部来自**其他日期**。必须先明确说一句「${label} 这段时间没有找到相关记录」，然后才可以说「另外在 X 月 X 日聊过……」并**逐条写出这些内容的真实日期**。绝对不要把其他日期的内容说成是该时间范围内发生的。`
}

/** 资源证据不伪装成消息引用，而是作为独立材料块给模型。 */
function formatResourceBlock(resources: readonly AnswerRuntimeResourceCitation[]): string {
  if (resources.length === 0) return ''
  const lines = resources.map((item, index) => {
    const when = item.time ? `（${item.time}）` : ''
    return `R${String(index + 1)} ${item.name}${when}：${item.snippet}`
  })
  return `\n\n【文件 / 收藏 / 朋友圈等独立资源】\n${lines.join('\n')}\n这些资源没有消息引用编号，不得伪造 [n]；需要提及时直接写资源名称。`
}

/** 用运行时引用与资源构造综合生成上下文。 */
export function buildRuntimeContext(input: {
  citations: readonly AnswerRuntimeCitation[]
  resources: readonly AnswerRuntimeResourceCitation[]
  intent: AnswerIntentDecision
  terms: string[]
  scope: string
  recency: boolean
  timeHint?: string
  hintHits?: number
}): string {
  const citations = input.citations.map(citationToAskCitation)
  const base = formatAskContext(citations, {
    intent: input.intent.reason,
    terms: input.terms,
    scope: input.scope,
    recency: input.recency,
    ...(input.timeHint ? { timeHint: input.timeHint } : {}),
    ...(input.hintHits !== undefined ? { hintHits: input.hintHits } : {}),
  })
  return `${base}${formatResourceBlock(input.resources)}`
}

/** 运行时引用 → 旧 AskCitation（只保留公开字段）。 */
export function citationToAskCitation(citation: AnswerRuntimeCitation): AskCitation {
  return {
    name: citation.name,
    time: citation.time,
    snippet: citation.snippet,
    username: citation.username,
    local_id: citation.local_id,
    ...(citation.sender ? { sender: citation.sender } : {}),
    ...(citation.source ? { source: citation.source } : {}),
    ...(citation.kb ? { kb: citation.kb } : {}),
  }
}

/** 构造综合生成提示词。 */
export function buildSynthesisPrompt(input: {
  question: string
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  imageHint: string
  contextBlock: string
  dataScope?: AskDataScope
  timeGuardRule: string
}): string {
  const historyBlock = input.history.length > 0
    ? '此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n'
      + input.history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n') + '\n\n'
    : ''
  const imageHint = input.imageHint !== '' ? '\n关于图片：' + input.imageHint : ''
  return `${historyBlock}用户本次问题：${input.question}${imageHint}

${input.contextBlock}
${buildSynthRules(input.dataScope, input.timeGuardRule)}`
}

/** 运行时的证据正文，按 evidenceId 索引。 */
export function evidenceTexts(evidence: EvidenceBundle): Map<string, string> {
  const out = new Map<string, string>()
  for (const item of evidence.items) {
    const head = `${item.name} ${item.sender ?? ''} ${item.time}`.trim()
    out.set(item.evidenceId, `${head}\n${item.snippet}`)
  }
  return out
}

/** 资源正文（参与接地审计，但不计入 [n]）。 */
export function resourceTexts(resources: readonly AnswerRuntimeResourceCitation[]): string[] {
  return resources.map(item => `${item.name} ${item.time}\n${item.snippet}`)
}

/** 证据使用校验时忽略的功能字/泛词，避免“这个/可以/一下”让无关回答蒙混过关。 */
const SUPPORT_NOISE = new Set(
  '的了是我你他她它们在有和就都也很还要会能可这那么吗呢吧啊呀哦嗯给过把被让使得着地谁哪几多少么什怎与跟一下一个这个那个什么可以需要已经就是没有不是'.split(''),
)

function compactText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 回答是否实际使用了给定证据。
 *
 * 自动回复没有 [n] 角标，仅“存在引用”不能证明模型真的用了材料：模型完全
 * 可能返回一段通用话术。这里用确定性的内容重合做保守校验：
 *   · 回答里 ≥4 个连续汉字原样出现在证据中，直接通过；
 *   · 否则比较去噪后的汉字二元组，短回答至少重合 1 个、长回答至少 2 个；
 *   · 英文/型号词至少重合 1 个长度 ≥3 的词。
 * 这不能替代语义审查，但能拦住“有引用、回答却完全无关”的无人值守发送。
 */
export function hasEvidenceSupport(answer: string, evidenceTexts: readonly string[]): boolean {
  const evidence = evidenceTexts.filter(Boolean).join('\n')
  const compactAnswer = compactText(answer)
  const compactEvidence = compactText(evidence)
  if (compactAnswer === '' || compactEvidence === '') return false

  for (const run of answer.match(/[\u3400-\u9fff]{4,}/g) ?? []) {
    if (compactEvidence.includes(compactText(run))) return true
  }

  const bigrams = (text: string): Set<string> => {
    const out = new Set<string>()
    for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
      for (let i = 0; i + 1 < run.length; i += 1) {
        const pair = run.slice(i, i + 2)
        if (SUPPORT_NOISE.has(pair[0] ?? '') || SUPPORT_NOISE.has(pair[1] ?? '')) continue
        out.add(pair)
      }
    }
    return out
  }
  const answerPairs = bigrams(answer)
  const evidencePairs = bigrams(evidence)
  let shared = 0
  for (const pair of answerPairs) {
    if (evidencePairs.has(pair)) shared += 1
  }
  if (shared >= (compactAnswer.length <= 12 ? 1 : 2)) return true

  const words = (text: string): Set<string> => new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}/g) ?? []).filter(word => !SUPPORT_NOISE.has(word)),
  )
  const evidenceWords = words(evidence)
  for (const word of words(answer)) {
    if (evidenceWords.has(word)) return true
  }
  return false
}

/**
 * 按场景完成接地核对与最多一次回炉。
 *
 * 与旧实现保持同一协议：手动问答要求 [n]；自动回复禁止 [n]，但高风险值仍核对。
 */
export async function resolveGroundedAnswer(input: {
  /**
   * `resource` 只用于「文件/收藏/朋友圈等资源」作为唯一证据的回答：
   * 它和自动回复一样禁止 [n]，但不套用微信闲聊口吻。
   */
  mode: GroundingReplyMode | 'resource'
  answer: string
  citationCount: number
  synthPrompt: string
  evidenceFor: (cited: number[]) => string[]
  allEvidence: string[]
  systemPrompt: string
  runChat: RunChatFn
  images?: readonly ImageBlock[]
}): Promise<{
  answer: string
  citedIndexes: number[]
  withheld: boolean
  grounding: ReturnType<typeof auditGrounding>
  repaired: boolean
  /** 回答是否与证据有可验证的内容重合（`chat` / `resource` 模式使用）。 */
  evidenceUsed: boolean
}> {
  const auditMode: GroundingReplyMode = input.mode === 'cited' ? 'cited' : 'chat'
  const resourceOnly = input.mode === 'resource'
  // 完全没有证据时走的是聊天兜底，不能用「回答必须使用证据」把正常寒暄撤回。
  const chatFallbackWithoutEvidence = !resourceOnly
    && !input.allEvidence.some(text => text.trim() !== '')
  const auditFor = (text: string, cited: number[]): ReturnType<typeof auditGrounding> =>
    auditGrounding(
      text,
      auditMode === 'chat' ? input.allEvidence : input.evidenceFor(cited),
      input.citationCount,
      { requireCitationMarkers: auditMode === 'cited' },
    )

  let citedIndexes = parseCitedIndexes(input.answer, input.citationCount)
  let grounding = auditFor(input.answer, citedIndexes)
  let evidenceUsed = auditMode === 'chat'
    ? chatFallbackWithoutEvidence || hasEvidenceSupport(input.answer, input.allEvidence)
    : true
  const protocolNeedsRepair = input.mode === 'cited'
    && (citedIndexes.length === 0 || grounding.uncited > 0)
  const needsRepair = protocolNeedsRepair
    || grounding.unsupported.length > 0
    || (auditMode === 'chat' && !evidenceUsed)
  let finalAnswer = input.answer
  let repaired = false

  if (needsRepair) {
    const repairHint = groundingRepairHint(grounding, auditMode)
    const strictPrompt = auditMode === 'chat'
      ? resourceOnly
        ? `${input.synthPrompt}

  【重要】请重写上一次的回答，只修事实与表达，不要解释你正在重写。
  ${repairHint}
  ${!evidenceUsed ? ' · 上一次的回答没有实际使用任何一条检索材料中的具体内容。\n' : ''}
   · 这些资源没有消息角标，不要标 [n]，需要提及时直接写资源名称；
   · 不要提引用、来源、材料或核对过程；
   · 日期与金额只能写资源材料里原样出现的值。`
        : `${input.synthPrompt}

  【重要】请重写上一次的微信自动回复，只修事实与表达，不要解释你正在重写。
  ${repairHint}
  ${!evidenceUsed ? ' · 上一次的回答没有实际使用任何一条知识库材料中的具体内容。\n' : ''}
   · 仍然只使用检索材料里的事实，像真人发微信一样简短口语化；
   · 不要标 [n]，不要提引用、来源、材料、核对或“上一次回答”；
   · 如果材料不足以确认关键数字，就说「这个数字我这边没法确认，我先问下本人」。`
      : `${input.synthPrompt}

  【重要】请重写上一次的回答，逐条修掉下面的问题。
  ${citedIndexes.length === 0 ? ' · 上一次的回答**没有标注任何 [n] 来源**。\n' : ''}${repairHint ? repairHint + '\n' : ''} · 每一句事实性陈述后面都必须紧跟对应的 [n]，且只标真正支持这句话的那几条；
   · 语气保持自然口语化，像在微信里转述聊天内容；
   · 如果检索结果不足以回答，只输出一句话：「本机记录中没有找到可据以回答的证据」。`
    const second = await input.runChat(
      auditMode === 'chat'
        ? input.systemPrompt
        : '你是用户微信聊天记录里的问答助手。只用给定检索结果回答，自然口语化，每句事实标注 [n]；记录里没有就直说没找到，不要推测或编造。',
      strictPrompt,
      auditMode === 'chat' ? 400 : 1600,
      undefined,
      undefined,
      input.images,
    )
    const secondCited = parseCitedIndexes(second, input.citationCount)
    const secondAudit = auditFor(second, secondCited)
    const secondUsed = auditMode === 'chat'
      ? chatFallbackWithoutEvidence || hasEvidenceSupport(second, input.allEvidence)
      : true
    const protocolOk = auditMode === 'chat' || secondCited.length > 0
    const fewerUnsupported = secondAudit.unsupported.length < grounding.unsupported.length
    const supportImproved = secondUsed && !evidenceUsed
    const sameUnsupportedWithMoreCitations = auditMode === 'cited'
      && secondAudit.unsupported.length === grounding.unsupported.length
      && secondCited.length > citedIndexes.length
    if (protocolOk && (fewerUnsupported || sameUnsupportedWithMoreCitations || supportImproved)) {
      finalAnswer = second
      citedIndexes = secondCited
      grounding = secondAudit
      evidenceUsed = secondUsed
      repaired = true
    }
  }

  let withheld = false
  if (auditMode === 'chat') {
    finalAnswer = stripCitationMarkers(finalAnswer)
    citedIndexes = []
    if (grounding.unsupported.length > 0) {
      withheld = true
      finalAnswer = resourceOnly
        ? '找到的资源内容不足以核对这次回答中的关键数字或日期，因此没有直接采用模型结论。请打开下方资源确认，或换一个更具体的问法。'
        : CHAT_WITHHELD_ANSWER
    }
    grounding = { ...grounding, cited: [] }
    if (!evidenceUsed) {
      withheld = true
      finalAnswer = resourceOnly
        ? '找到的资源没有在模型回答中被实际使用，因此没有直接采用模型结论。请打开下方资源确认，或换一个更具体的问法。'
        : CHAT_WITHHELD_ANSWER
    }
  } else if (citedIndexes.length === 0) {
    withheld = true
    finalAnswer = '本机记录中没有找到可据以回答的证据（模型给出的内容无法对应到任何一条原文，已不予采用）。可以换关键词、收窄时间范围或指定会话后重试。'
  }

  return { answer: finalAnswer, citedIndexes, withheld, grounding, repaired, evidenceUsed }
}

/** 运行态状态 → 旧结果的 insufficient 口径。 */
export function isInsufficientStatus(status: AnswerStatus): boolean {
  return status === 'insufficient'
}

/** 提问消息（工具阶段与兜底阶段共用）。 */
export function buildQuestionContent(
  question: string,
  images: readonly ImageBlock[],
): Array<{ type: 'text'; text: string } | ImageBlock> {
  return [{ type: 'text', text: question }, ...images]
}

/** 供编排层判断消息是否携带工具结果。 */
export function hasToolResult(messages: readonly Message[]): boolean {
  return messages.some(message => message.content.some(block => block.type === 'tool-result'))
}
