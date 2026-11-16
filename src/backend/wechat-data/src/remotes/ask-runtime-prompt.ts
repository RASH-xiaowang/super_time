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
import {
  MANUAL_QA_OUTPUT_PRONOUN_REMINDER,
  MATERIAL_BEGIN_MARKER,
  MATERIAL_END_MARKER,
  UNTRUSTED_MATERIAL_RULE,
  WECHAT_QA_SYSTEM_PROMPT,
  formatConversationHistory,
  withManualQaPersonaRules,
} from '../query/answer-runtime/persona.ts'
import type { AnswerProfileId } from '../query/tools/profiles.ts'
import { auditGrounding, groundingRepairHint, stripCitationMarkers } from '../query/grounding.ts'
import type { AskCitation } from '../types.ts'
import {
  isInternalWechatId,
  readableIdentityLabel,
  replaceWechatIds,
} from '../query/message-identity.ts'
import type { RunChatFn } from './ask-run-chat.ts'

/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
export interface AskImageInput {
  data: string
  mediaType: string
  name?: string
}

/** 一次问答的范围。 */
export interface AskScope {
  username?: string
  /** 会话显示名；用于让模型把单聊里的「他/她/对方」对应到当前联系人。 */
  displayName?: string
  from?: string
  to?: string
}

/** 解析本次问答要用的系统提示词。 */
export function resolveSystemPrompt(override: string | undefined): string {
  if (override !== undefined && override.trim() !== '') {
    return withManualQaPersonaRules(override)
  }
  return WECHAT_QA_SYSTEM_PROMPT
}

/** 构造用户消息里的回答规则。 */
export function buildSynthRules(timeGuardRule: string): string {
  return `
  请按以下要求回答：
  ${UNTRUSTED_MATERIAL_RULE}
  1. **只用材料里的事实**：上面检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期、时间。宁可少说，也不要编。金额、日期、电话/卡号这类值**只能原样照抄**材料里的写法 —— 要说合计就写明由哪几条相加（如「3500+3500=7000」），不要自行换算单位或推算日期。
  2. **先结论后要点**：第一段先用一句话直接回答问题；随后用 \`- \` 列 2-4 条关键事实。除非提问者明确要求完整过程，否则不要按消息逐条倾倒记录。
  3. **排版简单**：每条只讲一个主题，控制在 1-2 句；相近消息合并，只保留代表性事实。不要使用大标题、表格、嵌套列表或连续加粗。
  4. **每条事实后面标 [n]**：例如「小何说收到转账 13.00 元 [1]」，多个来源写 [1][3]。材料里形如「群名 · 某人」的，要说清是谁说的。
  5. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述；日期放在条目开头。
  6. **找不到就直说，但有事实就先回答**：材料不足以回答时，直接说明「聊天记录里没有找到……」，再给 1-2 条改问建议（换关键词、收窄时间或指定会话）。注意：材料里出现「统计事实」时，它就是可以据以回答的确定性结论 —— 必须先按事实回答，禁止说「没有聊天记录」「无法判断」；只有统计事实也没有覆盖问题时才说明缺口。不要用推测填空。
  7. 只引用真正支持结论的那几条来源，不要罗列全部；也不用写「依据本机记录」这类来源说明，界面上已单独显示。
  8. **联系人只用网名或备注**：提到聊天对象或群成员时，必须使用材料里的备注、群昵称或会话显示名。严禁输出 \`wxid_*\`、\`*@chatroom\`、\`gh_*\` 或其他 username、消息 key 等技术标识；显示名缺失时写「某位成员」或「该群聊」，不得把内部标识当成人名。${timeGuardRule}
  **效率要求**：材料可能很多，先筛出与问题直接相关的少量证据，不要逐条分析或枚举全部记录；除非提问者明确要求完整清单，否则只保留 2-4 个主题。
  ${MANUAL_QA_OUTPUT_PRONOUN_REMINDER}`
}

/** 「没检索到原文」时的回答文案。 */
export function emptyAnswerText(
  profile: AnswerProfileId = 'wechat-ask',
): string {
  if (profile === 'session-ask') {
    return '当前会话里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词，或补充更具体的时间与人物。'
  }
  return '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。'
}

