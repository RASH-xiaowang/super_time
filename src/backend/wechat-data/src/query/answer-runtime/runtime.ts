/**
 * 问答运行时 v2 的高层编排。
 *
 * 流程：
 *   resolveContext → classifyIntent → runToolLoop → buildEvidenceBundle → synthesize
 *
 * 本文件刻意不 import `askdeep.ts` / `ask-retrieval.ts`：生产接线只需注入
 * `runTurn`（工具选择）与 `synthesize`（拿到证据后的最终生成），运行时本身
 * 不关心模型供应商或检索实现。
 *
 * @module query/answer-runtime/runtime
 */
import type { Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { buildEvidenceBundle, type AnswerStatus, type EvidenceBundle } from './evidence.ts'
import { resourceFallbackTools } from './fallbacks.ts'
import {
  applyAnswerIntentSuggestion,
  classifyAnswerIntent,
  isAnswerIntentKind,
  type AnswerIntentDecision,
  type AnswerIntentLlmSuggestion,
} from './intent.ts'
import {
  missingDomains,
  requiredDomainsFor,
  supplementCandidate,
  type AnswerDataDomain,
} from './required-domains.ts'
import { runToolLoop } from './tool-loop.ts'
import { withDeadline } from './tool-runtime.ts'
import { blockedReply, clarificationReply, failedReply, insufficientReply } from './replies.ts'
import { buildToolHintBlock, profileToolHints } from './tool-guidance.ts'
import type {
  AnswerRunTurnFn,
  AnswerRuntimeCitation,
  AnswerRuntimeInput,
  AnswerRuntimeResourceCitation,
  AnswerRuntimeResult,
  AnswerRuntimeStage,
  AnswerSynthesisOutput,
  ToolLoopResult,
} from './types.ts'
import {
  filterToolsForProfile,
  filterToolsForScope,
  getAnswerProfile,
  type AnswerProfile,
  type AnswerProfileId,
} from '../tools/profiles.ts'
import type { RetrievalTool, ToolContext, ToolName, ToolResult } from '../tools/types.ts'

const MAX_FALLBACK_ITEMS = 8
const MAX_FALLBACK_SNIPPET = 240
const DEFAULT_INTENT_CLASSIFIER_DEADLINE_MS = 4_000

function emit(
  input: AnswerRuntimeInput,
  key: string,
  label: string,
  status: AnswerRuntimeStage['status'],
  detail?: string,
): void {
  try {
    input.emitStage?.({ key, label, status, ...(detail === undefined ? {} : { detail }) })
  } catch {
    // 过程展示是旁路。
  }
}

function clip(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** 把三个入口的上下文边界收敛到执行层。 */
export interface ResolvedAnswerContext {
  profile: AnswerProfile
  context: ToolContext
  tools: AnswerRuntimeInput['profileTools']
  blocked?: { status: AnswerStatus; reason: string }
}

/**
 * 归一 profile 与工具上下文。
 *
 * session-ask 强制当前会话；clawbot-auto 强制关闭本机微信数据并要求 kbId。
 * 返回 blocked 而不是抛错，便于调用方把「缺会话 / 缺知识库」如实展示。
 * @param input - 运行时输入。
 * @returns 归一结果。
 */
export function resolveAnswerContext(input: AnswerRuntimeInput): ResolvedAnswerContext {
  const profile = getAnswerProfile(
    typeof input.profile === 'string' ? input.profile : input.profile.id,
  )
  const context: ToolContext = { ...input.toolContext }

  if (profile.forceUsername) {
    // 会话内问答只接受服务端传入的 toolContext.scope；问题文本里的「当前会话」
    // 不能成为新的边界，否则一次提示词注入就能改到别的会话。
    const username = context.scope?.username?.trim() ?? ''
    if (username === '') {
      return {
        profile,
        context,
        tools: [],
        blocked: { status: 'blocked', reason: '会话内问答缺少当前会话，已阻止检索' },
      }
    }
    context.scope = { ...(context.scope ?? {}), username }
    context.wechatDataEnabled = true
  }

  if (profile.kbOnly || profile.allowWechatData === false) {
    context.wechatDataEnabled = false
    if (profile.requireKb && (context.kbId === undefined || context.kbId <= 0)) {
      return {
        profile,
        context,
        tools: [],
        blocked: { status: 'blocked', reason: '未选择知识库，ClawBot 的数据检索已被阻止' },
      }
    }
  }

  return {
    profile,
    context,
    tools: filterToolsForProfile(profile, input.profileTools),
  }
}

function intentOptions(input: AnswerRuntimeInput, context: ToolContext) {
  const now = input.now ?? new Date()
  const state = input.threadState
  return {
    ...input.intentOptions,
    now,
    ...(context.scope?.username ? { currentSession: context.scope.username } : {}),
    ...(state
      ? {
        context: {
          ...(state.activeSession ? { activeSession: state.activeSession } : {}),
          ...(state.activeContact ? { activeContact: state.activeContact } : {}),
          ...(state.lastTimeRange ? { lastTimeRange: state.lastTimeRange } : {}),
          ...(state.lastEntity ? { lastEntity: state.lastEntity } : {}),
          ...(state.lastReferencedMessage ? { lastReferencedMessage: state.lastReferencedMessage } : {}),
          ...(state.lastIntent ? { lastIntent: state.lastIntent } : {}),
        },
      }
      : {}),
  }
}

function buildIntent(input: AnswerRuntimeInput, context: ToolContext): AnswerIntentDecision {
  return classifyAnswerIntent(input.question, intentOptions(input, context))
}

function appendSignal(
  intent: AnswerIntentDecision,
  signal: string,
): AnswerIntentDecision {
  if (intent.signals?.includes(signal)) return intent
  return { ...intent, signals: [...(intent.signals ?? []), signal] }
}

function emitClassifierStage(
  input: AnswerRuntimeInput,
  status: AnswerRuntimeStage['status'],
  detail: string,
  key: string,
): void {
  emit(input, key, '意图识别（LLM）', status, detail)
}

function isValidIntentSuggestion(value: unknown): value is AnswerIntentLlmSuggestion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['kind'] !== undefined && !isAnswerIntentKind(record['kind'])) return false
  if (
    record['confidence'] !== undefined
    && (typeof record['confidence'] !== 'number'
      || !Number.isFinite(record['confidence'])
      || record['confidence'] < 0
      || record['confidence'] > 1)
  ) return false
  if (
    record['toolHints'] !== undefined
    && (!Array.isArray(record['toolHints'])
      || record['toolHints'].some(item => typeof item !== 'string'))
  ) return false
  const scope = record['scopeHints']
  if (scope !== undefined && (typeof scope !== 'object' || scope === null || Array.isArray(scope))) {
    return false
  }
  return true
}

