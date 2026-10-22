/**
 * 问答运行时 v2 的生产编排层。
 *
 * 运行时（`query/answer-runtime/*`）只负责意图、工具循环、证据与状态；这里把
 * 三个入口的装配细节接起来：
 *   · 微信问答 / 会话内问答 / ClawBot 自动回复共用同一套编排；
 *   · 工具选择阶段只看到规则与范围，证据在综合阶段才出网；
 *   · 所有真正发给模型的文本都先过隐私闸门；
 *   · 最终结果仍保持旧 `AskResult` 形状，新增字段只做附加。
 *
 * @module remotes/ask-runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { extractAskTerms } from '../query/ask.ts'
import { resourcesFromEvidence, runAnswerRuntime } from '../query/answer-runtime/runtime.ts'
import {
  advanceThreadState,
  applyThreadState,
  buildThreadState,
  type AppliedThreadState,
  type ThreadState,
} from '../query/answer-runtime/thread-state.ts'
import {
  ANSWER_INTENT_KINDS,
  type AnswerIntentDecision,
  type AnswerIntentLlmClassifier,
  type AnswerIntentLlmSuggestion,
} from '../query/answer-runtime/intent.ts'
import type {
  AnswerRuntimeEmitStage,
  AnswerRuntimeOp,
  AnswerRuntimeResult,
  AnswerSynthesizeFn,
} from '../query/answer-runtime/types.ts'
import {
  resolveAnchoredRecentDateRange,
  resolveExplicitDateRange,
} from '../query/answer-runtime/explicit-time-range.ts'
import type { AnswerStatus } from '../query/answer-runtime/evidence.ts'
import type { AnswerProfileId } from '../query/tools/profiles.ts'
import { askToolContext } from './ask-retrieval.ts'
import {
  IMAGE_UNSUPPORTED_NOTE,
  buildAskScope,
  buildEmptyChatPrompt,
  buildRuntimeContext,
  buildSynthesisPrompt,
  buildTimeGuardRule,
  buildToolSelectionSystem,
  describeAskScope,
  evidenceTexts,
  normalizeKbId,
  prepareAskImages,
  resolveGroundedAnswer,
  runChatWithImagesFallback,
  resolveSystemPrompt,
  resourceTexts,
  selectAskProfile,
  trimAskHistory,
  type AskDataScope,
  type AskImageInput,
  type AskScope,
  type PreparedAskImages,
} from './ask-runtime-prompt.ts'
import {
  createAskRunChat,
  createAskRunChatTurn,
  type RunChatFn,
  type RunChatTurnFn,
} from './ask-run-chat.ts'
import type { RetrievalTool, ToolContext } from '../query/tools/types.ts'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import type { AskPlan, AskResult } from '../types.ts'
import {
  askResultFromRuntime,
  reindexCitations,
  type AskRuntimeResult,
  type GroundingSnapshot,
} from './ask-runtime-result.ts'

export {
  askResultFromRuntime,
  type AskCitationWithTrace,
  type AskRuntimeResult,
} from './ask-runtime-result.ts'
/** 工具集构建输入；生产侧通常直接返回 `buildAskTools(...)`。 */
export interface AskRuntimeToolBuildInput {
  /** 本次入口对应的 profile；工具装配可按入口裁剪额外能力。 */
  profile: AnswerProfileId
  plan: AskPlan
  scope: AskScope
  kbId?: number
  wechatDataEnabled: boolean
  knownEntities: string[]
  now: Date
}

