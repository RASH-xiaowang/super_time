
/**
 * 问答主链路（提问检索生成、问题优化、向量索引重建） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { formatAskContext, parseAskOptimize, parseAskPlan, parseCitedIndexes, retrieveAskCitations } from '../query/ask.ts'
import { beginAskCancel, cancelAskIn } from './ask-cancel.ts'
import { auditGrounding, groundingRepairHint } from '../query/grounding.ts'
import { buildKbVectorIndex, kbVectorIndexStatus } from '../query/kb-vectors.ts'
import { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { EmbedFn, buildVectorIndex, vectorIndexStatus } from '../query/retrieval/embedding.ts'
import { loadAdaptedWeights } from '../query/retrieval/feedback.ts'
import { citationDocKey } from '../query/retrieval/kb-channel.ts'
import { runRetrievalPipeline, type PipelineOutput } from '../query/retrieval/pipeline.ts'
import { askRetrievalCompat, runAskRetrieval } from './ask-retrieval.ts'
import { IntentKind, RerankWeights } from '../query/retrieval/types.ts'
import { ensureSearchIndex } from '../query/search.ts'
import { AskOptimizeResult, AskResult, OperationCategory, OperationStatus } from '../types.ts'
import { VectorBuildResult } from '../types-retrieval.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import { createAskRunChat } from './ask-run-chat.ts'
import type { RunChatFn } from './ask-run-chat.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, TokenUsage } from '@deepseek-ai/dsh-llm'

/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
interface AskImageInput {
  data: string
  mediaType: string
  name?: string
}

/**
 * 自动回复的检索范围（会话 / 起始 / 截止必须真的参与检索）。
 * @param options - askWechat 的会话与时间范围字段。
 * @returns 只保留非空字段的 scope。
 */
function buildAskScope(options: { username?: string, from?: string, to?: string }): { username?: string, from?: string, to?: string } {
  return {
    username: typeof options.username === 'string' && options.username ? options.username : undefined,
    from: typeof options.from === 'string' && options.from ? options.from : undefined,
    to: typeof options.to === 'string' && options.to ? options.to : undefined,
  }
}

/**
 * 多轮上下文：最多最近 16 条（8 轮），并按**总字数预算**截断 ——
 * 单条截断不够：8 轮长回答各 2000 字会把 prompt 撑到 1.6 万字，把检索结果挤到末尾。
 * @param historyRaw - 调用方传入的历史（可能非法/超长）。
 * @returns 过滤并截断后的历史（user/assistant 交替按原顺序）。
 */
function trimAskHistory(historyRaw: ReadonlyArray<{ role: 'user' | 'assistant', content: string }> | undefined): Array<{ role: 'user' | 'assistant', content: string }> {
  const history = (Array.isArray(historyRaw) ? historyRaw : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-16)
  const budget = 4000
  let used = 0
  const trimmed: Array<{ role: 'user' | 'assistant', content: string }> = []
  for (const m of [...history].reverse()) {
    const room = budget - used
    if (room <= 80) break
    const text = m.content.trim().slice(0, Math.min(m.role === 'assistant' ? 1200 : 400, room))
    trimmed.unshift({ role: m.role, content: text })
    used += text.length
  }
  return trimmed
}

/** 图片能否送给模型：由宿主附件服务或 mini 桥接层各自决定；这里只产出要放进消息的块。 */
interface PreparedAskImages {
  blocks: ImageBlock[]
  note: string
  audit: string
}

/**
 * 把自动回复的图片准备成消息内容块：完整 harness 走附件服务（按模型 `image` 模态决定是否发送），
 * Super Time 的 mini 宿主没有附件服务，直接放 base64 让 `llm-bridge.js` 投影成 OpenAI `image_url`。
 * @param ctx - 宿主 Context。
 * @param llm - LLM 服务（完整 runtime 才有 `resolveModelInfo`）。
 * @param provider - 当前模型 provider。
 * @param model - 当前模型 id。
 * @param images - canonical base64 图片（最多 2 张）。
 * @returns 消息块 + 给模型的说明 + 审计文案（空串 = 不记）。
 */