/**
 * 低置信/澄清时做一次有独立 deadline 的 LLM 分类。
 *
 * 规则始终先跑；高置信结果直接返回，不额外调用模型。分类器失败只回退规则，
 * 并通过 stage/signals 暴露原因，不能拖垮整轮问答。
 */
async function refineIntent(
  input: AnswerRuntimeInput,
  rule: AnswerIntentDecision,
): Promise<AnswerIntentDecision> {
  const threshold = input.intentOptions?.llmOverrideThreshold ?? 0.72
  if (!input.intentClassifier || (rule.confidence >= threshold && rule.kind !== 'clarify')) {
    return rule
  }
  const deadlineMs = Math.max(0, Math.trunc(
    input.intentClassifierDeadlineMs ?? DEFAULT_INTENT_CLASSIFIER_DEADLINE_MS,
  ))
  const controller = new AbortController()
  const request = Promise.resolve()
    .then(() => input.intentClassifier?.({
      question: input.question,
      rule,
      now: input.now ?? new Date(),
      signal: controller.signal,
    }))
  let raced:
    | { timedOut: false; value: AnswerIntentLlmSuggestion | null | undefined }
    | { timedOut: true }
  try {
    raced = deadlineMs === 0
      ? { timedOut: false as const, value: await request }
      : await withDeadline(request, deadlineMs, () => controller.abort(
        Object.assign(new Error('意图分类超时'), { code: 'intent_classifier_timeout' }),
      ))
  } catch {
    emitClassifierStage(input, 'failed', '分类器异常，已回退规则', 'classifier:llm_failed')
    return appendSignal(rule, 'classifier:llm_failed')
  }
  if (raced.timedOut) {
    emitClassifierStage(input, 'failed', `${String(deadlineMs)}ms 超时，已回退规则`, 'classifier:llm_timeout')
    return appendSignal(rule, 'classifier:llm_timeout')
  }
  const suggestion: unknown = raced.value
  if (!isValidIntentSuggestion(suggestion)) {
    emitClassifierStage(input, 'failed', '分类器返回不合法，已回退规则', 'classifier:llm_invalid')
    return appendSignal(rule, 'classifier:llm_invalid')
  }
  const merged = applyAnswerIntentSuggestion(
    rule,
    suggestion,
    { overrideThreshold: threshold },
  )
  emitClassifierStage(input, 'done', merged.kind, 'classifier:llm_done')
  return merged
}