/** 编排依赖。所有会出网的调用都通过这里注入，便于测试离线替换。 */
export interface AskRuntimeDeps {
  decryptedDir: string
  provider: string
  model: string
  privacyGate: PrivacyGateFn
  /** 宿主上下文；有附件服务时用于把图片准备成消息块。 */
  ctx?: Context
  llm?: Context['llm']
  /** 完整工具集，或按本次 plan/范围装配的工厂。 */
  tools: readonly RetrievalTool[] | ((input: AskRuntimeToolBuildInput) => readonly RetrievalTool[])
  /** 基础工具上下文（可选；会被本次范围覆盖）。 */
  toolContext?: Partial<ToolContext>
  knownEntities?: string[] | (() => string[])
  knownSessions?: string[] | (() => string[])
  /** 结构化会话目录：显示名/别名 → 真实 username。 */
  knownSessionCatalog?:
    | Array<{ username: string; name?: string; aliases?: readonly string[] }>
    | (() => Array<{ username: string; name?: string; aliases?: readonly string[] }>)
  runTurn?: RunChatTurnFn
  runChat?: RunChatFn
  /** 低置信意图分类器；缺省在 llm + runChat 可用时复用同一模型自动装配。 */
  intentClassifier?: AnswerIntentLlmClassifier
  /** 意图分类独立 deadline，默认 4000ms；0 表示关闭。 */
  intentClassifierDeadlineMs?: number
  prepareImages?: (
    options: AskRuntimeOptions,
  ) => Promise<PreparedAskImages> | PreparedAskImages
  /** 直接替换综合生成（主要供测试或特殊入口使用）。 */
  synthesize?: AnswerSynthesizeFn
  threadState?: ThreadState
  throwIfCanceled?: () => void
  /** 本轮取消信号；用于唤醒工具重试退避。 */
  cancelSignal?: AbortSignal
  emitDelta?: (text: string) => void
  emitReasoning?: (text: string) => void
  emitStage?: AnswerRuntimeEmitStage
  op?: AnswerRuntimeOp
  now?: Date
  maxRounds?: number
  maxCallsPerRound?: number
  maxTokens?: number
  toolDeadlineMs?: number
  /** 单次模型轮次 deadline；缺省由运行时取 120000ms，0 = 关闭。 */
  modelDeadlineMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** 单次问答选项（与旧 `askWechat` 入参保持一致）。 */
export interface AskRuntimeOptions {
  question: string
  username?: string
  from?: string
  to?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  source?: string
  usernameName?: string
  kbId?: number
  dataScope?: AskDataScope
  images?: readonly AskImageInput[]
  systemPromptOverride?: string
  streamId?: string
  /** 上一轮返回的结构化线程状态；用于跨请求继承会话/联系人/时间窗。 */
  threadState?: ThreadState
  now?: Date
}

/**
 * 把线程状态解析成可执行范围。
 *
 * 会话名可能只是显示名，不能直接写进 `scope.username`；先按已知会话列表
 * 做一次精确匹配，匹配不到就只保留联系人/消息引用，避免把显示名当 username。
 */
function resolveThreadScope(
  question: string,
  state: ThreadState,
  scope: AskScope,
  knownEntities: readonly string[],
  now: Date,
): AppliedThreadState {
  return applyThreadState(question, state, {
    now,
    knownEntities: [...knownEntities],
    // 已知会话这里传的是显示名；applyThreadState 只把它当文本线索，
    // 真正的 username 仍必须由显式 scope 或调用方解析后提供。
    ...(scope.username ? { currentSession: scope.username } : {}),
  })
}

/**
 * 本轮显式 UI 范围优先；继承范围只补空缺。
 *
 * 例外：用户在本轮问题里重新写明了时间（例如界面还停在单日，问题却明确
 * 要求「2026-09-16 至 2026-10-16」）。此时必须让问题原文覆盖遗留 UI 日期，
 * 否则工具选择提示仍按单日装配，模型还会继续生成窄范围参数。
 */
function mergeScopeWithThread(
  scope: AskScope,
  applied: AppliedThreadState,
  question: string,
): AskScope {
  const inheritedSession = applied.session?.trim() ?? ''
  const session = scope.username
    || (/^(?:wxid_[A-Za-z0-9_-]+|gh_[A-Za-z0-9_-]+|[A-Za-z0-9._-]+@chatroom)$/.test(inheritedSession)
      ? inheritedSession
      : '')
  const restatedRange = resolveExplicitDateRange(question)
    ?? resolveAnchoredRecentDateRange(question)
  const restatedTime = restatedRange !== undefined
    && applied.overrides?.includes('timeRange') === true
    && applied.timeRange?.source === 'explicit'
  const explicitFrom = restatedTime ? applied.from : undefined
  const explicitTo = restatedTime ? applied.to : undefined
  return {
    ...(session ? { username: session } : {}),
    ...(explicitFrom || scope.from
      ? { from: explicitFrom ?? scope.from }
      : applied.from
        ? { from: applied.from }
        : {}),
    ...(explicitTo || scope.to
      ? { to: explicitTo ?? scope.to }
      : applied.to
        ? { to: applied.to }
        : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listOf(value: string[] | (() => string[]) | undefined): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim() !== '')
  if (typeof value !== 'function') return []
  try {
    const out = value()
    return Array.isArray(out) ? out.filter(item => typeof item === 'string' && item.trim() !== '') : []
  } catch {
    return []
  }
}

/** 读取结构化会话目录；非法项丢弃，读取失败退回空目录。 */
function sessionCatalogOf(
  value: AskRuntimeDeps['knownSessionCatalog'],
): Array<{ username: string; name?: string; aliases?: readonly string[] }> {
  let raw: unknown
  try {
    raw = typeof value === 'function' ? value() : value
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Array<{ username: string; name?: string; aliases?: readonly string[] }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const username = typeof record['username'] === 'string' ? record['username'].trim() : ''
    if (username === '' || seen.has(username)) continue
    const name = typeof record['name'] === 'string' && record['name'].trim() !== ''
      ? record['name'].trim()
      : undefined
    const aliases = Array.isArray(record['aliases'])
      ? record['aliases'].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      : undefined
    seen.add(username)
    out.push({
      username,
      ...(name === undefined ? {} : { name }),
      ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
    })
  }
  return out
}

function noopOp(_category: 'task', _action: string, _status: 'ok' | 'fail' | 'skip', _target: string, _detail?: string): void {
  // 编排层的日志是旁路，调用方可以完全不注入。
}

function safeThrowIfCanceled(deps: AskRuntimeDeps): void {
  deps.throwIfCanceled?.()
}

function parseIntentSuggestion(raw: string): AnswerIntentLlmSuggestion | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const kind = parsed['kind']
  if (typeof kind !== 'string' || !(ANSWER_INTENT_KINDS as readonly string[]).includes(kind)) {
    return null
  }
  const confidence = parsed['confidence']
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence))) {
    return null
  }
  const toolHints = parsed['toolHints']
  if (toolHints !== undefined && (!Array.isArray(toolHints) || toolHints.some(v => typeof v !== 'string'))) {
    return null
  }
  const scope = isRecord(parsed['scopeHints']) ? parsed['scopeHints'] : undefined
  return {
    kind,
    ...(typeof confidence === 'number' ? { confidence } : {}),
    ...(typeof parsed['reason'] === 'string' ? { reason: parsed['reason'] } : {}),
    ...(Array.isArray(toolHints) ? { toolHints } : {}),
    ...(typeof parsed['needsClarification'] === 'boolean'
      ? { needsClarification: parsed['needsClarification'] }
      : {}),
    ...(scope
      ? {
        scopeHints: {
          ...(typeof scope['session'] === 'string' ? { session: scope['session'] } : {}),
          ...(typeof scope['contact'] === 'string' ? { contact: scope['contact'] } : {}),
          ...(typeof scope['from'] === 'string' ? { from: scope['from'] } : {}),
          ...(typeof scope['to'] === 'string' ? { to: scope['to'] } : {}),
          ...(typeof scope['media'] === 'string' ? { media: scope['media'] } : {}),
          ...(typeof scope['ordinal'] === 'number' ? { ordinal: scope['ordinal'] } : {}),
        },
      }
      : {}),
  }
}