async function prepareAskImages(
  ctx: Context,
  llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }> } | undefined,
  provider: string,
  model: string,
  images: readonly AskImageInput[],
): Promise<PreparedAskImages> {
  if (images.length === 0) return { blocks: [], note: '', audit: '' }
  const attachments = (ctx as unknown as { attachments?: { admitPromptContent?: unknown } }).attachments
  if (typeof attachments?.admitPromptContent !== 'function') {
    // mini 宿主：没有附件服务；运行时块形状由 llm-bridge 识别。
    const blocks = images.map((im) => ({
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
  } catch { vision = false }
  if (!vision) {
    return { blocks: [], note: '（对方发来图片，但当前对话模型不支持读图，无法识别图片内容；请如实告诉对方看不到图片内容，不要说「没收到图片」。）', audit: '' }
  }
  const got = await admitAskImages(ctx, images)
  return { blocks: got.blocks, note: got.note, audit: got.blocks.length > 0 ? `随问题发送图片 ${String(got.blocks.length)} 张` : '' }
}

/** 图片被供应商拒绝时的说明（重试纯文本时拼到 user 消息末尾）。 */
const IMAGE_UNSUPPORTED_NOTE = '\n\n（注意：当前模型看不到随消息附的图片，无法识别图片内容；请如实告诉对方看不到图片内容，不要说「没收到图片」。）'

/**
 * 把一次模型调用的 usage 累加进本轮总计（字段口径见 dsh-llm `TokenUsage`）。
 * @param acc - 已有累计（可能为空）。
 * @param next - 本次调用的 usage。
 * @returns 新的累计值；`next` 为空时原样返回。
 */
function addTokenUsage(acc: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
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

/**
 * 带图片的一次对话：图片被供应商拒绝时记一行审计，然后用纯文本 +「看不到图片内容」重试。
 * 这是 mini 宿主（无模型模态元数据）下能给出的最诚实降级。
 */
async function runChatWithImagesFallback(
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

async function admitAskImages(ctx: Context, images: readonly AskImageInput[]): Promise<{ blocks: ImageBlock[], note: string }> {
  if (images.length === 0) return { blocks: [], note: '' }
  const attachments = (ctx as unknown as {
    attachments?: { admitPromptContent?: (parts: unknown[]) => Promise<Array<{ type?: string }>> }
  }).attachments
  if (attachments?.admitPromptContent === undefined) {
    return { blocks: [], note: '（对方发来图片，但当前运行环境没有可用的附件服务，无法识别图片内容。）' }
  }
  try {
    const parts: unknown[] = [
      { type: 'text', text: '（以下是对方在微信里发来的图片）' },
      ...images.slice(0, 2).map((i) => ({ type: 'image', data: i.data, mediaType: i.mediaType, ...(i.name === undefined ? {} : { name: i.name }) })),
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

/**
 * 回答的**数据来源说明**：条数 / 会话数 / 时间跨度。
 *
 * 由检索结果**算出来**，不是让模型写的 —— 模型写的「来源」可能被编造，
 * 而这行数字直接来自本次引用到的原文，用户可逐条对照。
 *
 * ⚠ 会话数**只数消息**：知识库引用的 `username` 是 `kb:<kbId>:<fileId>`（它按文件分组
 * 是为了同源去重，不是会话），把它算进「N 个会话」这行就开始说谎 ——
 * 用户会照着这行去数，然后发现自己只有 2 个会话却写着 3 个。
 * 文件另按**文件**去重单列（同一份文件命中三块是 1 个文件），与「条数」是两个口径。
 * @param citations - 本次检索到的原文（引用锚点）。
 * @returns 一行来源说明；没有原文时返回空串。
 */
function askBasisLine(citations: ReadonlyArray<{
  time?: string
  username?: string
  source?: 'msg' | 'kb' | 'agg'
  kb?: { fileId?: number; fileName?: string }
  snippet?: string
}>): string {
  if (citations.length === 0) return ''
  const msgs = citations.filter(c => c.source !== 'kb')
  const kbItems = citations.filter(c => c.source === 'kb')
  const sessions = new Set(msgs.map(c => c.username ?? '')).size
  const days = msgs.map(c => (c.time ?? '').slice(0, 10)).filter(Boolean).sort()
  const span = days.length > 0 ? ` · ${days[0]} ~ ${days[days.length - 1]}` : ''
  const parts = [`${citations.length} 条原文`]
  if (msgs.length > 0) parts.push(`${sessions} 个会话`)
  if (kbItems.length > 0) {
    const files = new Set(kbItems.map(c => (c.kb?.fileId !== undefined ? 'f' + c.kb.fileId : (c.kb?.fileName ?? c.snippet ?? ''))))
    parts.push(`${files.size} 个知识库文件`)
  }
  return `依据本机记录：${parts.join(' · ')}${span}`
}

export interface createAskDeepRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  askTrace: Map<string, { features: Map<string, RerankWeights>; citations: string[]; question: string; answer: string; intent: IntentKind }>
  privacyGate: PrivacyGateFn
  embedModelName: (override?: string) => string
  makeEmbedFn: (model: string, feature?: "ask_embed" | "kb_embed" | "kb_link_suggest") => EmbedFn | undefined
  makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined
  makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined
  /** 思考过程发射器（2026-10-16）：与可见正文分开推，界面单独折叠展示。 */
  makeReasoningEmitter: (streamId?: string) => ((text: string) => void) | undefined
  /** 阶段事件发射器（2026-10-16）：把「规划 / 检索 / 生成」的进度推给界面。 */
  makeStageEmitter: (streamId?: string) => ((stage: { key: string; label: string; status: 'running' | 'done' | 'skipped'; detail?: string }) => void) | undefined
  kbModel: (kbId: number, role: KbModelRole) => ResolvedModel
  askKnownEntities: () => string[]
  saveAskHistory: (options: { question: string; username?: string; from?: string; to?: string; source?: string; usernameName?: string }, result: AskResult, elapsedMs: number, model: string) => void
  /** W3-6.1：取本轮问答的取消信号（gateway 持有槽位）。 */
  askSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  /** W3-6.1：取消一轮问答；找不到在跑的那一轮时返回 false。 */
  cancelAskJob: (jobId?: string) => boolean
}

/**
 * 解析本次问答要用的**系统提示词**（模块级：让 `createAskDeepRemotes` 留在棘轮线内）。
 * 自动回复传了 `systemPromptOverride` 就用它（拟人化人设），否则用检索问答那套
 * （要求标 `[n]` 角标 —— 界面上可点、可核对）。两者**刻意分开**：微信里没有角标 UI。
 * @param override - 调用方传的系统提示词（空串/未传 = 用缺省）。
 * @returns 系统提示词。
 */
function resolveSystemPrompt(override: string | undefined): string {
  if (override !== undefined && override.trim() !== '') return override
  return '你是用户微信聊天记录里的问答助手。只用下面给出的检索结果回答，说话自然、口语化，像在微信里跟人转述聊天内容；每句事实后面用 [n] 标注来源；记录里没有的就说没找到，绝不推测或编造。'
}

/**
 * 归一知识库作用域：只有**合法正数**才开 kb 通道（非法值当「没传」，调用方另记日志）。
 * @param kbId - 调用方传的知识库 id（不可信）。
 * @returns 合法的整数 id；非法时为 undefined。
 */
function normalizeKbId(kbId: number | undefined): number | undefined {
  return Number.isFinite(kbId) && (kbId ?? 0) > 0 ? Math.trunc(kbId as number) : undefined
}

/**
 * 构造**用户消息里的回答规则**（模块级：让 `createAskDeepRemotes` 留在棘轮线内）。
 *
 * ## 为什么必须按 `dataScope` 分叉（2026-10-17 真机实测）
 *
 * 规则写在**用户消息**里，比 system 更「近」，模型会优先遵守。此前只有一套规则，
 * 第 3 条硬性要求「每条事实后面标 [n]」—— 于是自动回复（`kb-only`）即使换了拟人化
 * system，**回复里仍然带 `[1]` `[2]` 角标**（微信里没有可点的角标，看着像乱码），
 * 而且模型为了「标全来源」会把话说长、说成报告腔。
 *
 * 分叉后：
 *   · `kb-only`（自动回复）→ **聊天版**：不标角标、**每条不超过 30 字**、要求分段；
 *   · 缺省（手动问答）→ **检索版**：保留 `[n]` 角标（界面上可点、可核对）。
 *
 * @param dataScope - 本次问答的数据面（`kb-only` = 自动回复）。
 * @param timeGuardRule - 时间线索护栏（由调用方按检索结果拼好，两版共用）。
 * @returns 拼好的规则段（含前导换行）。
 */
function buildSynthRules(dataScope: 'wechat' | 'kb-only' | undefined, timeGuardRule: string): string {
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

/**
 * 「没检索到原文」时的回答文案（模块级：让 `createAskDeepRemotes` 留在棘轮线内）。
 * ⚠️ 按**数据面**分（2026-10-17）：`kb-only`（自动回复）时不能说「本机记录里没有检索到」
 * —— 那条链路**根本没查本机记录**，说成「查了没有」是假话。
 *
 * ⚠️ 这个文案只在**手动问答**（`wechat`）时用。自动回复（`kb-only`）**不再走它** ——
 * 见 {@link buildEmptyChatPrompt}：硬编码文案会让「你好」「谢谢」这类日常寒暄
 * 永远只回一句「知识库里没有检索到…」，那是自动回复最致命的体验问题。
 * @param dataScope - 本次问答的数据面。
 * @returns 给用户看的回答。
 */
function emptyAnswerText(dataScope: 'wechat' | 'kb-only' | undefined): string {
  if (dataScope === 'kb-only') {
    return '知识库里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词，或在实例设置里换一个知识库。'
  }
  return '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。'
}

/**
 * 自动回复在**检索 0 命中**时的兜底提示词（2026-10-17 真机实测新增）。
 *
 * ## 为什么需要它
 *
 * 真机实测：开了自动回复但没配知识库时，8 个场景（「你好」「在吗」「谢谢」…）
 * **全部**返回同一句硬编码文案「知识库里没有检索到与这个问题相关的原文…」——
 * 因为 `citations.length === 0` 时直接短路、**根本不调模型**。
 *
 * 那条短路对**手动问答**是对的（防止模型凭常识编造聊天记录）。但对**自动回复**是灾难：
 * 微信里绝大多数消息是寒暄与闲聊，它们**本来就不该命中知识库** ——
 * 用户看到的是「AI 只会复读一句话」，而不是「AI 在跟我聊天」。
 *
 * ## 它怎么工作
 *
 * 仍然调模型，但把「材料为空」这件事**明说**，并要求：
 *   · 用自然的话回一句（寒暄就寒暄、问事就说没查到）；
 *   · **不许编造**具体事实（金额/日期/人名/承诺）；
 *   · 需要本人决定的事（借钱、签约）就说「这个我得问下本人」。
 *
 * ⚠️ 它是**用户消息**，比 system 更「近」—— 所以「禁角标 / 禁万能开场 / 先回应内容」
 * 这些规则必须**在这里也写一遍**，只在 system 里写不够（真机实测：3 次里 1 次冒出 `[1]`）。
 *
 * @param question - 用户发来的消息正文。
 * @param history - 最近对话（2026-10-18：自动回复要能关联上下文）。
 * @param imageNote - 有图但看不到时的说明（空串 = 没有图或图片已随消息送出）。
 * @returns 兜底提示词（作为用户消息）。
 */
function buildEmptyChatPrompt(question: string, history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [], imageNote = ''): string {
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

/**
 * 构造「没有检索到原文」时的问答结果（模块级：让 `createAskDeepRemotes` 留在棘轮线内）。
 *
 * 两条链路共用它（自动回复的兜底对话 / 手动问答的短路），差别只在 `answer` 怎么来。
 * @param answer - 给用户看的回答正文。
 * @param plan - 意图规划结果（写进历史，供回看时判断当时怎么理解的）。
 * @param terms - 本次用到的检索词。
 * @param stats - 检索统计（通道命中数等）。
 * @param indexNote - 索引状态说明（空串 = 不写）。
 * @returns 问答结果（`insufficient: true`、无引用）。
 */
function buildEmptyResult(
  answer: string,
  plan: { intent: string, subQueries: string[], from?: string, to?: string, person?: string },
  terms: string[],
  stats: { candidates: number, kept: number, scope: string, recency: boolean, chunks: number, windowMessages: number },
  indexNote: string,
): AskResult {
  return {
    answer,
    citations: [],
    plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
    citedIndexes: [],
    basis: '',
    insufficient: true,
    retrieval: {
      candidates: stats.candidates, kept: stats.kept, scope: stats.scope,
      recency: stats.recency, chunks: stats.chunks, windowMessages: stats.windowMessages,
      ...(indexNote === '' ? {} : { indexNote }),
    },
  }
}

/**
 * 处理「检索 0 命中」这一分支（模块级：让 `createAskDeepRemotes` 留在棘轮线内）。
 *
 * ## 两条链路刻意分叉（2026-10-17 真机实测新增）
 *
 * · **自动回复（`kb-only`）仍然调模型**：微信里绝大多数消息是寒暄与闲聊
 *   （「你好」「在吗」「谢谢」），它们**本来就不该命中知识库**。若沿用「0 命中就短路」，
 *   用户看到的是「AI 只会复读一句『知识库里没有检索到…』」—— 那不是聊天，是报错。
 *   真机实测：8 个场景（含「你好」「谢谢」）**全部**返回同一句硬编码文案。
 * · **手动问答（`wechat`）保持短路**：那条链路用户明确在问「我的聊天记录里有没有」，
 *   没有原文就不该让模型凭常识编一段（这是「不编造」的硬底线）。
 *
 * @param deps - 调模型与记账所需的依赖（由调用方注入，避免本函数碰闭包）。
 * @returns 问答结果（`insufficient: true`、无引用）。
 */
async function resolveEmptyAnswer(deps: {
  dataScope: 'wechat' | 'kb-only' | undefined
  question: string
  systemPromptOverride: string | undefined
  plan: { intent: string, subQueries: string[], from?: string, to?: string, person?: string }
  terms: string[]
  stats: { candidates: number, kept: number, scope: string, recency: boolean, chunks: number, windowMessages: number }
  indexNote: string
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  imageBlocks: readonly ImageBlock[]
  imageNote: string
  runChat: (system: string, userText: string, maxTokens: number, onDelta?: (t: string) => void, onReasoning?: (t: string) => void, images?: readonly ImageBlock[]) => Promise<string>
  onReasoning: (t: string) => void
  privacyGate: (feature: string, counts: { sessions: number, messages: number }, texts: string[]) => string[]
  op: (category: 'task', action: string, status: 'skip' | 'fail', target: string, detail: string) => void
  emitStage?: (s: { key: string, label: string, status: 'running', detail: string }) => void
}): Promise<AskResult> {
  if (deps.dataScope !== 'kb-only') {
    deps.op('task', 'ask_wechat', 'skip', '', '未检索到任何原文，未调用模型')
    return buildEmptyResult(emptyAnswerText(deps.dataScope), deps.plan, deps.terms, deps.stats, deps.indexNote)
  }
  deps.op('task', 'ask_wechat', 'skip', '', '未检索到原文，自动回复走兜底对话（不引用）')
  const chatPrompt = buildEmptyChatPrompt(deps.question, deps.history, deps.imageNote)
  const [chatGated] = deps.privacyGate('ask_wechat', { sessions: 0, messages: 0 }, [chatPrompt])
  deps.emitStage?.({ key: 'synthesize', label: '综合生成回答', status: 'running', detail: '无检索材料，按聊天兜底' })
  let chatAnswer = ''
  try {
    chatAnswer = await deps.runChat(
      resolveSystemPrompt(deps.systemPromptOverride),
      chatGated ?? chatPrompt,
      400,
      undefined,
      deps.onReasoning,
      deps.imageBlocks,
    )
  } catch (e) {
    // 兜底也失败：退回硬编码文案（至少让用户看到一句人话，而不是空回复）。
    deps.op('task', 'ask_wechat', 'fail', 'empty_chat', (e as Error).message)
    chatAnswer = ''
  }
  return buildEmptyResult(
    chatAnswer.trim() !== '' ? chatAnswer.trim() : emptyAnswerText(deps.dataScope),
    deps.plan, deps.terms, deps.stats, deps.indexNote,
  )
}

export function createAskDeepRemotes(rc: createAskDeepRemotesInputs) {
  return {
    async askWechat(options: {
      question: string
      username?: string
      from?: string
      to?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
      streamId?: string
      /**
       * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
       * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
       */
      source?: string
      /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
      usernameName?: string
      /**
       * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
       *
       * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
       * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
       * 而不是把别的库的内容也端上来。
       */
      kbId?: number
      jobId?: string
      /**
       * 数据面（2026-10-17）：`wechat`（缺省）= 可检索本机微信数据；
       * `kb-only` = **只检索知识库**，不碰本机微信数据。
       *
       * 自动回复（无人值守出网）传 `kb-only` —— 微信里随便一个人发一句话，
       * 不该让本机把全部聊天记录检索一遍并送去模型。
       */
      dataScope?: 'wechat' | 'kb-only'
      /**
       * 随问题一起送模型的图片（2026-10-18，ClawBot 自动回复「识别图中内容」）：
       * canonical base64 + MIME，最多 2 张。是否真的送模型由当前模型是否声明
       * `image` 输入模态决定；不支持时改成一句「看不到图片内容」的说明。
       */
      images?: AskImageInput[]
      /**
       * 系统提示词覆盖（2026-10-17）：传了就用它当 system，**用户消息里的检索材料与规则照旧**
       * （那部分保证「不编造」的底线）。自动回复用它注入实例的拟人化人设。
       */
      systemPromptOverride?: string
    }): Promise<AskResult> {
      // W3-6.1：取消整块在 remotes/ask-cancel.ts（令牌 / 阶段检查 / 槽位归还 / cancelAsk）。
      // 没有 jobId（旧客户端）时不可取消，行为与改动前逐字一致。
      // ⚠ 只能调一次 beginAskCancel：它在槽位表里注册一枚控制器，调两次会让第二枚覆盖第一枚，
      //   于是 run() 用的是第一枚、throwIfCanceled 读的是第二枚 —— 取消看似生效、槽位却永不归还
      //   （ask-cancel.spec.ts 第 ⑤ 条「对已结束轮次取消必须返回 false」钉的正是这个）。
      const askCtl = beginAskCancel(rc, options.jobId)
      let usageAcc: TokenUsage | undefined
      const result = await askCtl.run(async (): Promise<AskResult> => {
        const ctx = rc.ctx()
        /** 端到端耗时基准（提问 → 回答生成结束），写进历史记录供用户回看时判断快慢。 */
        const askStartedAt = Date.now()
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      if (!sel || !sel.provider || !sel.model) {
        rc.op('task', 'ask_wechat', 'fail', '', '未配置默认模型（agentDefaultModel）')
        throw new Error('未配置默认模型（agentDefaultModel），无法调用 AI 问答')
      }
      /** 写进历史的回答模型标签（与面板底部「片段会发给谁」同一口径）。 */
      const modelLabel = `${sel.provider} · ${sel.model}`
      // 检索范围与多轮上下文（实现见模块级 `buildAskScope` / `trimAskHistory`）。
      const scope = buildAskScope(options)
      const trimmedHistory = trimAskHistory(options.history)
      const llm = ctx.llm
      const askImages = Array.isArray(options.images) ? options.images.slice(0, 2) : []
      const prepared = await prepareAskImages(ctx, llm, sel.provider, sel.model, askImages)
      const imageBlocks = prepared.blocks
      const imageNote = prepared.note
      if (prepared.audit !== '') rc.op('task', 'ask_wechat', 'ok', '', prepared.audit)
      /**
       * 思考过程（2026-10-16）：与可见正文分开推，界面单独折叠展示。
       * 非推理模型不吐 `reasoning-delta`，这里就一次都不会被调用（不是错误）。
       */
      const emitReasoning = rc.makeReasoningEmitter(options.streamId)
      let reasoningAcc = ''
      const onReasoning = (text: string): void => {
        reasoningAcc = text
        emitReasoning?.(text)
      }
      /** 阶段事件（2026-10-16）：把「规划 / 检索 / 生成」的进度推给界面。 */
      const emitStage = rc.makeStageEmitter(options.streamId)
      /**
       * 跑一次对话。`onDelta` 存在时，把**已生成的全文**在生成过程中回传 ——
       * 传全文而不是增量片段：渲染进程只需整体替换，丢一两个事件也不会串行错乱。
       * `onReasoning`（2026-10-16）：思考过程单独推，界面折叠展示（与可见正文分开）。
       * `images`（2026-10-18）：需要模型「看图」时把图片块附在同一条用户消息里。
       */
      const runChat = createAskRunChat({ llm, provider: sel.provider, model: sel.model, throwIfCanceled: askCtl.throwIfCanceled, onUsage: (usage) => { usageAcc = addTokenUsage(usageAcc, usage) } })
      const runChatImages: RunChatFn = (system, userText, maxTokens, onDelta, onReasoning, images = imageBlocks) =>
        runChatWithImagesFallback(
          runChat,
          (category, action, status, target, detail) => { rc.op(category, action, status, target, detail) },
          system, userText, maxTokens, onDelta, onReasoning, images,
        )

      // ── 第 1 步：意图分析与拆解（LLM → JSON 规划） ──
      // 规划器同时负责**把相对时间换算成绝对日期**（「上周三」→ 2026-09-02）与
      // **点名的人**（「李四」）—— 旧实现只取 subQueries，这两个线索全丢，
      // 于是「上周三我和李四聊了什么」只能靠通用词在全库瞎撞。
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()]
      const scopeDesc = `会话=${scope.username ?? '全部'}${scope.from ? `，起始=${scope.from}` : ''}${scope.to ? `，截止=${scope.to}` : ''}`
      const historyBrief = trimmedHistory.length > 0
        ? '\n对话历史（最近）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 300)).join('\n')
        : ''
      const planPrompt = `今天是 ${todayStr}（${weekday}）。\n用户问题：${options.question}\n当前筛选范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
      const [planPromptGated] = rc.privacyGate('ask_wechat', { sessions: 0, messages: 0 }, [planPrompt])
      let plan: { intent: string; subQueries: string[]; from: string; to: string; person: string }
      try {
        const planText = await runChat(
          '你是微信本地聊天记录的检索规划器。任务：分析用户问题，输出**检索关键词**与**隐含条件**。'
          + '要求：① subQueries 给 1-4 个真正有区分度的中文关键词或短语（人名、事物、动作、专有名词），'
          + '不要输出「什么/怎么/我的/给我/最近/一次」这类疑问词、停用词或泛化时间词；'
          + '② 问题里出现相对时间（上周三/昨天/上个月）时，按给定的今天日期换算成绝对日期填 from/to（YYYY-MM-DD，单日则 from=to），'
          + '识别不出就留空字符串；③ 问题点名了某个人就填 person，否则留空字符串。'
          + '只输出一行 JSON：{"intent":"一句话意图","subQueries":["关键词1","关键词2"],"from":"YYYY-MM-DD","to":"YYYY-MM-DD","person":"人名"}',
          planPromptGated ?? planPrompt,
          512,
        )
        plan = parseAskPlan(planText)
        if (plan.subQueries.length === 0 && options.question.trim()) plan.subQueries = [options.question.trim()]
      } catch (e) {
        // 规划失败不阻断：退化为直接用原问题做 bigram 检索，保证问答始终可用。
        plan = { intent: '（规划失败，直接检索原问题）', subQueries: options.question.trim() ? [options.question.trim()] : [], from: '', to: '', person: '' }
        rc.op('task', 'ask_wechat', 'fail', 'intent_plan', (e as Error).message)
      }
      // W3-6.1：规划走 runChat（循环里已查取消），这里只补「规划之后」这个阶段边界。
      askCtl.throwIfCanceled()

      // W2-6.4：全量构建挪到后台（实测 13.5 万条 5.4s，不该让这一问干等）；
      // 落后于分片的增量同步**照旧等**（实测最坏 25.6ms，而不等就会用旧索引作答，
      // 那正是这段代码当初要修的那个 bug）。
      let indexNote = ''
      try {
        const ensured = await ensureSearchIndex(rc.dirs().decrypted, { background: true })
        if (ensured.action === 'deferred' && ensured.message !== undefined) {
          indexNote = ensured.message
          rc.op('task', 'ask_wechat', 'ok', 'build_index', '检索索引后台构建已开跑 · 本轮用旧索引')
        } else if (ensured.action === 'build') {
          rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引全量构建 · ${ensured.rows ?? 0} 条 · ${ensured.elapsed_ms}ms`)
        } else if (ensured.action === 'sync') {
          rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引增量同步 · 新增 ${ensured.added ?? 0} 条 · ${ensured.elapsed_ms}ms`)
        } else if (ensured.message) {
          rc.op('task', 'ask_wechat', 'fail', 'build_index', ensured.message)
        }
      } catch (e) {
        // 索引不可用不阻断提问：退回 LIKE 召回（准确率低但可用）
        rc.op('task', 'ask_wechat', 'fail', 'build_index', (e as Error).message)
      }
      askCtl.throwIfCanceled()
      // ── 第 2 步：多阶段检索 ──
      // 顺序：意图路由 → 查询改写 → 混合召回（稀疏 BM25 + 稠密向量 + 结构化）→
      //       RRF 融合去重 → 交叉特征重排 → 上下文压缩。
      // config.enabled=false 时退回旧的单通道检索（灰度/回滚开关）。
      // 检索阶段整块在 `ask-retrieval.ts`（2026-10-16 抽出）：这一段（向量索引补齐 →
      // 知识库向量 → 跑流水线 → 降级回退）语义独立 —— 它只回答「这次提问该拿哪些原文」。
      const scopeDescText = [
        scope.username ? '会话限定' : '',
        scope.from ? `起 ${scope.from}` : '',
        scope.to ? `止 ${scope.to}` : '',
      ].filter(Boolean).join(' ') || '全库'
      const retr = await runAskRetrieval({
        decryptedDir: rc.dirs().decrypted,
        question: options.question,
        plan: { subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person },
        scope,
        ...(normalizeKbId(options.kbId) !== undefined ? { kbId: normalizeKbId(options.kbId) } : {}),
        // 数据面限定（2026-10-17）：自动回复传 `kb-only` ⇒ 关掉微信侧四通道 + 不建消息向量索引。
        ...(options.dataScope === 'kb-only' ? { wechatDataEnabled: false } : {}),
        indexNote,
        scopeDescText,
        op: (category, action, status, target, detail) => { rc.op(category, action, status, target, detail) },
        makeEmbedFn: (model, feature) => rc.makeEmbedFn(model, feature),
        embedModelName: (override) => rc.embedModelName(override),
        makeRerankFn: (id) => rc.makeRerankFn(id),
        kbModel: (id, role) => rc.kbModel(id, role),
        askKnownEntities: () => rc.askKnownEntities(),
        ...(emitStage ? { emitStage } : {}),
      })
      const { citations, chunks, terms, rankedFeatures, retrievalId, rerankLine, timeBrowse } = retr
      const statsCompat = retr.stats

      // ── 硬约束一：没有任何原文就**不调模型** ──
      // 提示词里写「没找到就说明没找到」只是软约束；模型完全有可能凭常识编一段。
      // 这里直接短路：没有可引用的原文，就没有可核实的回答。
      // 精排这一句必须出现在依据行里：`used:true` 与 `used:false` 是两种不同的可信度 ——
      // 前者说明「有个模型读过这批候选并给了顺序」，后者说明「顺序是本地启发式给的」。
      // 不写出来，用户就会把「没配模型」读成「模型认为这些最相关」。
      const basisLine = askBasisLine(citations) + rerankLine
      if (citations.length === 0) {
        // 0 命中分支整块抽到模块级 `resolveEmptyAnswer`（自动回复调模型兜底 / 手动问答短路）。
        const emptyResult = await resolveEmptyAnswer({
          dataScope: options.dataScope,
          question: options.question,
          systemPromptOverride: options.systemPromptOverride,
          plan, terms, stats: statsCompat, indexNote,
          history: trimmedHistory,
          imageBlocks,
          imageNote,
          runChat: runChatImages, onReasoning,
          privacyGate: (feature, counts, texts) => rc.privacyGate(feature, counts, texts),
          op: (category, action, status, target, detail) => { rc.op(category, action, status, target, detail) },
          ...(emitStage ? { emitStage } : {}),
        })
        rc.saveAskHistory(options, emptyResult, Date.now() - askStartedAt, modelLabel)
        return emptyResult
      }

      const contextBlock = formatAskContext(citations, {
        intent: plan.intent,
        terms,
        scope: statsCompat.scope,
        recency: statsCompat.recency,
        timeHint: statsCompat.timeHint,
        hintHits: statsCompat.hintHits,
      }, chunks)

      // ── 第 3 步：综合对话历史与检索结果生成回答 ──
      const historyBlock = trimmedHistory.length > 0
        ? '此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n') + '\n\n'
        : ''
      // 提示词的取舍：
      //  · 「只用材料里的事实 / 找不到就直说」是**内容**底线（配合后端的两道硬约束：无原文不调模型、
      //    无引用不予采用）；
      //  · 「像微信聊天那样自然说话」是**语气**要求 —— 早先写的是「简洁分点」，模型会写成报告腔
      //    （「综上所述」「根据数据分析」），而这是个聊天记录问答工具，用户想听的是「谁说了什么」。
      // 时间线索护栏（本轮修）：检索侧给出时间线索却 0 命中时，材料里剩下的**全是别的
      // 日期**的记录。旧实现只在上下文头写了一句「不要声称限定在该日期」，模型于是如实
      // 回答「今天没找到，放宽都是别的日子」—— 但这几条别日期的片段仍被当作「唯一事实
      // 依据」并列了出来，用户看到的就是「回复不正确 + 冒出其他日期的消息」。
      // 这里把它写成不可绕过的行为规则，并要求逐条标出真实日期。
      const timeGuardRule = statsCompat.timeHint
        ? (statsCompat.hintHits > 0
          ? `\n7. **时间范围**：材料都落在 ${statsCompat.timeHint} 内，可以按该范围陈述。`
          : `\n7. **时间范围（重要）**：检索在 ${statsCompat.timeHint} 内**一条都没找到**，下面列出的片段全部来自**其他日期**。必须先明确说一句「${statsCompat.timeHint} 这段时间没有找到相关聊天记录」，然后才可以说「另外在 X 月 X 日聊过……」并**逐条写出这些内容的真实日期**。绝对不要把其他日期的内容说成是该时间范围内发生的。`)
        : ''
      const imageHint = imageBlocks.length > 0 ? '（本轮用户消息里附了图片，请直接看图回答。）' : imageNote
      const synthPrompt = `${historyBlock}用户本次问题：${options.question}
${imageHint !== '' ? '\n关于图片：' + imageHint : ''}

  ${contextBlock}
${buildSynthRules(options.dataScope, timeGuardRule)}`
      const [synthGated] = rc.privacyGate(
        'ask_wechat',
        { sessions: new Set(citations.map(c => c.username)).size, messages: citations.length },
        [synthPrompt],
      )
      emitStage?.({ key: 'synthesize', label: '综合生成回答', status: 'running', detail: `依据 ${citations.length} 条原文` })
      const answer = await runChatImages(
        resolveSystemPrompt(options.systemPromptOverride),
        synthGated ?? synthPrompt,
        // 自动回复（kb-only）要短：单条 ≤30 字、总长 ≤300 字 ⇒ 400 tokens 足够，
        // 且能压住模型「写长」的倾向（生成时长与输出长度成正比）。
        options.dataScope === 'kb-only' ? 400 : 1200,
        // 必须走 this.：makeDeltaEmitter 是实例方法。裸调用会抛
        // 「ReferenceError: makeDeltaEmitter is not defined」—— 它出现在**综合生成那一刻**，
        // 于是每次提问都在出答案前崩掉（UI 自动化验收实测捕捉到）。
        rc.makeDeltaEmitter(options.streamId),
        // 思考过程（2026-10-16）：与可见正文分开推，界面单独折叠展示。
        onReasoning,
        // 图片（2026-10-18）：视觉模型直接看图；文本模型在 prompt 里已有「看不到图片」说明。
        imageBlocks.length > 0 ? imageBlocks : undefined,
      )
      /** 回答「自己引用的」那些来源的正文：优先窗口全文，退化用引用卡片里的片段。
       *  接地审计必须拿**同一条证据**去核对 —— 用窗口全文而不是列表里的 120 字摘要，
       *  是为了避免「值明明在窗口里、只是没进摘要」被误判成编造。 */
      const evidenceFor = (cited: number[]): string[] => {
        const idx = cited.length > 0 ? cited : citations.map((_, i) => i + 1)
        return idx.map((n) => {
          const ch = chunks[n - 1]
          if (ch) {
            const head = `${ch.name} ${ch.anchor.sender ?? ''} ${ch.anchor.time}`
            return head + '\n' + ch.lines.map(l => `${l.day ?? ''} ${l.time} ${l.sender} ${l.text}`).join('\n')
          }
          const c = citations[n - 1]
          return c ? `${c.name} ${c.sender ?? ''} ${c.time} ${c.snippet}` : ''
        })
      }
      const groundingAuditFor = (text: string, cited: number[]): ReturnType<typeof auditGrounding> =>
        auditGrounding(text, evidenceFor(cited), citations.length)

      // ── 硬约束二：回答必须能对应到原文，否则不采用 ──
      // 三道检查，任一不通过都带着**具体问题**回炉重写一次：
      //   ① 一个 [n] 都没有 → 整段内容无法逐条核实（可能是模型凭常识补的）；
      //   ② 接地审计发现「引用原文里没有的金额/日期/长数字」→ 典型编造；
      //   ③ 带这些高风险值的句子没标 [n]（软问题，只触发重写）。
      // 重写后仍然没有任何引用才**不予采用**。金额类不做硬拦截 —— 合计是模型可以正当
      // 算出来的，拦住它会把「一共转了多少」直接变成无法回答（与前端
      // panels/utils/grounding.ts 的同一取舍：那里只提示、不拦截）。重写通过时用重写稿，
      // 没有变得更差才替换 —— 免得「越改越糟」把已经能核实的内容丢掉。
      let citedIndexes = parseCitedIndexes(answer, citations.length)
      let finalAnswer = answer
      let withheld = false
      let grounding = groundingAuditFor(answer, citedIndexes)
      let repaired = false
      if (citedIndexes.length === 0 || grounding.unsupported.length > 0 || grounding.uncited > 0) {
        const repairHint = groundingRepairHint(grounding)
        const strictPrompt = `${synthPrompt}

  【重要】请重写上一次的回答，逐条修掉下面的问题。
  ${citedIndexes.length === 0 ? ' · 上一次的回答**没有标注任何 [n] 来源**。\n' : ''}${repairHint ? repairHint + '\n' : ''} · 每一句事实性陈述后面都必须紧跟对应的 [n]，且只标真正支持这句话的那几条；
   · 语气保持自然口语化，像在微信里转述聊天内容；
   · 如果检索结果不足以回答，只输出一句话：「本机记录中没有找到可据以回答的证据」。`
        const second = await runChat(
          '你是用户微信聊天记录里的问答助手。只用给定检索结果回答，自然口语化，每句事实标注 [n]；记录里没有就直说没找到，不要推测或编造。',
          strictPrompt,
          1600,
        )
        const secondCited = parseCitedIndexes(second, citations.length)
        const secondAudit = groundingAuditFor(second, secondCited)
        const better = secondCited.length > 0 && (
          secondAudit.unsupported.length < grounding.unsupported.length
          || (secondAudit.unsupported.length === grounding.unsupported.length && secondCited.length > citedIndexes.length)
        )
        if (better) {
          finalAnswer = second
          citedIndexes = secondCited
          grounding = secondAudit
          repaired = true
        }
      }
      if (citedIndexes.length === 0) {
        withheld = true
        finalAnswer = '本机记录中没有找到可据以回答的证据（模型给出的内容无法对应到任何一条原文，已不予采用）。可以换关键词、收窄时间范围或指定会话后重试。'
      }
      const answer_basis = citedIndexes.length > 0
        ? `${basisLine}（回答引用了其中 ${citedIndexes.length} 条：[${citedIndexes.join('][')}]）`
        : basisLine
      // 记录本次检索的特征画像，供用户反馈时做「特征归因 → 权重微调」。
      if (retrievalId && rankedFeatures.length > 0) {
        rc.askTrace.set(retrievalId, {
          features: new Map(rankedFeatures.map(r => [r.docKey, r.features])),
          // 归因键**必须**与检索侧 docKey 逐字相同，否则「这条引用有用」对应不到任何
          // 特征向量 —— 而且不报错，只是调参永远不动。知识库引用的键是
          // `kb:<kbId>:<chunkId>`（由 citationDocKey 产出，是这条格式的唯一来源）；
          // 从前这里手写 `username + ':' + local_id`，KB 引用会塌成 `:`，
          // 同一轮里的多个文件引用还会**互相覆盖**，把反馈记到不存在的消息上。
          citations: citations.map(c => citationDocKey(c)),
          question: options.question,
          answer: finalAnswer,
          intent: (statsCompat.intent ?? 'open_qa') as IntentKind,
        })
        // 有界缓存：只保留最近 20 轮，避免长会话把内存撑大。
        while (rc.askTrace.size > 20) {
          const oldest = rc.askTrace.keys().next()
          if (oldest.done) break
          rc.askTrace.delete(oldest.value)
        }
      }
      rc.op(
        'task', 'ask_wechat', withheld ? 'fail' : 'ok', '',
        `意图「${statsCompat.intent ?? plan.intent}」· 关键词 ${terms.length} 个 · 召回 ${statsCompat.candidates} 条 → 窗口 ${statsCompat.chunks} 段（${statsCompat.windowMessages} 条消息）· 回答引用 ${citedIndexes.length} 段${withheld ? ' · 未引用任何来源，已不予采用' : ''}${grounding.checked > 0 ? ` · 接地核对 ${grounding.checked} 项（无出处的 ${grounding.unsupported.length} 项）` : ''}${repaired ? ' · 已按核对结果重写' : ''}${statsCompat.timeHint ? ` · 时间线索 ${statsCompat.timeHint}（命中 ${statsCompat.hintHits}）` : ''}`,
      )
      const result: AskResult = {
        answer: finalAnswer || '（模型未返回有效回答。可点「优化提问」改写问题，或收窄会话/时间范围后重试。）',
        citations,
        plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
        citedIndexes,
        basis: answer_basis,
        withheld: withheld || undefined,
        // 接地核对结果：界面上「回答里某某在原文里没有出现」的提示与操作日志共用它，
        // 也让「这轮到底核对了什么」可被追问。
        grounding: {
          checked: grounding.checked,
          unsupported: grounding.unsupported.map(v => v.value),
          cited: citedIndexes.length,
          repaired,
        },
        retrievalId: retrievalId || undefined,
        retrieval: {
          candidates: statsCompat.candidates, kept: statsCompat.kept, scope: statsCompat.scope,
          recency: statsCompat.recency, timeHint: statsCompat.timeHint, hintHits: statsCompat.hintHits,
          chunks: statsCompat.chunks, windowMessages: statsCompat.windowMessages,
          // W2-6.4：索引正在后台建 ⇒ 这一轮的检索空间不是最新的，明说。
          ...(indexNote === '' ? {} : { indexNote }),
          ...(statsCompat.intent ? { intent: statsCompat.intent } : {}),
          ...(statsCompat.denseActive !== undefined ? { denseActive: statsCompat.denseActive } : {}),
          ...(statsCompat.channels ? { channels: statsCompat.channels } : {}),
          ...(statsCompat.elapsedMs !== undefined ? { elapsedMs: statsCompat.elapsedMs } : {}),
          ...(statsCompat.funnel ? { funnel: statsCompat.funnel } : {}),
        },
      }
      // 自动落进「问答历史」。这是两个写入点里的第二个（另一个在上面「没检索到原文」
      // 的短路返回处）—— 只要走到 return，就有一次可回看的问答。
      // best-effort：存历史失败绝不能把已经生成好的回答变成一次报错。
      rc.saveAskHistory(options, result, Date.now() - askStartedAt, modelLabel)
      return result
      })
      return usageAcc === undefined ? result : { ...result, usage: usageAcc }
    },

    cancelAsk: (options: { jobId: string }): { ok: boolean; message?: string } => cancelAskIn(rc, options),

    async optimizeAskQuestion(options: {
      question: string
      username?: string
      from?: string
      to?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }): Promise<AskOptimizeResult> {
      return optimizeAskQuestionIn(rc, options)
    },

    async buildRagVectorIndex(options?: { force?: boolean }): Promise<VectorBuildResult> {
      const cfg = loadRetrievalConfig(rc.dirs().decrypted)
      const embedModel = rc.embedModelName()
      const embedFn = rc.makeEmbedFn(embedModel)
      if (!embedFn) return { ok: false, status: 'no-embedder', rows: 0, embedded: 0, elapsed_ms: 0, message: '未配置 embedding（请在模型配置里填写向量模型或 API Key）' }
      // 向量库是按「搜索索引里的文档」建的，所以先保证索引最新（缺失→构建，落后→增量）。
      try { await ensureSearchIndex(rc.dirs().decrypted) } catch { /* 交给下面状态判定 */ }
      try {
        const r = await buildVectorIndex(rc.dirs().decrypted, embedFn, {
          model: embedModel,
          batchSize: cfg.embedding.batchSize,
          concurrency: cfg.embedding.concurrency,
          maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
          maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
          force: Boolean(options?.force),
        })
        rc.op('task', 'build_vectors', 'ok', '', `${r.status} rows=${r.rows} embedded=${r.embedded} ${r.elapsed_ms}ms`)
        return { ok: true, ...r }
      } catch (e) {
        rc.op('task', 'build_vectors', 'fail', '', (e as Error).message)
        return { ok: false, status: 'error', rows: 0, embedded: 0, elapsed_ms: 0, message: (e as Error).message }
      }
    },

  }
}

/**
 * 提问优化（W3-6.1 从 createAskDeepRemotes 里搬出）。
 *
 * 搬家的原因不是它写得不好，而是 `createAskDeepRemotes` 受函数体棘轮管着（登记 607 行，
 * 只许变小）—— 而它恰好是整个工厂里最独立的一件：不依赖任何闭包，只用 `rc`。
 * 与 `remotes/ask-cancel.ts` 同属「给工厂腾地方」的结构刀。
 */
async function optimizeAskQuestionIn(rc: createAskDeepRemotesInputs, options: {
question: string
username?: string
from?: string
to?: string
history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }): Promise<AskOptimizeResult> {
const ctx = rc.ctx()
const question = String(options?.question || '').trim()
if (!question) throw new Error('请先输入问题，再进行优化')
const defaultModel = (ctx as unknown as {
  agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
}).agentDefaultModel
const sel = defaultModel?.currentSelection()
if (!sel || !sel.provider || !sel.model) {
  rc.op('task', 'ask_optimize', 'fail', '', '未配置默认模型（agentDefaultModel）')
  throw new Error('未配置默认模型（agentDefaultModel），无法优化提问')
}
const scopeDesc = `会话=${options.username || '全部'}${options.from ? `，起始=${options.from}` : ''}${options.to ? `，截止=${options.to}` : ''}`
const history = (Array.isArray(options.history) ? options.history : [])
  .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  .slice(-6)
const historyBrief = history.length > 0
  ? '\n最近对话背景：\n' + history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 200)).join('\n')
  : ''
const prompt = `用户原始问题：${question}\n当前检索范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
const [optimizeGated] = rc.privacyGate('ask_optimize', { sessions: 0, messages: 0 }, [prompt])
const assembler = new BlockAssembler()
const opts: GenerateOptions = {
  provider: sel.provider,
  model: sel.model,
  messages: [createUserMessage({
    content: [{ type: 'text', text: optimizeGated ?? prompt }],
    source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
  })],
  system: '你是微信聊天记录的提问优化器。把用户问题改写得更清晰、更利于全文检索（保留原意，补充隐含的时间/对象等限定，去掉口语口水词），并给出至多 3 条具体的改进建议。只输出一行 JSON：{"optimized":"优化后的问题","suggestions":["建议1","建议2"]}',
  maxTokens: 512,
}
for await (const chunk of ctx.llm.stream(opts)) assembler.push(chunk)
const text = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
const parsed = parseAskOptimize(text)
const optimized = parsed.optimized || text.slice(0, 300)
rc.op('task', 'ask_optimize', 'ok', '', optimized.slice(0, 80))
return { optimized, suggestions: parsed.suggestions }
}