/**
 * 只把「用户本轮明确说出的时间范围」落到硬过滤。
 *
 * 继承/递进的时间范围仍交给意图与模型参数，避免把上一轮的软偏好升级成
 * 本轮的硬筛选；会话名也不写入 username（它可能只是显示名）。
 *
 * 用户本轮写明了完整区间时必须覆盖界面遗留的窄日期：界面可能仍停在上次
 * 选中的单日，而问题原文明确要求一个月。日期不是身份边界，越界风险由
 * 工具守卫兜底；会话 username 仍保持硬锁，不受这里影响。
 */
function applyExplicitTimeScope(
  context: ToolContext,
  intent: AnswerIntentDecision,
): ToolContext {
  const range = intent.scopeHints?.timeRange
  if (!range || range.source !== 'explicit') return context
  const current = context.scope ?? {}
  const hasCompleteUserRange = range.from !== '' && range.to !== ''
  if (!hasCompleteUserRange && (current.from || current.to)) return context
  return {
    ...context,
    scope: {
      ...current,
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
    },
  }
}

function citationOf(
  item: EvidenceBundle['items'][number],
  index: number,
): AnswerRuntimeCitation | undefined {
  const embedded = citationRecord(item.citation)
  const base = {
    index,
    evidenceId: item.evidenceId,
    source: item.source,
    name: item.name,
    time: item.time,
    snippet: item.snippet,
  }
  if (item.locator.type === 'message') {
    return {
      ...base,
      username: stringValue(embedded?.['username']) || item.locator.username,
      local_id: numberValue(embedded?.['local_id']) ?? item.locator.localId,
      ...(item.sender || stringValue(embedded?.['sender'])
        ? { sender: item.sender ?? stringValue(embedded?.['sender']) }
        : {}),
      locator: item.locator,
    }
  }
  if (item.locator.type === 'kb') {
    const kb = citationRecord(embedded?.['kb'])
    return {
      ...base,
      username: '',
      local_id: 0,
      kb: {
        kbId: numberValue(kb?.['kbId']) ?? item.locator.kbId,
        chunkId: numberValue(kb?.['chunkId']) ?? item.locator.chunkId,
        fileName: stringValue(kb?.['fileName']) || item.locator.fileName,
        fileId: numberValue(kb?.['fileId']) ?? item.locator.fileId ?? 0,
        fileExt: stringValue(kb?.['fileExt']) || item.locator.fileExt || fileExtOf(item.locator.fileName),
        ordinal: numberValue(kb?.['ordinal']) ?? item.locator.ordinal ?? 0,
        page: numberValue(kb?.['page']) ?? item.locator.page ?? 0,
        heading: stringValue(kb?.['heading']) || item.locator.heading || '',
      },
      locator: item.locator,
    }
  }
  if (item.locator.type === 'fact') {
    return {
      ...base,
      username: '',
      local_id: 0,
      locator: item.locator,
    }
  }
  return undefined
}

function citationRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function fileExtOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 || dot === base.length - 1 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 证据包 → 可点击引用（保持 `AskCitation` 的核心字段）。 */
export function citationsFromEvidence(evidence: EvidenceBundle): AnswerRuntimeCitation[] {
  const out: AnswerRuntimeCitation[] = []
  for (const [offset, item] of evidence.items.entries()) {
    const citation = citationOf(item, offset + 1)
    if (citation) out.push(citation)
  }
  return out
}

/** 资源类证据（文件/收藏/朋友圈等）保留独立定位，不伪装成消息引用。 */
export function resourcesFromEvidence(evidence: EvidenceBundle): AnswerRuntimeResourceCitation[] {
  return evidence.items
    .filter(item => item.locator.type === 'resource')
    .map(item => ({
      evidenceId: item.evidenceId,
      tool: item.tool,
      key: item.key,
      name: item.name,
      time: item.time,
      snippet: item.snippet,
      locator: item.locator,
    }))
}