/** 复用生产 runChat（同 provider/model）装配低置信意图分类器。 */
function createIntentClassifier(input: {
  deps: AskRuntimeDeps
  runChat: RunChatFn
  counts: { sessions: number; messages: number }
}): AnswerIntentLlmClassifier {
  const { deps, runChat, counts } = input
  const system = '你是意图分类器。只输出一个 JSON 对象，不要 markdown。'
    + '字段：kind（lookup/aggregate/relation/timeline/content_media/open_qa/clarify）、'
    + 'confidence（0~1）、reason、toolHints（工具名数组）、needsClarification（布尔）、'
    + 'scopeHints（仅可含 session/contact/from/to/media/ordinal）。'
    + '只根据问题与规则结果补充分类，不要编造事实。'
  return async ({ question, rule, signal }) => {
    const user = [
      `问题：${question}`,
      `规则意图：${rule.kind}（confidence=${String(rule.confidence)}）`,
      `规则依据：${rule.reason}`,
      `允许工具：${rule.toolHints.join(', ') || '无'}`,
    ].join('\n')
    const raw = await runChat(
      gateText(deps, counts, system),
      gateText(deps, counts, user),
      240,
      undefined,
      undefined,
      undefined,
      signal,
    )
    return parseIntentSuggestion(raw)
  }
}