/** 检索范围（只保留非空字段）。 */
export function buildAskScope(options: {
  username?: string
  usernameName?: string
  from?: string
  to?: string
}): AskScope {
  return {
    username: typeof options.username === 'string' && options.username ? options.username : undefined,
    displayName: typeof options.usernameName === 'string' && options.usernameName
      ? options.usernameName
      : undefined,
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
    return { blocks: [], note: '（本轮消息附带图片，但当前运行环境没有可用的附件服务，无法识别图片内容。）' }
  }
  try {
    const parts: unknown[] = [
      { type: 'text', text: '（以下是本轮微信消息附带的图片）' },
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
      note: '（本轮消息附带图片，但当前对话模型不支持读图，无法识别图片内容；请如实告知当前消息发送者看不到图片内容，不要说「没收到图片」。）',
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
export const IMAGE_UNSUPPORTED_NOTE = '\n\n（注意：当前模型看不到随消息附的图片，无法识别图片内容；请如实告知当前消息发送者看不到图片内容，不要说「没收到图片」。）'

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
  signal?: AbortSignal,
): Promise<string> {
  if (images === undefined || images.length === 0) {
    return runChat(system, userText, maxTokens, onDelta, onReasoning, undefined, signal)
  }
  try {
    return await runChat(system, userText, maxTokens, onDelta, onReasoning, images, signal)
  } catch (e) {
    // A user stop is not an image-capability failure. Retrying here would
    // consume another request and can surface stale deltas after cancellation.
    if (signal?.aborted === true || isAskCanceledError(e)) throw e
    op('task', 'ask_wechat', 'fail', 'image_send', '图片未能送模型，已按纯文本重试：' + (e instanceof Error ? e.message : String(e)))
    return runChat(
      system,
      userText + IMAGE_UNSUPPORTED_NOTE,
      maxTokens,
      onDelta,
      onReasoning,
      undefined,
      signal,
    )
  }
}

function isAskCanceledError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'ASK_CANCELED'
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
  return `依据本机记录：${parts.join(' · ')}${span}`
}

/** 归一知识库 id。 */
export function normalizeKbId(kbId: number | undefined): number | undefined {
  return Number.isFinite(kbId) && (kbId ?? 0) > 0 ? Math.trunc(kbId as number) : undefined
}

/** 选择入口 profile。 */
export function selectAskProfile(options: {
  source?: string
}): AnswerProfileId {
  if (options.source === 'session') return 'session-ask'
  return 'wechat-ask'
}

/** 工具选择阶段的系统提示：只讲规则与范围，不塞原始证据。 */
export function buildToolSelectionSystem(input: {
  profile: AnswerProfileId
  scope: AskScope
  kbId?: number
  question: string
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  imageNote: string
  now: Date
}): string {
  const today = `${input.now.getFullYear()}-${String(input.now.getMonth() + 1).padStart(2, '0')}-${String(input.now.getDate()).padStart(2, '0')}`
  const lockedUsername = input.scope.username ?? ''
  const lockedName = input.scope.displayName?.trim() || lockedUsername
  const scope = [
    input.profile === 'session-ask'
      ? `当前会话已锁定为 ${lockedName || '（缺失）'}${lockedName && lockedUsername && lockedName !== lockedUsername ? `（username=${lockedUsername}）` : ''}，不得查询其他会话`
      : input.scope.username
        ? `会话限定 ${lockedName}${lockedName !== lockedUsername ? `（username=${lockedUsername}）` : ''}`
        : '会话不限',
    input.scope.from ? `起始 ${input.scope.from}` : '',
    input.scope.to ? `截止 ${input.scope.to}` : '',
    input.profile === 'session-ask'
      ? ''
      : input.kbId !== undefined ? `知识库 ${String(input.kbId)}` : '未选择知识库',
  ].filter(Boolean).join('；')
  const history = input.history.length > 0
    ? '\n最近对话（只用于理解指代，不得当作事实证据）：\n'
      + formatConversationHistory(input.history)
    : ''
  const image = input.imageNote !== '' ? `\n图片说明：${input.imageNote}` : ''
  const lockedHint = lockedUsername !== ''
    ? input.profile === 'session-ask'
      ? '\n当前会话已锁定：会话与日期范围由系统自动注入，不要为了确认会话身份额外检索或切换范围。'
      : '\n会话范围已锁定：会话类工具的 username 会由系统自动注入，不要为了确认会话身份额外调用 search_contacts 或 list_sessions。'
    : ''
  const taskRules = input.profile === 'session-ask'
    ? `你的任务：
1. 只在当前会话内收集证据；会话身份已经确定，不要再确认或切换会话；
2. 明确关键词优先 search_messages；“最近聊了什么”优先 get_session_messages；关键词检索不足时，再用一次 search_hybrid（mode=messages）或 search_semantic 补充语义召回；
3. 只有明确的数量、排名或日期统计才用 aggregate_messages；只有需要某条消息前后上下文时才用 get_message_context；
4. 当前会话内的确定性数据域也要用专用工具，它们已由系统强制限制在当前会话：
   · 转账/红包的金额、收支、最近一笔 → get_funds_summary
   · 通话次数/时长/未接 → get_call_history
   · 当前群聊的群主/群公告/群成员/群活跃 → get_group_detail（仅群聊）
   · 图片/语音/视频/文件/位置等媒体消息 → aggregate_media
   · 撤回原文 → search_revoked
   调用时不要填其他会话的 username/peer/group；系统会自动注入当前会话，填了别的值会被拒绝；
5. 不要改查联系人、会话列表、文件、收藏、朋友圈、知识库或其他会话。问题提到这些词时，只把它们当作当前会话中的内容来检索；找不到就如实说明；
6. 同一工具同一参数不要重复调用。通常控制在 1-2 次工具调用，拿到足够证据后立即停止，不要为了“再确认”反复检索；
7. 工具阶段不要写最终回答。完成检索后停止调用工具，由后续综合阶段生成答案。`
    : `你的任务：
1. 只选择并调用必要的检索工具，收集能回答问题的原文或确定性统计；
2. 不要臆造工具结果，不要把常识当成本机记录；
3. 先判断问题要的是「原文」还是「事实」：原文用 search_messages / get_session_messages / get_message_context；数量、金额、排名、时长用确定性工具，不要从片段里自己数；
4. 专用数据域必须用专用工具：
   · 转账/红包的金额、收支、最近一笔、异常 → get_funds_summary（条目明细才用 search_records）
   · 通话次数/时长/未接 → get_call_history
   · 群主/群公告/群成员/群活跃 → get_group_detail
   · 朋友圈发布数/点赞/评论排行 → get_moments_stats（按内容找单条才用 search_moments）
   · 撤回原文 → search_revoked
   · 图片/语音/视频/文件/位置等媒体消息 → aggregate_media
   · 文件 → search_files；收藏 → search_favorites；联系人档案 → search_contacts / get_contact_detail；知识库 → search_kb；
5. 同一工具同一参数不要重复调用；参数必须符合 schema；日期一律写 YYYY-MM-DD；
6. 用户给的是显示名或群名时可直接填 username/group/sessionName，系统会解析；返回歧义候选时选一个或向用户澄清，不要反复猜；
7. 专用工具没有命中时再考虑 search_hybrid 或 search_messages，不要一开始就用泛化检索替代专用数据域；
8. 工具阶段不要写最终回答。完成检索后停止调用工具，由后续综合阶段生成答案。`
  return `今天是 ${today}。你是一个检索工具选择器，不是最终回答器。
待处理问题：${input.question}
执行边界：${scope}${lockedHint}${history}${image}

${taskRules}`
}

/** 本轮工具范围的人话描述。 */
export function describeAskScope(scope: AskScope, profile: AnswerProfileId): string {
  const sessionName = scope.displayName?.trim() || scope.username
  const parts = [
    profile === 'session-ask'
      ? sessionName ? `当前会话（${sessionName}）` : '当前会话'
      : scope.username
        ? sessionName ? `会话限定（${sessionName}）` : '会话限定'
        : '全库',
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
    return `\n9. **时间范围**：材料里有 ${String(hits)} 条落在 ${label} 内，可以按该范围陈述。`
  }
  /*
   * 统计事实（aggregate_messages 的确定性结论）天然带自己的统计区间。
   * 只按「消息原文命中数」判断，会把「这个范围没有可引用的原文」误写成
   * 「这个范围没有聊天记录」，并让模型在紧跟其后的事实列表面前自相矛盾。
   */
  const factCount = Array.isArray(evidence.facts) ? evidence.facts.length : 0
  if (factCount > 0) {
    return `\n9. **时间范围（重要）**：${label} 内没有检索到可直接引用的**消息原文**，但材料里有 ${String(factCount)} 条**统计事实**（每条形如「统计区间为 X ~ Y」）。必须先用统计事实直接回答，不得说「这段时间没有聊天记录」「无法判断」「查不到」；引用其他日期的原文时，逐条写出真实日期，不要把其他日期的事说成发生在该范围内。`
  }
  return `\n9. **时间范围（重要）**：检索在 ${label} 内没有找到**消息原文**，下面列出的片段全部来自**其他日期**。必须先明确说一句「${label} 这段时间没有检索到相关原文」，然后才可以说「另外在 X 月 X 日聊过……」并**逐条写出这些内容的真实日期**。绝对不要把其他日期的内容说成是该时间范围内发生的。`
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
    ...(citation.enterpriseName ? { enterpriseName: citation.enterpriseName } : {}),
    time: citation.time,
    snippet: citation.snippet,
    username: citation.username,
    local_id: citation.local_id,
    ...(citation.sender ? { sender: citation.sender } : {}),
    ...(citation.senderEnterpriseName
      ? { senderEnterpriseName: citation.senderEnterpriseName }
      : {}),
    ...(citation.revoked ? { revoked: true } : {}),
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
  timeGuardRule: string
}): string {
  const historyBlock = input.history.length > 0
    ? '此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n'
      + formatConversationHistory(input.history) + '\n\n'
    : ''
  const imageHint = input.imageHint !== '' ? '\n关于图片：' + input.imageHint : ''
  /*
   * 材料正文里若原样出现分隔符，就等于给了材料一个「提前结束包裹」的机会。
   * 先替换成普通文本，保证唯一的结束分隔符只能由运行时写入。
   */
  const material = input.contextBlock
    .replaceAll(MATERIAL_BEGIN_MARKER, '[检索材料开始]')
    .replaceAll(MATERIAL_END_MARKER, '[检索材料结束]')
  return `${historyBlock}提问者本次问题：${input.question}${imageHint}

${MATERIAL_BEGIN_MARKER}
${material}
${MATERIAL_END_MARKER}
${buildSynthRules(input.timeGuardRule)}`
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

/**
 * Final-answer safety net: replace any remaining internal identities with the
 * citation's real display name (or a neutral human label when it is unknown).
 */
export function replaceAnswerIdentities(
  answer: string,
  citations: readonly AnswerRuntimeCitation[],
): string {
  const aliases = new Map<string, string>()
  for (const citation of citations) {
    const raw = citation.username.trim()
    const label = readableIdentityLabel(citation.name, raw)
    if (raw === '' || label === '' || !isInternalWechatId(raw)) continue
    aliases.set(raw, label)
    aliases.set(raw.toLowerCase(), label)
  }
  return replaceWechatIds(
    answer,
    raw => aliases.get(raw) ?? aliases.get(raw.toLowerCase()),
    raw => raw.toLowerCase().endsWith('@chatroom') ? '该群聊' : '某位联系人',
  )
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
 * 资源回答没有 [n] 角标，仅“存在引用”不能证明模型真的用了材料：模型完全
 * 可能返回一段通用话术。这里用确定性的内容重合做保守校验：
 *   · 回答里 ≥4 个连续汉字原样出现在证据中，直接通过；
 *   · 否则比较去噪后的汉字二元组，短回答至少重合 1 个、长回答至少 2 个；
 *   · 英文/型号词至少重合 1 个长度 ≥3 的词。
 * 这不能替代语义审查，但能拦住“有引用、回答却完全无关”的结论。
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

/** 按普通问答或独立资源模式完成接地核对与最多一次回炉。 */
export async function resolveGroundedAnswer(input: {
  /** `resource` 用于「文件/收藏/朋友圈等资源」作为唯一证据的回答。 */
  mode: 'cited' | 'resource'
  answer: string
  citationCount: number
  synthPrompt: string
  evidenceFor: (cited: number[]) => string[]
  allEvidence: string[]
  /** 用户问题/范围里已经明确给出的值；复述这些值不算编造。 */
  trustedValueText?: string
  systemPrompt: string
  runChat: RunChatFn
  images?: readonly ImageBlock[]
  /** 取消/内部 deadline；修复调用必须沿用，不能让超时请求继续占着供应商连接。 */
  signal?: AbortSignal
  /** 超时降级时关闭第二次模型调用，只对首版回答做确定性核对。 */
  allowRepair?: boolean
}): Promise<{
  answer: string
  citedIndexes: number[]
  withheld: boolean
  grounding: ReturnType<typeof auditGrounding>
  repaired: boolean
  /** 回答是否与证据有可验证的内容重合（`resource` 模式使用）。 */
  evidenceUsed: boolean
}> {
  const resourceOnly = input.mode === 'resource'
  const auditFor = (text: string, cited: number[]): ReturnType<typeof auditGrounding> =>
    auditGrounding(
      text,
      resourceOnly ? input.allEvidence : input.evidenceFor(cited),
      input.citationCount,
      {
        requireCitationMarkers: !resourceOnly,
        ...(input.trustedValueText ? { allowValuesFrom: [input.trustedValueText] } : {}),
      },
    )

  let citedIndexes = resourceOnly ? [] : parseCitedIndexes(input.answer, input.citationCount)
  let grounding = auditFor(input.answer, citedIndexes)
  let evidenceUsed = resourceOnly
    ? hasEvidenceSupport(input.answer, input.allEvidence)
    : true
  const protocolNeedsRepair = !resourceOnly
    && (citedIndexes.length === 0 || grounding.uncited > 0)
  const needsRepair = protocolNeedsRepair
    || grounding.unsupported.length > 0
    || (resourceOnly && !evidenceUsed)
  let finalAnswer = input.answer
  let repaired = false

  if (needsRepair && input.allowRepair !== false) {
    const repairHint = groundingRepairHint(grounding, resourceOnly ? 'plain' : 'cited')
    const strictPrompt = resourceOnly
      ? `${input.synthPrompt}

  【重要】请重写上一次的回答，只修事实与表达，不要解释你正在重写。
  ${repairHint}
  ${!evidenceUsed ? ' · 上一次的回答没有实际使用任何一条检索材料中的具体内容。\n' : ''}
   · 这些资源没有消息角标，不要标 [n]，需要提及时直接写资源名称；
   · 不要提引用、来源、材料或核对过程；
   · 日期与金额只能写资源材料里原样出现的值。`
      : `${input.synthPrompt}

  【重要】请重写上一次的回答，逐条修掉下面的问题。
  ${citedIndexes.length === 0 ? ' · 上一次的回答**没有标注任何 [n] 来源**。\n' : ''}${repairHint ? repairHint + '\n' : ''} · 每一句事实性陈述后面都必须紧跟对应的 [n]，且只标真正支持这句话的那几条；
   · 语气保持自然口语化，像在微信里转述聊天内容，并保持「先结论、后要点」的结构；
   · 如果检索结果不足以回答，只输出一句话：「本机记录中没有找到可据以回答的证据」。`
    const second = await input.runChat(
      input.systemPrompt,
      strictPrompt,
      resourceOnly ? 400 : 1600,
      undefined,
      undefined,
      input.images,
      input.signal,
    )
    const secondCited = resourceOnly ? [] : parseCitedIndexes(second, input.citationCount)
    const secondAudit = auditFor(second, secondCited)
    const secondUsed = resourceOnly
      ? hasEvidenceSupport(second, input.allEvidence)
      : true
    const protocolOk = resourceOnly || secondCited.length > 0
    const fewerUnsupported = secondAudit.unsupported.length < grounding.unsupported.length
    const supportImproved = secondUsed && !evidenceUsed
    const sameUnsupportedWithMoreCitations = !resourceOnly
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
  if (resourceOnly) {
    finalAnswer = stripCitationMarkers(finalAnswer)
    citedIndexes = []
    if (grounding.unsupported.length > 0) {
      withheld = true
      finalAnswer = '找到的资源内容不足以核对这次回答中的关键数字或日期，因此没有直接采用 AI 回答。请打开下方资源确认，或换一个更具体的问法。'
    }
    grounding = { ...grounding, cited: [] }
    if (!evidenceUsed) {
      withheld = true
      finalAnswer = '找到的资源没有在 AI 回答中被实际使用，因此没有直接采用该结论。请打开下方资源确认，或换一个更具体的问法。'
    }
  } else if (citedIndexes.length === 0) {
    withheld = true
    finalAnswer = '本机记录中没有找到可据以回答的证据（AI 回答无法对应到任何一条原文，已不予采用）。可以换关键词、收窄时间范围或指定会话后重试。'
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