function fallbackAnswer(evidence: EvidenceBundle): string {
  if (evidence.items.length === 0) return ''
  const lines = evidence.items.slice(0, MAX_FALLBACK_ITEMS).map((item) => {
    const sender = item.sender ? `${item.sender}：` : ''
    const time = item.time ? `（${item.time}）` : ''
    return `- [${String(item.evidenceId)}] ${item.name}${time} ${sender}${clip(item.snippet, MAX_FALLBACK_SNIPPET)}`
  })
  const omitted = evidence.items.length > MAX_FALLBACK_ITEMS
    ? `\n（另有 ${String(evidence.items.length - MAX_FALLBACK_ITEMS)} 条证据未展开）`
    : ''
  return `${lines.join('\n')}${omitted}`
}

function normalizeSynthesis(value: string | AnswerSynthesisOutput): AnswerSynthesisOutput {
  return typeof value === 'string' ? { answer: value } : { ...value, answer: value.answer ?? '' }
}

function statusAfterSynthesis(
  evidence: EvidenceBundle,
  override: AnswerStatus | undefined,
): AnswerStatus {
  if (override) return override
  return evidence.status
}

function emptyEvidence(status: AnswerStatus = 'insufficient'): EvidenceBundle {
  return buildEvidenceBundle([], { status })
}

/** 状态对应的确定性兜底；所有分支都必须给用户一句可读的话。 */
function replyForStatus(status: AnswerStatus, profileId: AnswerProfileId, reason = ''): string {
  if (status === 'blocked') return blockedReply(reason)
  if (status === 'needs_clarification') return clarificationReply(reason, profileId)
  if (status === 'failed') return failedReply(profileId)
  return insufficientReply(profileId)
}

/** 用户主动停止不能被当成“检索失败”吞掉，必须继续向上抛。 */
function isCancelError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'ASK_CANCELED'
}

/**
 * 参数错误无法修复且没有可用证据时，问题不在数据源不可用，而在检索条件不足。
 * 只要还有超时、越权或内部失败混入，就不能把失败伪装成“请补充信息”。
 */
function needsArgumentClarification(toolCalls: readonly { ok: boolean, errorClass?: string }[]): boolean {
  let invalid = false
  for (const trace of toolCalls) {
    if (trace.ok) continue
    if (trace.errorClass === 'invalid_arguments') {
      invalid = true
      continue
    }
    return false
  }
  return invalid
}

/** 输出侧边界拒绝的可读原因；只使用已脱敏的拒绝摘要。 */
function scopeBlockedReason(evidence: EvidenceBundle): string {
  const note = evidence.stats.rejectionNotes?.[0]
  return note === undefined
    ? '检索结果越过当前数据边界，已阻止返回'
    : `检索结果越过当前数据边界：${note}`
}

interface DomainSupplement {
  loop: ToolLoopResult
  domain: AnswerDataDomain
  tool: string
}

/**
 * 只为缺失的一个专用数据域补查一次。
 *
 * 复用 `runToolLoop` 的单工具兜底路径，因此参数修复、profile 守卫、deadline、
 * 重试与结构化事件都和执行模型调用时一致。非知识库工具会临时摘掉 kbId，
 * 防止 `search_hybrid/search_kb` 在调用上限内抢走专用工具的预算。
 */