function gateText(
  deps: AskRuntimeDeps,
  counts: { sessions: number; messages: number },
  text: string,
): string {
  try {
    const [gated] = deps.privacyGate('ask_wechat', counts, [text])
    return typeof gated === 'string' ? gated : text
  } catch {
    // 与 gateway 的隐私闸同口径：审计/脱敏失败不阻断已经允许的调用。
    return text
  }
}

/**
 * 工具结果回放给模型也属于证据出网。
 *
 * 这里不改变消息结构，只把 text / tool-result 里的正文替换成隐私闸返回的副本，
 * 保证 tool-call 与 tool-result 的 callId 仍能一一对应。
 */
function gateModelMessages(
  messages: readonly Message[],
  deps: AskRuntimeDeps,
  sessions: number,
): Message[] {
  const texts: string[] = []
  let toolResults = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        texts.push(block.text)
      } else if (block.type === 'tool-result') {
        toolResults += 1
        for (const nested of block.content) {
          if (nested.type === 'text') texts.push(nested.text)
        }
      }
    }
  }
  if (texts.length === 0) return [...messages]
  const gated = (() => {
    try {
      return deps.privacyGate('ask_wechat', { sessions, messages: toolResults }, texts)
    } catch {
      return texts
    }
  })()
  let cursor = 0
  const nextText = (): string => {
    const value = gated[cursor]
    cursor += 1
    return typeof value === 'string' ? value : texts[cursor - 1] ?? ''
  }
  return messages.map((message) => {
    const content = message.content.map((block): ContentBlock => {
      if (block.type === 'text') return { ...block, text: nextText() }
      if (block.type === 'tool-result') {
        return {
          ...block,
          content: block.content.map((nested): ContentBlock =>
            nested.type === 'text' ? { ...nested, text: nextText() } : nested),
        }
      }
      return block
    })
    return { ...message, content }
  })
}

function imageNoteFor(prepared: PreparedAskImages): string {
  return prepared.blocks.length > 0
    ? '（本轮用户消息里附了图片，请直接看图回答。）'
    : prepared.note
}

function userContent(question: string, blocks: readonly ImageBlock[]): ContentBlock[] {
  return [{ type: 'text', text: question }, ...blocks]
}