async function runDomainSupplement(input: {
  runtime: AnswerRuntimeInput
  profile: AnswerProfile
  tools: readonly RetrievalTool[]
  context: ToolContext
  domain: AnswerDataDomain
  tool: ToolName
  offset: number
}): Promise<DomainSupplement> {
  const { runtime, profile, tools, context, domain, tool, offset } = input
  // 只把本次专用工具放进临时 profile：runToolLoop 的 hybrid/kb 优先排序不能
  // 吃掉这唯一一次补查预算。原始 profile 与上下文边界不变。
  const supplementProfile: AnswerProfile = { ...profile, allowedTools: [tool] }
  const emptyTurn: AnswerRunTurnFn = async () => ({
    blocks: [],
    finish: { kind: 'stop' },
    text: '',
    reasoning: '',
  })
  const loop = await runToolLoop({
    system: runtime.system,
    messages: runtime.messages,
    question: runtime.question,
    profile: supplementProfile,
    profileTools: tools,
    toolContext: context,
    runTurn: emptyTurn,
    now: runtime.now ?? new Date(),
    maxRounds: 1,
    maxCallsPerRound: 1,
    fallbackTools: [tool],
    maxFallbackCalls: 1,
    ...(runtime.fallbackQuery ? { fallbackQuery: runtime.fallbackQuery } : {}),
    ...(runtime.throwIfCanceled ? { throwIfCanceled: runtime.throwIfCanceled } : {}),
    ...(runtime.cancelSignal ? { cancelSignal: runtime.cancelSignal } : {}),
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
    ...(runtime.toolDeadlineMs !== undefined ? { toolDeadlineMs: runtime.toolDeadlineMs } : {}),
    ...(runtime.op ? { op: runtime.op } : {}),
    emitStage: (stage) => {
      // 补查只转发工具阶段，避免重复普通流水线阶段。
      if (stage.callId === undefined) return
      runtime.emitStage?.({
        ...stage,
        key: `supplement:${String(offset)}:${stage.key}`,
        callId: `supplement_${String(offset)}_${stage.callId}`,
      })
    },
  })
  const traces = loop.toolCalls.map((trace, index) => ({
    ...trace,
    index: offset + index,
    callId: `supplement_${String(offset)}_${trace.callId}`,
  }))
  return {
    domain,
    tool,
    loop: { ...loop, toolCalls: traces },
  }
}

/** 计算缺失域并执行至多一次专用补查；返回 null 表示无需补查。 */
async function supplementMissingDomain(input: {
  runtime: AnswerRuntimeInput
  profile: AnswerProfile
  tools: readonly RetrievalTool[]
  context: ToolContext
  intent: AnswerIntentDecision
  evidence: EvidenceBundle
  results: readonly ToolResult[]
  traceCount: number
}): Promise<DomainSupplement | null> {
  const { runtime, profile, tools, context, intent, evidence, results, traceCount } = input
  const available = new Set(tools.map(tool => String(tool.name)))
  const attempted = new Set(results.map(result => String(result.tool)))
  const required = requiredDomainsFor(runtime.question, intent, profile, {
    hasKb: context.kbId !== undefined && context.kbId > 0,
    allowedTools: available,
  })
  const missing = missingDomains(required, evidence, results)
  if (missing.length === 0) return null
  const candidate = supplementCandidate(
    missing,
    available,
    attempted,
  )
  if (!candidate) return null
  emit(runtime, 'answer:supplement', '补充数据域', 'running', candidate.domain)
  const supplement = await runDomainSupplement({
    runtime,
    profile,
    tools,
    context,
    domain: candidate.domain,
    tool: candidate.tool,
    offset: traceCount,
  })
  emit(runtime, 'answer:supplement', '补充数据域', 'done', candidate.domain)
  return supplement
}

function stoppedResult(input: {
  status: AnswerStatus
  answer: string
  intent: AnswerIntentDecision
  profile: AnswerProfile
  context: ToolContext
  messages: Message[]
  started: number
  reason: string
}): AnswerRuntimeResult {
  return {
    status: input.status,
    answer: input.answer,
    intent: input.intent,
    evidence: emptyEvidence(
      input.status === 'blocked'
        ? 'blocked'
        : input.status === 'failed'
          ? 'failed'
          : undefined,
    ),
    profile: input.profile.id,
    context: input.context,
    toolCalls: [],
    toolResults: [],
    citations: [],
    resources: [],
    rounds: 0,
    exhausted: false,
    fallbackUsed: false,
    synthesized: false,
    messages: [...input.messages],
    usages: [],
    durationMs: Date.now() - input.started,
    reason: input.reason,
  }
}

/**
 * 运行一次完整问答。
 *
 * @param input - 见 {@link AnswerRuntimeInput}。
 * @returns 含状态、回答、证据、引用、工具 trace 的结果。
 */