async function resolvePreparedImages(
  deps: AskRuntimeDeps,
  options: AskRuntimeOptions,
): Promise<PreparedAskImages> {
  if (deps.prepareImages) {
    const prepared = await deps.prepareImages(options)
    return {
      blocks: prepared.blocks,
      note: prepared.note,
      audit: prepared.audit,
    }
  }
  const images = Array.isArray(options.images) ? options.images.slice(0, 2) : []
  if (images.length === 0) return { blocks: [], note: '', audit: '' }
  if (!deps.ctx) {
    return {
      blocks: [],
      note: IMAGE_UNSUPPORTED_NOTE,
      audit: '',
    }
  }
  return prepareAskImages(deps.ctx, deps.llm, deps.provider, deps.model, images)
}

function threadWithResult(
  prev: ThreadState,
  question: string,
  runtime: AnswerRuntimeResult,
  answer: string,
  applied?: AppliedThreadState,
): ThreadState {
  return advanceThreadState(prev, {
    question,
    answer,
    intent: runtime.intent.kind,
    ...(applied ? { applied } : {}),
  })
}

function createRunFns(
  deps: AskRuntimeDeps,
  scope: AskScope,
): { runTurn: RunChatTurnFn; runChat?: RunChatFn } {
  let runTurn = deps.runTurn
  if (!runTurn && deps.llm) {
    runTurn = createAskRunChatTurn({
      llm: deps.llm,
      provider: deps.provider,
      model: deps.model,
      throwIfCanceled: () => safeThrowIfCanceled(deps),
    })
  }
  if (!runTurn) throw new Error('未配置问答模型调用（runTurn）')
  const sessions = scope.username ? 1 : 0
  const gatedTurn: RunChatTurnFn = async (input) => {
    safeThrowIfCanceled(deps)
    return runTurn({
      ...input,
      messages: gateModelMessages(input.messages, deps, sessions),
    })
  }

  let runChat = deps.runChat
  if (!runChat && deps.llm) {
    runChat = createAskRunChat({
      llm: deps.llm,
      provider: deps.provider,
      model: deps.model,
      throwIfCanceled: () => safeThrowIfCanceled(deps),
    })
  }
  return { runTurn: gatedTurn, ...(runChat ? { runChat } : {}) }
}

interface SynthesizerInput {
  deps: AskRuntimeDeps
  options: AskRuntimeOptions
  scope: AskScope
  question: string
  history: ReturnType<typeof trimAskHistory>
  prepared: PreparedAskImages
  runChat: RunChatFn
  onReasoning: (text: string) => void
  op: AnswerRuntimeOp
  capture: (snapshot: GroundingSnapshot) => void
}

function createSynthesizer(input: SynthesizerInput): AnswerSynthesizeFn {
  const { deps, options, scope, question, history, prepared, runChat, onReasoning, op, capture } = input
  return async (synthesis) => {
    const citations = reindexCitations(synthesis.evidence)
    const resources = resourcesFromEvidence(synthesis.evidence)
    const isKb = synthesis.profile.id === 'clawbot-auto'
    const noEvidence = synthesis.evidence.items.length === 0
    const range = synthesis.intent.scopeHints?.timeRange
    const from = range?.from || range?.to || ''
    const to = range?.to || range?.from || ''
    const timeHint = from ? `${from} ~ ${to}` : undefined
    const hintHits = timeHint
      ? synthesis.evidence.items.filter(item => {
        const day = item.time.slice(0, 10)
        return day !== '' && day >= from && day <= to
      }).length
      : undefined
    const contextBlock = noEvidence
      ? ''
      : buildRuntimeContext({
        citations,
        resources,
        intent: synthesis.intent,
        terms: extractAskTerms(question).slice(0, 8),
        scope: describeAskScope(scope, synthesis.profile.id),
        recency: synthesis.intent.legacy === 'recency_lookup',
        ...(timeHint ? { timeHint } : {}),
        ...(hintHits !== undefined ? { hintHits } : {}),
      })
    const imageHint = imageNoteFor(prepared)
    const prompt = noEvidence && isKb
      ? buildEmptyChatPrompt(question, history, imageHint)
      : buildSynthesisPrompt({
        question,
        history,
        imageHint,
        contextBlock,
        dataScope: options.dataScope,
        timeGuardRule: buildTimeGuardRule(synthesis.intent, synthesis.evidence),
      })
    const system = isKb
      ? resolveSystemPrompt(options.systemPromptOverride, 'kb-only')
      : resolveSystemPrompt(options.systemPromptOverride, options.dataScope)
    const counts = {
      sessions: new Set(citations.map(c => c.username).filter(Boolean)).size,
      messages: citations.length,
    }
    const gatedChat: RunChatFn = async (
      sys,
      text,
      maxTokens,
      onDelta,
      onReasoningDelta,
      images = prepared.blocks,
    ) => {
      const gatedSystem = gateText(deps, counts, sys)
      const gatedText = gateText(deps, counts, text)
      const finalText = images.length === 0 && prepared.note !== '' && !noEvidence
        ? gatedText + IMAGE_UNSUPPORTED_NOTE
        : gatedText
      return runChatWithImagesFallback(
        runChat,
        op,
        gatedSystem,
        finalText,
        maxTokens,
        onDelta,
        onReasoningDelta,
        images,
      )
    }
    const answer = await gatedChat(
      system,
      prompt,
      isKb ? 400 : 1200,
      deps.emitDelta,
      onReasoning,
      prepared.blocks,
    )
    const texts = evidenceTexts(synthesis.evidence)
    const citationTexts = citations.map(citation =>
      texts.get(citation.evidenceId)
      ?? `${citation.name} ${citation.sender ?? ''} ${citation.time} ${citation.snippet}`)
    const resourceOnly = !isKb && citations.length === 0 && resources.length > 0
    const resolved = await resolveGroundedAnswer({
      mode: isKb ? 'chat' : resourceOnly ? 'resource' : 'cited',
      answer,
      citationCount: citations.length,
      synthPrompt: prompt,
      evidenceFor: (cited) => {
        const indexes = cited.length > 0 ? cited : citations.map((_, offset) => offset + 1)
        return indexes.map(index => citationTexts[index - 1] ?? '')
      },
      allEvidence: [...citationTexts, ...resourceTexts(resources)],
      systemPrompt: system,
      runChat: gatedChat,
      ...(prepared.blocks.length > 0 ? { images: prepared.blocks } : {}),
    })
    capture({
      citedIndexes: resolved.citedIndexes,
      withheld: resolved.withheld,
      grounding: resolved.grounding,
      repaired: resolved.repaired,
      evidenceUsed: resolved.evidenceUsed,
    })
    return { answer: resolved.answer, citations }
  }
}

/**
 * 入口：跑一次完整问答。
 *
 * @param deps - 装配依赖（工具集、模型调用、隐私闸、取消检查）。
 * @param options - 本次问题、范围、历史与图片。
 * @returns 旧 `AskResult` 形状 + 状态/证据/trace 等附加字段。
 */