export async function runAnswerRuntime(input: AnswerRuntimeInput): Promise<AnswerRuntimeResult> {
  const started = Date.now()
  const now = input.now ?? new Date()
  const { profile, context, tools, blocked } = resolveAnswerContext(input)
  const ruleIntent = buildIntent(input, context)

  if (blocked) {
    emit(input, 'answer:blocked', '检索已阻止', 'skipped', blocked.reason)
    return stoppedResult({
      status: blocked.status,
      answer: blockedReply(blocked.reason),
      intent: ruleIntent,
      profile,
      context,
      messages: input.messages,
      started,
      reason: blocked.reason,
    })
  }

  // 规则始终第一道；只有低置信/澄清才让分类器补一次，且受独立短 deadline。
  const intent = await refineIntent(input, ruleIntent)
  emit(input, 'answer:intent', '意图识别', 'done', intent.kind)

  // 显式时间范围一旦确定，就必须同时约束 schema、提示词建议与确定性兜底；
  // 只在执行守卫里拒绝会让模型先看到 `list_sessions`，白白浪费一轮调用。
  const executionContext = applyExplicitTimeScope(context, intent)
  const scopedTools = filterToolsForScope(profile, tools, executionContext)

  // 意图建议只作为「优先检查」进入工具选择提示；是否真正执行仍由模型与 schema 决定，
  // 首轮漏调工具时再由确定性兜底按白名单收口。
  const hintedTools = profileToolHints(profile, intent.toolHints, scopedTools)
  const fallbackTools = profileToolHints(profile, [
    ...resourceFallbackTools(
      input.question,
      new Set(scopedTools.map(tool => String(tool.name))),
    ),
    ...hintedTools,
  ], scopedTools)
  const system = fallbackTools.length > 0
    ? input.system + buildToolHintBlock(fallbackTools)
    : input.system

  const clarifyBeforeSearch = input.clarifyBeforeSearch ?? !profile.kbOnly
  if (
    clarifyBeforeSearch
    && (intent.kind === 'clarify' || intent.needsClarification === true)
  ) {
    emit(input, 'answer:clarify', '需要澄清', 'skipped', intent.reason)
    return stoppedResult({
      status: 'needs_clarification',
      answer: clarificationReply(intent.reason, profile.id),
      intent,
      profile,
      context,
      messages: input.messages,
      started,
      reason: intent.reason,
    })
  }

  const toolStage = await runAnswerTools({
    input,
    profile,
    context: executionContext,
    tools,
    intent,
    system,
    fallbackTools,
    now,
    started,
  })
  if ('stopped' in toolStage) return toolStage.stopped

  const collected = await collectAnswerEvidence({
    input,
    profile,
    context: executionContext,
    tools,
    intent,
    system,
    loop: toolStage.loop,
  })
  return finalizeAnswer({
    input,
    profile,
    context: executionContext,
    intent,
    loop: collected.loop,
    evidence: collected.evidence,
    citations: collected.citations,
    resources: collected.resources,
    now,
    started,
  })
}

type RuntimeBase = Omit<
  AnswerRuntimeResult,
  'status' | 'answer' | 'synthesized' | 'durationMs' | 'reason' | 'synthesisError'
>

interface ToolStageInput {
  input: AnswerRuntimeInput
  profile: AnswerProfile
  context: ToolContext
  tools: readonly RetrievalTool[]
  intent: AnswerIntentDecision
  system: string
  fallbackTools: readonly string[]
  now: Date
  started: number
}