export async function askWithRuntime(
  deps: AskRuntimeDeps,
  options: AskRuntimeOptions,
): Promise<AskRuntimeResult> {
  safeThrowIfCanceled(deps)
  const now = options.now ?? deps.now ?? new Date()
  const question = String(options.question ?? '').trim()
  const scope = buildAskScope(options)
  const history = trimAskHistory(options.history)
  const profile = selectAskProfile({ source: options.source, dataScope: options.dataScope })
  const kbId = normalizeKbId(options.kbId)
  const prepared = await resolvePreparedImages(deps, options)
  if (prepared.audit !== '') {
    try {
      deps.op?.('task', 'ask_wechat', 'ok', '', prepared.audit)
    } catch {
      // 旁路。
    }
  }
  const knownEntities = listOf(deps.knownEntities)
  const knownSessions = listOf(deps.knownSessions)
  const knownSessionCatalog = sessionCatalogOf(deps.knownSessionCatalog)
  // 兼容只传名字列表的旧接线：目录项以 username=名字 的形式进入，
  // 由 `looksLikeUsername` 决定是否接受，不会把任意显示名放行。
  const sessionEntries: Array<{ username: string; name?: string; aliases?: readonly string[] }> =
    knownSessionCatalog.length > 0
    ? knownSessionCatalog
    : knownSessions.map(username => ({ username }))
  const initialState = deps.threadState
    ?? options.threadState
    ?? buildThreadState(history, undefined, scope, now)
  const appliedThread = resolveThreadScope(
    question,
    initialState,
    scope,
    knownEntities,
    now,
  )
  const effectiveScope = mergeScopeWithThread(scope, appliedThread, question)
  const toolBuildInput: AskRuntimeToolBuildInput = {
    profile,
    plan: {
      intent: 'pending',
      subQueries: extractAskTerms(question).slice(0, 8),
      ...(effectiveScope.from ? { from: effectiveScope.from } : {}),
      ...(effectiveScope.to ? { to: effectiveScope.to } : {}),
      terms: extractAskTerms(question).slice(0, 8),
    },
    scope: effectiveScope,
    ...(kbId !== undefined ? { kbId } : {}),
    wechatDataEnabled: profile !== 'clawbot-auto',
    knownEntities,
    now,
  }
  const tools = typeof deps.tools === 'function'
    ? [...deps.tools(toolBuildInput)]
    : [...deps.tools]

  const toolContext = askToolContext({
    decryptedDir: deps.decryptedDir,
    question,
    plan: {
      subQueries: toolBuildInput.plan.subQueries,
      from: toolBuildInput.plan.from ?? '',
      to: toolBuildInput.plan.to ?? '',
      person: toolBuildInput.plan.person ?? '',
    },
    scope: effectiveScope,
    ...(kbId !== undefined ? { kbId } : {}),
    ...(profile === 'clawbot-auto' ? { wechatDataEnabled: false } : {}),
    indexNote: '',
    scopeDescText: describeAskScope(effectiveScope, profile),
    op: deps.op ?? noopOp,
    makeEmbedFn: () => undefined,
    embedModelName: () => '',
    makeRerankFn: () => undefined,
    kbModel: () => ({ model: '' }),
    askKnownEntities: () => knownEntities,
    now,
  })
  const mergedContext: ToolContext = {
    ...toolContext,
    ...deps.toolContext,
    decryptedDir: deps.decryptedDir,
    ...(kbId !== undefined ? { kbId } : {}),
    // UI/服务端显式范围优先于工具基础上下文；继承范围只补空缺。
    scope: { ...(deps.toolContext?.scope ?? {}), ...effectiveScope },
    ...(profile === 'clawbot-auto' ? { wechatDataEnabled: false } : {}),
    knownEntities,
    now,
  }

  const selectionSystemRaw = buildToolSelectionSystem({
    profile,
    dataScope: options.dataScope,
    scope: effectiveScope,
    ...(kbId !== undefined ? { kbId } : {}),
    question,
    history,
    imageNote: imageNoteFor(prepared),
    now,
  })
  const selectionSystem = gateText(
    deps,
    { sessions: effectiveScope.username ? 1 : 0, messages: history.length },
    selectionSystemRaw,
  )
  const messages: Message[] = [
    createUserMessage({
      content: userContent(question, prepared.blocks),
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    }),
  ]
  const threadState = initialState

  const { runTurn, runChat } = createRunFns(deps, effectiveScope)
  const intentClassifier = deps.intentClassifier
    ?? (runChat
      ? createIntentClassifier({
        deps,
        runChat,
        counts: { sessions: effectiveScope.username ? 1 : 0, messages: history.length },
      })
      : undefined)
  let reasoning = ''
  const onReasoning = (text: string): void => {
    reasoning = text
    deps.emitReasoning?.(text)
  }
  const op: AnswerRuntimeOp = deps.op ?? noopOp

  let grounded: GroundingSnapshot | undefined
  const synthesize: AnswerSynthesizeFn | undefined = deps.synthesize
    ?? (runChat
      ? createSynthesizer({
        deps,
        options,
        scope: effectiveScope,
        question,
        history,
        prepared,
        runChat,
        onReasoning,
        op,
        capture: (snapshot) => { grounded = snapshot },
      })
      : undefined)

  safeThrowIfCanceled(deps)
  const runtime = await runAnswerRuntime({
    question,
    system: selectionSystem,
    messages,
    profile,
    profileTools: tools,
    toolContext: mergedContext,
    throwIfCanceled: () => { safeThrowIfCanceled(deps) },
    ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
    runTurn,
    ...(synthesize ? { synthesize } : {}),
    synthesizeOnInsufficient: profile === 'clawbot-auto',
    clarifyBeforeSearch: profile !== 'clawbot-auto',
    ...(intentClassifier ? { intentClassifier } : {}),
    intentClassifierDeadlineMs: deps.intentClassifierDeadlineMs ?? 4_000,
    intentOptions: {
      history,
      knownEntities,
      knownSessions: sessionEntries.map(entry => entry.name ?? entry.username),
    },
    knownSessions: [...knownSessions, ...sessionEntries.map(entry => entry.username)],
    ...(sessionEntries.length > 0 ? { knownSessionCatalog: sessionEntries } : {}),
    knownContacts: knownEntities,
    threadState,
    now,
    ...(deps.maxRounds !== undefined ? { maxRounds: deps.maxRounds } : {}),
    ...(deps.maxCallsPerRound !== undefined ? { maxCallsPerRound: deps.maxCallsPerRound } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
    ...(deps.toolDeadlineMs !== undefined ? { toolDeadlineMs: deps.toolDeadlineMs } : {}),
    ...(deps.modelDeadlineMs !== undefined ? { modelDeadlineMs: deps.modelDeadlineMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.emitStage ? { emitStage: deps.emitStage } : {}),
    ...(deps.op ? { op: deps.op } : {}),
    onReasoning,
  })
  safeThrowIfCanceled(deps)
  const result = askResultFromRuntime({
    runtime,
    profile,
    dataScope: options.dataScope,
    scope: effectiveScope,
    question,
    ...(grounded ? { grounded } : {}),
  })
  // 线程状态保存的是公开映射后的回答；运行时可能只返回状态兜底前的空串。
  const nextThread = threadWithResult(threadState, question, runtime, result.answer, appliedThread)
  result.threadState = nextThread
  result.appliedThreadState = appliedThread
  if (grounded?.evidenceUsed === false) result.evidenceUsed = false
  if (reasoning !== '') result.reasoning = reasoning

  return result
}

/** 供主线程判断旧结果里的状态字段（类型收窄辅助）。 */
export function runtimeStatusOf(result: AskRuntimeResult | AskResult): AnswerStatus | undefined {
  if ('status' in result && typeof result.status === 'string') {
    return result.status
  }
  return undefined
}

/** 判断一个未知值是否是运行时状态（用于客户端/日志读取旧记录）。 */
export function isAnswerStatus(value: unknown): value is AnswerStatus {
  return value === 'ok'
    || value === 'insufficient'
    || value === 'needs_clarification'
    || value === 'degraded'
    || value === 'blocked'
    || value === 'failed'
}

/** 运行时 trace 的形状守卫（避免调用方把任意对象当 trace 用）。 */
export function isToolCallTrace(value: unknown): boolean {
  return isRecord(value)
    && typeof value['index'] === 'number'
    && typeof value['name'] === 'string'
    && typeof value['ok'] === 'boolean'
}