/** 工具循环是唯一允许把异常收敛为 `failed` 回答的阶段；取消仍向外抛。 */
async function runAnswerTools(
  stage: ToolStageInput,
): Promise<{ loop: ToolLoopResult } | { stopped: AnswerRuntimeResult }> {
  const { input, profile, context, tools, system, fallbackTools, now, started } = stage
  emit(input, 'answer:tools', '工具调用', 'running')
  try {
    const loop = await runToolLoop({
      system,
      messages: input.messages,
      question: input.question,
      ...(input.tools ? { tools: input.tools } : {}),
      profile,
      profileTools: tools,
      toolContext: context,
      ...(input.throwIfCanceled ? { throwIfCanceled: input.throwIfCanceled } : {}),
      ...(input.cancelSignal ? { cancelSignal: input.cancelSignal } : {}),
      runTurn: input.runTurn,
      ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      ...(input.maxCallsPerRound !== undefined ? { maxCallsPerRound: input.maxCallsPerRound } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      now,
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.toolDeadlineMs !== undefined ? { toolDeadlineMs: input.toolDeadlineMs } : {}),
      ...(input.modelDeadlineMs !== undefined ? { modelDeadlineMs: input.modelDeadlineMs } : {}),
      ...(input.fallbackQuery ? { fallbackQuery: input.fallbackQuery } : {}),
      ...(fallbackTools.length > 0 ? { fallbackTools } : {}),
      ...(input.maxFallbackCalls !== undefined ? { maxFallbackCalls: input.maxFallbackCalls } : {}),
      ...(input.knownSessions ? { knownSessions: input.knownSessions } : {}),
      ...(input.knownSessionCatalog ? { knownSessionCatalog: input.knownSessionCatalog } : {}),
      ...(input.knownContacts ? { knownContacts: input.knownContacts } : {}),
      ...(input.assistantSource ? { assistantSource: input.assistantSource } : {}),
      ...(input.emitStage ? { emitStage: input.emitStage } : {}),
      ...(input.op ? { op: input.op } : {}),
      ...(input.onDelta ? { onDelta: input.onDelta } : {}),
      ...(input.onReasoning ? { onReasoning: input.onReasoning } : {}),
    })
    emit(input, 'answer:tools', '工具调用', 'done', `${String(loop.toolCalls.length)} 次调用`)
    return { loop }
  } catch (error) {
    if (isCancelError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    emit(input, 'answer:tools', '工具调用', 'failed', '模型或工具循环异常')
    return {
      stopped: stoppedResult({
        status: 'failed',
        answer: failedReply(profile.id),
        intent: stage.intent,
        profile,
        context,
        messages: input.messages,
        started,
        reason: `工具循环失败：${message}`,
      }),
    }
  }
}

interface EvidenceStage {
  loop: ToolLoopResult
  evidence: EvidenceBundle
  citations: AnswerRuntimeCitation[]
  resources: AnswerRuntimeResourceCitation[]
}

/** 构建并（必要时）补查一个缺失数据域；越界阻断后不再补查。 */
async function collectAnswerEvidence(stage: {
  input: AnswerRuntimeInput
  profile: AnswerProfile
  context: ToolContext
  tools: readonly RetrievalTool[]
  intent: AnswerIntentDecision
  system: string
  loop: ToolLoopResult
}): Promise<EvidenceStage> {
  const { input, profile, context, tools, intent, system } = stage
  let loop = stage.loop
  const scopeBoundary = profile.id === 'session-ask'
    ? { allowedUsername: context.scope?.username?.trim() ?? '' }
    : profile.kbOnly
      ? {
        kbOnly: true,
        ...(context.kbId !== undefined ? { allowedKbId: context.kbId } : {}),
      }
      : {}
  const evidenceOptions = {
    ...input.evidenceOptions,
    // profile 边界是硬约束，调用方不能通过 evidenceOptions 放宽。
    ...scopeBoundary,
    ...(intent.kind === 'aggregate' ? { aggregateIntent: true } : {}),
  }
  let evidence = buildEvidenceBundle(loop.toolResults, evidenceOptions)
  if (evidence.status !== 'blocked') {
    const supplement = await supplementMissingDomain({
      runtime: { ...input, system },
      profile,
      tools,
      context,
      intent,
      evidence,
      results: loop.toolResults,
      traceCount: loop.toolCalls.length,
    })
    if (supplement) {
      loop = {
        ...loop,
        toolCalls: [...loop.toolCalls, ...supplement.loop.toolCalls],
        toolResults: [...loop.toolResults, ...supplement.loop.toolResults],
        fallbackUsed: loop.fallbackUsed || supplement.loop.fallbackUsed,
      }
      evidence = buildEvidenceBundle(loop.toolResults, evidenceOptions)
    }
  }
  return {
    loop,
    evidence,
    citations: citationsFromEvidence(evidence),
    resources: resourcesFromEvidence(evidence),
  }
}

/** 所有出口都经过这里：阻断、澄清、失败与空证据都必须产生非空回答。 */
async function finalizeAnswer(stage: {
  input: AnswerRuntimeInput
  profile: AnswerProfile
  context: ToolContext
  intent: AnswerIntentDecision
  loop: ToolLoopResult
  evidence: EvidenceBundle
  citations: AnswerRuntimeCitation[]
  resources: AnswerRuntimeResourceCitation[]
  now: Date
  started: number
}): Promise<AnswerRuntimeResult> {
  const { input, profile, context, intent, loop, evidence, now, started } = stage
  const base: RuntimeBase = {
    intent,
    evidence,
    profile: profile.id,
    context,
    toolCalls: loop.toolCalls,
    toolResults: loop.toolResults,
    citations: stage.citations,
    resources: stage.resources,
    rounds: loop.rounds,
    exhausted: loop.exhausted,
    fallbackUsed: loop.fallbackUsed,
    messages: loop.messages,
    usages: loop.usages,
  }

  /*
   * 请求越权或工具输出越界时，不能进入综合生成：模型可能把已检索到的
   * 合法片段与越界内容混在一起，且无人值守入口会据此出网。
   */
  if (evidence.status === 'blocked') {
    const reason = scopeBlockedReason(evidence)
    emit(input, 'answer:blocked', '检索已阻止', 'skipped', reason)
    return {
      ...base,
      status: 'blocked',
      answer: blockedReply(reason),
      citations: [],
      resources: [],
      synthesized: false,
      durationMs: Date.now() - started,
      reason,
    }
  }

  if (
    evidence.assessment.usableItems === 0
    && needsArgumentClarification(loop.toolCalls)
  ) {
    const reason = '工具参数无法安全修复，需要补充检索条件'
    emit(input, 'answer:clarify', '需要澄清', 'skipped', reason)
    return {
      ...base,
      status: 'needs_clarification',
      answer: clarificationReply(reason, profile.id),
      synthesized: false,
      durationMs: Date.now() - started,
      reason,
    }
  }

  const skipSynthesis = evidence.status === 'failed'
    || (
      evidence.status === 'insufficient'
      && (input.synthesize === undefined || input.synthesizeOnInsufficient !== true)
    )
  if (skipSynthesis) {
    emit(input, 'answer:synthesize', '综合生成', 'skipped', evidence.status)
    return {
      ...base,
      status: evidence.status,
      // 模型可能在工具失败后给出解释；没有证据时仍如实标记 insufficient/failed。
      answer: loop.finalText.trim()
        || fallbackAnswer(evidence)
        || replyForStatus(evidence.status, profile.id, evidence.assessment.reason),
      synthesized: false,
      durationMs: Date.now() - started,
      reason: evidence.assessment.reason,
    }
  }

  emit(input, 'answer:synthesize', '综合生成', 'running')
  if (!input.synthesize) {
    emit(input, 'answer:synthesize', '综合生成', 'skipped', '未注入 synthesize')
    return {
      ...base,
      status: evidence.status,
      answer: fallbackAnswer(evidence)
        || replyForStatus(evidence.status, profile.id, evidence.assessment.reason),
      synthesized: false,
      durationMs: Date.now() - started,
      reason: '未注入 synthesize，已返回证据格式化文本',
    }
  }

  try {
    const synthesized = normalizeSynthesis(await input.synthesize({
      question: input.question,
      system: input.synthesisSystem ?? input.system,
      profile,
      context,
      intent,
      evidence,
      toolResults: loop.toolResults,
      finalText: loop.finalText,
      messages: loop.messages,
      now,
    }))
    const usages: TokenUsage[] = [...loop.usages]
    if (synthesized.usage) usages.push(synthesized.usage)
    const answer = synthesized.answer.trim()
    const requestedStatus = statusAfterSynthesis(evidence, synthesized.status)
    emit(input, 'answer:synthesize', '综合生成', 'done')
    return {
      ...base,
      usages,
      status: answer === '' && requestedStatus === 'ok' ? 'degraded' : requestedStatus,
      answer: answer === ''
        ? fallbackAnswer(evidence) || replyForStatus(requestedStatus, profile.id, evidence.assessment.reason)
        : synthesized.answer,
      ...(synthesized.citations ? { citations: [...synthesized.citations] } : {}),
      synthesized: answer !== '',
      durationMs: Date.now() - started,
      ...(answer === '' ? { reason: '综合生成返回空文本，已返回证据兜底' } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = evidence.status === 'ok' ? 'degraded' : evidence.status
    emit(input, 'answer:synthesize', '综合生成', 'done', '生成失败，已降级')
    return {
      ...base,
      status,
      answer: fallbackAnswer(evidence)
        || replyForStatus(status, profile.id, evidence.assessment.reason),
      synthesized: false,
      synthesisError: message,
      durationMs: Date.now() - started,
      reason: '综合生成失败，已返回证据格式化文本',
    }
  }
}
