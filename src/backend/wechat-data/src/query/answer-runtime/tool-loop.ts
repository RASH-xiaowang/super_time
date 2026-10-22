/**
 * 真实工具调用循环。
 *
 * `runTurn` 可注入，因此这里可以完全脱离模型与数据库做纯测试。生产接线传入
 * `createAskRunChatTurn()` 即可。
 *
 * 关键约束：
 *   · assistant 回放只保留 text/tool-call —— reasoning 块在部分供应商上不可回放；
 *   · 每个 tool-call 都必须有一条 callId 对应得上的 tool-result，否则下一轮会失联；
 *   · 参数先修复、再交给 `runProfileTool` 做白名单与范围守卫；
 *   · 只对 timeout/transient/rate_limited 做有界重试；
 *   · 工具结果压缩后再回放，避免整段正文撑爆上下文。
 *
 * @module query/answer-runtime/tool-loop
 */
import {
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { normalizeToolArguments, repairToolArguments, type ToolArgumentRepair } from './arguments.ts'
import { classifyToolErrorDetailed, type ToolErrorClass } from './errors.ts'
import { dedupeNames, fallbackArguments } from './fallback-query.ts'
import {
  filterToolsForScope,
  filterToolsForProfile,
  getAnswerProfile,
  runProfileTool,
} from '../tools/profiles.ts'
import { allTools } from '../tools/registry.ts'
import { findTool } from '../tools/types.ts'
import { toToolSchemas, type ToolResult } from '../tools/types.ts'
import { createToolCallTrace, summarizeToolArguments, toolCallCacheKey } from './trace.ts'
import { clip, serializeResult } from './tool-replay.ts'
import {
  detailAttempts,
  gateLateDelta,
  retryDelayMs,
  runTurnWithDeadline,
  sleepBeforeRetry,
  withDeadline,
} from './tool-runtime.ts'
import { emitStage, emitToolStage } from './tool-stage-events.ts'
import type {
  CachedToolResult,
  ToolCallTrace,
  ToolLoopInput,
  ToolLoopResult,
  ToolLoopStopReason,
} from './types.ts'

const DEFAULT_MAX_ROUNDS = 4
const DEFAULT_MAX_CALLS_PER_ROUND = 6
const DEFAULT_TOOL_DEADLINE_MS = 20_000
const DEFAULT_MODEL_DEADLINE_MS = 120_000
const DEFAULT_MAX_FALLBACK_CALLS = 3
const MAX_CACHE_ENTRIES = 64

function safeOp(input: ToolLoopInput, status: 'ok' | 'fail' | 'skip', target: string, detail?: string): void {
  try {
    input.op?.('task', 'answer_runtime_tool', status, target, detail)
  } catch {
    // 日志失败同样不应中断工具循环。
  }
}

function rememberResult(
  cache: Map<string, CachedToolResult>,
  order: CachedToolResult[],
  entry: CachedToolResult,
): void {
  cache.set(entry.key, entry)
  order.push(entry)
  while (order.length > MAX_CACHE_ENTRIES) {
    const oldest = order.shift()
    if (oldest) cache.delete(oldest.key)
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value))
}

/** 允许 0 的整数参数（0 = 关闭对应 deadline）。 */
function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}

/** profile 白名单内的 schema；即使调用方误传全量 schema，也会在这里收口。 */
export function buildToolLoopSchemas(
  input: Pick<ToolLoopInput, 'profile' | 'profileTools' | 'tools' | 'toolContext'>,
): ToolSchema[] {
  const profile = getAnswerProfile(
    typeof input.profile === 'string' ? input.profile : input.profile.id,
  )
  const allowed = new Set<string>(
    filterToolsForScope(profile, input.profileTools, input.toolContext).map(t => String(t.name)),
  )
  const schemas = input.tools ?? toToolSchemas(input.profileTools)
  return schemas.filter(schema => allowed.has(schema.name))
}

function replayBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.filter(
    (block): block is Extract<ContentBlock, { type: 'text' | 'tool-call' }> =>
      block.type === 'text' || block.type === 'tool-call',
  )
}

function toolCallsOf(blocks: readonly ContentBlock[]): ToolCallBlock[] {
  return blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
}

function failureResult(
  name: string,
  errorCode: NonNullable<ToolResult['errorCode']>,
  error: string,
  details?: Record<string, unknown>,
): ToolResult {
  return {
    tool: name as ToolResult['tool'],
    ok: false,
    error,
    errorCode,
    ...(details ? { errorDetails: details } : {}),
    hits: [],
  }
}

function classifyFailure(result: ToolResult): { cls: ToolErrorClass; code?: string } {
  const raw = result.errorCode
  if (raw === 'invalid_arguments' || raw === 'unknown_tool') return { cls: 'invalid_arguments', ...(raw ? { code: raw } : {}) }
  if (
    raw === 'scope_violation'
    || raw === 'tool_not_allowed'
    || raw === 'data_scope_blocked'
    || raw === 'scope_required'
    || raw === 'unsupported_scope'
  ) {
    return { cls: 'scope_blocked', ...(raw ? { code: raw } : {}) }
  }
  if (raw === 'not_configured') return { cls: 'not_found', ...(raw ? { code: raw } : {}) }
  const detailed = classifyToolErrorDetailed(result.error ?? '', {
    tool: String(result.tool),
    ...(raw ? { code: raw } : {}),
    ...retryAfterOption(result),
  })
  return { cls: detailed.cls, ...(raw ? { code: raw } : {}) }
}

/** profile 明确声明有副作用的工具不能自动重放，即使错误看起来是瞬时/限流。 */
function isSideEffectTool(loop: ToolLoopInput, name: string): boolean {
  const profile = typeof loop.profile === 'string' ? getAnswerProfile(loop.profile) : loop.profile
  return (profile.sideEffectTools ?? []).some(tool => String(tool) === name)
}

/** 工具把服务端等待建议放在 `errorDetails`；分类器需要它才能尊重限流退避。 */
function retryAfterOption(result: ToolResult): { retryAfterMs?: number } {
  const details = result.errorDetails
  if (!details) return {}
  for (const key of ['retryAfterMs', 'retry_after_ms']) {
    const value = details[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return { retryAfterMs: value }
    }
  }
  for (const key of ['retryAfterSec', 'retry_after_sec']) {
    const value = details[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return { retryAfterMs: value * 1000 }
    }
  }
  return {}
}

interface ExecuteInput {
  name: string
  args: Record<string, unknown>
  callId: string
  traceIndex: number
  round: number
  loop: ToolLoopInput
  deadlineMs: number
}

interface ExecuteOutcome {
  result: ToolResult
  trace: ToolCallTrace
  /** 本次调用实际允许的最大尝试次数（预检失败时为 1）。 */
  maxAttempts: number
  /** 实际执行/缓存命中的规范化参数键；参数无效或未执行时为空。 */
  cacheKey?: string
}

async function executeTool(input: ExecuteInput): Promise<ExecuteOutcome> {
  const { loop } = input
  const started = Date.now()
  const stageKey = `tool:${String(input.traceIndex)}:${input.name}`
  const argumentsSummary = summarizeToolArguments(input.args)
  let attempts = 0
  let result: ToolResult | undefined
  let errorClass: ToolErrorClass | undefined
  let deadlineExceeded = false
  let maxAttempts = 1

  while (attempts < maxAttempts) {
    input.loop.throwIfCanceled?.()
    attempts += 1
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: input.name,
      status: 'running',
      phase: attempts === 1 ? 'called' : 'retry',
      callId: input.callId,
      toolName: input.name,
      argumentsSummary,
      attempt: attempts,
      maxAttempts,
      elapsedMs: Date.now() - started,
      ...(attempts === 1 ? {} : { detail: `第 ${String(attempts)} 次尝试` }),
    })
    deadlineExceeded = false
    const attemptController = new AbortController()
    const onLoopAbort = (): void => {
      attemptController.abort(input.loop.cancelSignal?.reason)
    }
    if (input.loop.cancelSignal?.aborted === true) {
      input.loop.throwIfCanceled?.()
    }
    input.loop.cancelSignal?.addEventListener('abort', onLoopAbort, { once: true })
    const called = runProfileTool(
      loop.profile,
      loop.profileTools,
      input.name,
      input.args,
      {
        ...loop.toolContext,
        signal: attemptController.signal,
      },
    )
    let raced: { timedOut: false; value: { value: ToolResult } } | { timedOut: true }
    try {
      raced = await withDeadline(
        called.then(value => ({ value })),
        input.deadlineMs,
        () => { attemptController.abort('deadline') },
      )
    } finally {
      input.loop.cancelSignal?.removeEventListener('abort', onLoopAbort)
    }
    if (raced.timedOut) {
      deadlineExceeded = true
      errorClass = 'timeout'
      result = failureResult(input.name, 'upstream_failure', `工具 ${input.name} 执行超时（${String(input.deadlineMs)}ms）`)
    } else {
      result = raced.value.value
      errorClass = result.ok ? undefined : classifyFailure(result).cls
    }
    if (result.ok || errorClass === undefined) break
    const detailed = classifyToolErrorDetailed(result.error ?? '', {
      tool: input.name,
      ...(result.errorCode ? { code: result.errorCode } : {}),
      ...(raced.timedOut ? { category: 'timeout' as const } : {}),
      ...(isSideEffectTool(loop, input.name) ? { sideEffect: true } : {}),
      ...retryAfterOption(result),
    })
    maxAttempts = detailAttempts(detailed.maxAttempts)
    if (!detailed.retryable || attempts >= maxAttempts) break
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: input.name,
      status: 'running',
      phase: 'retry',
      callId: input.callId,
      toolName: input.name,
      argumentsSummary,
      attempt: attempts,
      maxAttempts,
      elapsedMs: Date.now() - started,
      errorClass: errorClass ?? 'internal',
      ...(deadlineExceeded ? { deadlineExceeded: true } : {}),
      detail: `第 ${String(attempts)}/${String(maxAttempts)} 次失败，准备重试`,
    })
    await sleepBeforeRetry(loop, retryDelayMs(detailed.retryAfterMs, attempts))
  }

  const final = result ?? failureResult(input.name, 'upstream_failure', '工具未执行')
  const classified = final.ok ? undefined : classifyFailure(final)
  const trace = createToolCallTrace({
    index: input.traceIndex,
    round: input.round,
    callId: input.callId,
    name: input.name,
    args: input.args,
    ok: final.ok,
    attempts,
    elapsedMs: Date.now() - started,
    ...(final.ok ? {} : { errorClass: errorClass ?? classified?.cls ?? 'internal' }),
    ...(final.errorCode ? { errorCode: final.errorCode } : {}),
    ...(final.ok || final.error === undefined ? {} : { errorMessage: final.error }),
    hits: final.hits.length,
    facts: final.facts?.length ?? 0,
    ...(deadlineExceeded ? { deadlineExceeded: true } : {}),
    ...(final.note ? { note: final.note } : {}),
  })
  return { result: final, trace, maxAttempts }
}

async function executeCall(input: {
  call: ToolCallBlock
  traceIndex: number
  round: number
  loop: ToolLoopInput
  cache: Map<string, CachedToolResult>
  cacheOrder: CachedToolResult[]
  deadlineMs: number
  overLimit: boolean
}): Promise<ExecuteOutcome> {
  const { call, loop } = input
  if (input.overLimit) {
    const limitNote = `超过每轮 ${String(positiveInt(loop.maxCallsPerRound, DEFAULT_MAX_CALLS_PER_ROUND))} 个调用的上限，未执行`
    const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
    const trace = createToolCallTrace({
      index: input.traceIndex,
      round: input.round,
      callId: String(call.id),
      name: call.name,
      args: { raw: clip(call.arguments, 120) },
      ok: false,
      skipped: true,
      errorClass: 'invalid_arguments',
      errorMessage: limitNote,
      note: limitNote,
    })
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: call.name,
      status: 'skipped',
      phase: 'failed',
      callId: String(call.id),
      toolName: call.name,
      argumentsSummary: trace.argumentsSummary,
      attempt: 0,
      maxAttempts: 1,
      errorClass: 'invalid_arguments',
      detail: limitNote,
    })
    return {
      result: failureResult(call.name, 'invalid_arguments', limitNote),
      trace,
      maxAttempts: 1,
    }
  }

  let raw: unknown
  try {
    raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments) as unknown
  } catch {
    const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
    const argumentsSummary = summarizeToolArguments({ raw: clip(call.arguments, 120) })
    const trace = createToolCallTrace({
      index: input.traceIndex,
      round: input.round,
      callId: String(call.id),
      name: call.name,
      args: { raw: clip(call.arguments, 120) },
      ok: false,
      errorClass: 'invalid_arguments',
      errorMessage: '工具参数不是合法 JSON',
      note: '工具参数不是合法 JSON',
    })
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: call.name,
      status: 'failed',
      phase: 'failed',
      callId: String(call.id),
      toolName: call.name,
      argumentsSummary,
      attempt: 0,
      maxAttempts: 1,
      errorClass: 'invalid_arguments',
      detail: '工具参数不是合法 JSON',
    })
    return {
      result: failureResult(call.name, 'invalid_arguments', '工具参数不是合法 JSON'),
      trace,
      maxAttempts: 1,
    }
  }

  const knownTool = findTool(loop.profileTools, call.name) ?? findTool(allTools, call.name)
  if (!knownTool) {
    const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
    const trace = createToolCallTrace({
      index: input.traceIndex,
      round: input.round,
      callId: String(call.id),
      name: call.name,
      args: isRecord(raw) ? raw : {},
      ok: false,
      errorClass: 'invalid_arguments',
      errorCode: 'unknown_tool',
      errorMessage: `没有这个工具：${call.name}`,
      note: '没有这个工具',
    })
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: call.name,
      status: 'failed',
      phase: 'failed',
      callId: String(call.id),
      toolName: call.name,
      argumentsSummary: trace.argumentsSummary,
      attempt: 0,
      maxAttempts: 1,
      errorClass: 'invalid_arguments',
      detail: '没有这个工具',
    })
    return {
      result: failureResult(call.name, 'unknown_tool', `没有这个工具：${call.name}`),
      trace,
      maxAttempts: 1,
    }
  }

  const repaired = repairArguments(call.name, raw, loop)
  if (!repaired.ok) {
    const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
    const detail = repaired.error ?? '参数校验失败'
    const trace = createToolCallTrace({
      index: input.traceIndex,
      round: input.round,
      callId: String(call.id),
      name: call.name,
      args: isRecord(raw) ? raw : { raw: clip(String(raw), 120) },
      ok: false,
      errorClass: 'invalid_arguments',
      errorMessage: detail,
      note: detail,
    })
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: call.name,
      status: 'failed',
      phase: 'failed',
      callId: String(call.id),
      toolName: call.name,
      argumentsSummary: trace.argumentsSummary,
      attempt: 0,
      maxAttempts: 1,
      errorClass: 'invalid_arguments',
      detail,
    })
    return {
      result: failureResult(call.name, 'invalid_arguments', detail, {
        ...(repaired.field ? { field: repaired.field } : {}),
      }),
      trace,
      maxAttempts: 1,
    }
  }

  const cacheArgs = scopeNormalizedArgs(call.name, repaired.args, loop)
  const key = toolCallCacheKey(call.name, cacheArgs)
  const cached = input.cache.get(key)
  if (cached) {
    const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
    const trace = createToolCallTrace({
      index: input.traceIndex,
      round: input.round,
      callId: String(call.id),
      name: call.name,
      args: cacheArgs,
      ok: cached.result.ok,
      deduplicated: true,
      hits: cached.result.hits.length,
      facts: cached.result.facts?.length ?? 0,
      ...(cached.result.ok ? {} : { errorClass: classifyFailure(cached.result).cls }),
      ...(cached.result.errorCode ? { errorCode: cached.result.errorCode } : {}),
      note: '复用相同工具与参数的本次结果',
      ...(cached.result.ok ? {} : { errorMessage: cached.result.error }),
    })
    emitToolStage(loop.emitStage, {
      key: stageKey,
      label: call.name,
      status: cached.result.ok ? 'done' : 'failed',
      phase: cached.result.ok ? 'completed' : 'failed',
      callId: String(call.id),
      toolName: call.name,
      argumentsSummary: trace.argumentsSummary,
      attempt: 0,
      maxAttempts: 1,
      ...(trace.errorClass === undefined ? {} : { errorClass: trace.errorClass }),
      hits: trace.hits,
      facts: trace.facts,
      detail: '复用相同工具与参数的本次结果',
    })
    return { result: cached.result, trace, maxAttempts: 1, cacheKey: key }
  }

  const stageKey = `tool:${String(input.traceIndex)}:${call.name}`
  const outcome = await executeTool({
    name: call.name,
    args: repaired.args,
    callId: String(call.id),
    traceIndex: input.traceIndex,
    round: input.round,
    loop,
    deadlineMs: input.deadlineMs,
  })
  emitToolStage(loop.emitStage, {
    key: stageKey,
    label: call.name,
    status: outcome.result.ok ? 'done' : 'failed',
    phase: outcome.result.ok ? 'completed' : 'failed',
    callId: String(call.id),
    toolName: call.name,
    argumentsSummary: outcome.trace.argumentsSummary,
    attempt: outcome.trace.attempts,
    maxAttempts: outcome.maxAttempts,
    elapsedMs: outcome.trace.elapsedMs,
    ...(outcome.trace.errorClass === undefined ? {} : { errorClass: outcome.trace.errorClass }),
    ...(outcome.trace.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
    hits: outcome.trace.hits,
    facts: outcome.trace.facts,
    detail: outcome.result.ok
      ? `${String(outcome.result.hits.length)} 条命中`
      : traceFailureMessage(outcome.trace),
  })
  safeOp(
    loop,
    outcome.result.ok ? 'ok' : 'fail',
    call.name,
    outcome.result.ok ? `${String(outcome.result.hits.length)} 条命中` : traceFailureMessage(outcome.trace),
  )
  if (outcome.result.ok) {
    const cachedEntry: CachedToolResult = {
      key,
      name: call.name,
      args: cacheArgs,
      result: outcome.result,
    }
    rememberResult(input.cache, input.cacheOrder, cachedEntry)
  }
  return { ...outcome, cacheKey: key }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 过程展示与操作日志只使用已脱敏的失败摘要。 */
function traceFailureMessage(trace: ToolCallTrace): string {
  return trace.errorMessage ?? trace.note ?? '失败'
}

/**
 * 自定义工具集不在 `allTools` 时，`repairToolArguments` 找不到 schema；
 * 此时直接用它自己的 schema 走同一套归一化，避免把「工具存在」误判成未知工具。
 */
function repairArguments(
  name: string,
  raw: unknown,
  loop: ToolLoopInput,
): ToolArgumentRepair {
  const registered = findTool(allTools, name)
  if (registered) {
    return repairToolArguments(name, raw, {
      ...(loop.now ? { now: loop.now } : {}),
      ...(loop.knownSessions ? { knownSessions: loop.knownSessions } : {}),
      ...(loop.knownSessionCatalog ? { knownSessionCatalog: loop.knownSessionCatalog } : {}),
      ...(loop.knownContacts ?? loop.toolContext.knownEntities
        ? { knownContacts: loop.knownContacts ?? loop.toolContext.knownEntities }
        : {}),
      ...forcedScopeForArguments(raw, loop),
    })
  }
  const tool = findTool(loop.profileTools, name)
  if (!tool) {
    return { ok: false, args: {}, repairs: [], error: `没有这个工具：${name}` }
  }
  const normalized = normalizeToolArguments(
    { name: tool.name, parameters: tool.parameters },
    withForcedScope(tool.parameters, raw, loop),
    {
      decryptedDir: loop.toolContext.decryptedDir,
      ...(loop.now ? { now: loop.now } : {}),
      ...(loop.toolContext.scope ? { scope: loop.toolContext.scope } : {}),
    },
    {
      ...(loop.now ? { now: loop.now } : {}),
    },
  )
  const forced = forcedScopeForArguments(raw, loop).forcedScope?.username
  const repairs = [
    ...(forced === undefined ? [] : [
      `username: 已应用强制会话范围 ${forced}`,
    ]),
    ...normalized.fixes.map(fix => fix.message),
  ]
  if (normalized.ok) return { ok: true, args: normalized.args, repairs }
  const first = normalized.errors[0]
  return {
    ok: false,
    args: normalized.args,
    repairs,
    ...(first ? { error: first.message, field: first.field } : { error: '参数校验失败' }),
  }
}

/**
 * 自定义工具不在注册表时，也必须先注入强制会话。
 *
 * `normalizeToolArguments` 的必填校验发生在 `enforceProfileScope` 之前；如果等到
 * 执行守卫再补 `username`，模型漏填时已经被判成 `missing_required`，永远走不到
 * 会话锁定逻辑。
 */
function withForcedScope(
  parameters: Record<string, unknown>,
  raw: unknown,
  loop: ToolLoopInput,
): unknown {
  const username = forcedScopeForArguments(raw, loop).forcedScope?.username
  if (username === undefined) return raw
  const properties = isRecord(parameters['properties']) ? parameters['properties'] : {}
  if (!Object.prototype.hasOwnProperty.call(properties, 'username')) return raw
  if (raw === null || raw === undefined) return { username }
  // 走到这里说明模型没填 username 或已与锁定会话一致；两者都用锁定值收口。
  return isRecord(raw) ? { ...raw, username } : raw
}

/**
 * 只在模型没给 username 时注入锁定会话。
 *
 * 显式填写了**别的**会话时必须保留原值，让执行守卫返回 `scope_violation`；
 * 静默改成当前会话会让用户以为查了目标会话，实际上查的是另一个。
 */
function forcedScopeForArguments(
  raw: unknown,
  loop: ToolLoopInput,
): { forcedScope?: { username?: string } } {
  const forced = forcedScopeOf(loop)
  const username = forced.forcedScope?.username
  if (username === undefined) return {}
  if (isRecord(raw) && raw['username'] !== undefined && raw['username'] !== null && raw['username'] !== '') {
    return String(raw['username']).trim() === username ? forced : {}
  }
  return forced
}

/**
 * 会话内问答的锁定范围要在 schema 必填校验之前注入。
 *
 * 否则模型漏填 `get_session_messages.username` 时会先报「缺少必填参数」，
 * 根本走不到 `enforceProfileScope` 的自动补齐逻辑。
 */
function forcedScopeOf(loop: ToolLoopInput): { forcedScope?: { username?: string } } {
  const profile = getAnswerProfile(
    typeof loop.profile === 'string' ? loop.profile : loop.profile.id,
  )
  if (!profile.forceUsername) return {}
  const username = loop.toolContext.scope?.username?.trim()
  return username ? { forcedScope: { username } } : {}
}

/**
 * 缓存键使用「范围归一后」的参数：会话内问答里「不填 username」与「显式填
 * 当前 username」是同一次调用。跨会话的 username 不会被覆盖，仍会进入执行守卫。
 */
function scopeNormalizedArgs(
  name: string,
  args: Record<string, unknown>,
  loop: ToolLoopInput,
): Record<string, unknown> {
  const profile = getAnswerProfile(
    typeof loop.profile === 'string' ? loop.profile : loop.profile.id,
  )
  if (!profile.forceUsername || args['username'] !== undefined) return args
  const locked = loop.toolContext.scope?.username?.trim()
  if (!locked) return args
  const tool = findTool(loop.profileTools, name)
  const properties = tool && isRecord(tool.parameters['properties'])
    ? tool.parameters['properties']
    : undefined
  if (!properties || !Object.prototype.hasOwnProperty.call(properties, 'username')) return args
  return { ...args, username: locked }
}

function assistantMessage(
  turnBlocks: ContentBlock[],
  source: { provider: string; model: string },
): Message {
  return createAssistantMessage({
    content: replayBlocks(turnBlocks),
    source,
  })
}

async function runFallback(input: {
  loop: ToolLoopInput
  traceIndex: number
  round: number
  cache: Map<string, CachedToolResult>
  cacheOrder: CachedToolResult[]
  deadlineMs: number
  /** 补查时跳过已经失败或零命中的“同工具 + 同规范化参数”。 */
  skipKeys?: ReadonlySet<string>
}): Promise<ExecuteOutcome[]> {
  const allowed = new Set(
    filterToolsForScope(input.loop.profile, input.loop.profileTools, input.loop.toolContext)
      .map(t => String(t.name)),
  )
  const requested = (input.loop.fallbackTools ?? [])
    .map(name => String(name).trim())
    .filter(name => name !== '' && allowed.has(name))
  const hasKb = input.loop.toolContext.kbId !== undefined && input.loop.toolContext.kbId > 0
  const hybrid = allowed.has('search_hybrid') ? ['search_hybrid'] : []
  const kb = hasKb && allowed.has('search_kb') ? ['search_kb'] : []
  const focused = requested.filter(name => name !== 'aggregate_messages')
  const aggregate = requested.filter(name => name === 'aggregate_messages')
  // 选了知识库时先保证两个数据域都被检索：hybrid 覆盖消息 + 知识库，
  // search_kb 再补上 hybrid 可能漏掉的文件域。资源专用工具放到其后，
  // 避免它们先命中消息就把知识库覆盖挤到调用上限之外。
  // `aggregate_messages` 永远排在最后：它能对「0 条命中」也给出一条统计事实，
  // 若排在 hybrid 前面会提前满足停止条件，导致真正可引用的原文一次都没查。
  const names = dedupeNames(hasKb
    ? [...hybrid, ...kb, ...focused, ...aggregate]
    : [...focused, ...hybrid, ...kb, ...aggregate])
  const limit = Math.max(
    1,
    Math.min(
      positiveInt(input.loop.maxCallsPerRound, DEFAULT_MAX_CALLS_PER_ROUND),
      positiveInt(input.loop.maxFallbackCalls, DEFAULT_MAX_FALLBACK_CALLS),
    ),
  )
  const outcomes: ExecuteOutcome[] = []
  for (const name of names.slice(0, limit)) {
    const args = fallbackArguments(name, input.loop)
    if (args === undefined) continue
    const plannedKey = plannedFallbackKey(name, args, input.loop)
    if (plannedKey !== undefined && input.skipKeys?.has(plannedKey)) {
      emitToolStage(input.loop.emitStage, {
        key: `tool:${String(input.traceIndex + outcomes.length)}:${name}`,
        label: name,
        status: 'skipped',
        phase: 'failed',
        callId: `runtime_fallback_${String(input.traceIndex + outcomes.length)}`,
        toolName: name,
        argumentsSummary: summarizeToolArguments(args),
        attempt: 0,
        maxAttempts: 1,
        detail: '补查跳过：与上一轮失败/零命中的工具和参数相同',
      })
      continue
    }
    const outcome = await executeCall({
      call: {
        type: 'tool-call',
        id: `runtime_fallback_${String(input.traceIndex + outcomes.length)}` as ToolCallBlock['id'],
        name,
        arguments: JSON.stringify(args),
      },
      traceIndex: input.traceIndex + outcomes.length,
      round: input.round,
      loop: input.loop,
      cache: input.cache,
      cacheOrder: input.cacheOrder,
      deadlineMs: input.deadlineMs,
      overLimit: false,
    })
    outcomes.push(outcome)
    // 停止条件按「数据域是否已覆盖」判断，而不是「任意一条命中」：
    // 有 kbId 时，消息命中不代表文件域已经查过；否则知识库问题会被消息结果截断。
    if (fallbackCovered(name, outcomes, input.loop)) {
      break
    }
  }
  return outcomes
}

/** 某次兜底结果是否可视为「有命中」。 */
function fallbackHasEvidence(outcome: ExecuteOutcome): boolean {
  return resultHasEvidence(outcome.result)
}

function resultHasEvidence(result: ToolResult): boolean {
  return result.ok && (result.hits.length > 0 || (result.facts?.length ?? 0) > 0)
}

/**
 * 兜底循环的停止判据。
 *
 * `search_hybrid` 在 `auto` 模式同时覆盖消息与知识库；但它可能只召回了消息，
 * 此时仍应再跑 `search_kb`。ClawBot 只有 `search_kb`，它自己就是目标域。
 */
function fallbackCovered(
  name: string,
  outcomes: readonly ExecuteOutcome[],
  loop: ToolLoopInput,
): boolean {
  const current = outcomes[outcomes.length - 1]
  if (!current || !fallbackHasEvidence(current)) return false
  const kbId = loop.toolContext.kbId
  const hasKb = kbId !== undefined && kbId > 0
  if (name === 'aggregate_messages') {
    const broadAvailable = filterToolsForProfile(loop.profile, loop.profileTools)
      .some(tool => tool.name === 'search_hybrid')
    // 纯统计问题只有聚合结果也够；但只要本轮还有 broad 检索可跑，就先把原文拿来。
    return !broadAvailable
      || outcomes.some(outcome => outcome.result.tool === 'search_hybrid')
  }
  if (!hasKb) return true
  if (name === 'search_kb') return true
  // 有知识库时，消息域命中不等于文件域已覆盖；继续让 hybrid / search_kb 补齐。
  if (name !== 'search_hybrid') return false
  return outcomes.some(outcome =>
    outcome.result.ok && outcome.result.hits.some(hit => hit.source === 'kb'),
  )
}

/**
 * 预计算兜底调用的缓存键，用于补查前跳过同工具同参。
 *
 * 这里复用正式执行前的参数修复与范围归一，避免“看起来参数不同、修复后其实
 * 相同”的调用被重复执行。
 */
function plannedFallbackKey(
  name: string,
  args: Record<string, unknown>,
  loop: ToolLoopInput,
): string | undefined {
  const repaired = repairArguments(name, args, loop)
  if (!repaired.ok) return undefined
  return toolCallCacheKey(name, scopeNormalizedArgs(name, repaired.args, loop))
}

/**
 * 跑工具循环。
 *
 * @param input - 见 {@link ToolLoopInput}。
 * @returns 最终消息、trace 与去重后的工具结果。
 */
export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxRounds = positiveInt(input.maxRounds, DEFAULT_MAX_ROUNDS)
  const maxCalls = positiveInt(input.maxCallsPerRound, DEFAULT_MAX_CALLS_PER_ROUND)
  const deadlineMs = positiveInt(input.toolDeadlineMs, DEFAULT_TOOL_DEADLINE_MS)
  const modelDeadlineMs = nonNegativeInt(input.modelDeadlineMs, DEFAULT_MODEL_DEADLINE_MS)
  const source = input.assistantSource ?? { provider: 'answer-runtime', model: 'unknown' }
  const schemas = buildToolLoopSchemas(input)
  const messages = [...input.messages]
  const cache = new Map<string, CachedToolResult>()
  const cacheOrder: CachedToolResult[] = []
  const results: ToolResult[] = []
  const traces: ToolCallTrace[] = []
  const usages: ToolLoopResult['usages'] = []
  const noEvidenceKeys = new Set<string>()
  let supplementUsed = false
  let lastText = ''
  let lastBlocks: ContentBlock[] = []
  let fallbackUsed = false
  let stopReason: ToolLoopStopReason = 'stop'
  let rounds = 0

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round
    emitStage(input.emitStage, `answer:round:${String(round)}`, `工具选择（第 ${String(round)} 轮）`, 'running')
    const turn = await runTurnWithDeadline({
      loop: {
        ...input,
        messages,
      },
      deadlineMs: modelDeadlineMs,
      buildTurnInput: signal => ({
        system: input.system,
        messages,
        maxTokens: input.maxTokens ?? 2000,
        ...(signal !== undefined ? { signal } : {}),
        ...(schemas.length > 0 ? { tools: schemas } : {}),
        ...(input.onDelta
          ? { onDelta: gateLateDelta(input.onDelta, signal) }
          : {}),
        ...(input.onReasoning
          ? { onReasoning: gateLateDelta(input.onReasoning, signal) }
          : {}),
      }),
    })
    if (turn.usage) usages.push(turn.usage)
    if (turn.text !== '') lastText = turn.text
    lastBlocks = replayBlocks(turn.blocks)
    const calls = toolCallsOf(turn.blocks)
    emitStage(
      input.emitStage,
      `answer:round:${String(round)}`,
      `工具选择（第 ${String(round)} 轮）`,
      'done',
      `${String(calls.length)} 个工具调用`,
    )

    if (calls.length === 0) {
      if (lastBlocks.length > 0) messages.push(assistantMessage(turn.blocks, source))
      // 首轮模型只说了话、没调工具时也必须检索：否则「看起来像在回答」的空口
      // 文本会被当成完成，ClawBot 更是会绕过唯一允许的 search_kb。
      // 后续轮次若已有结果全部失败或零命中，再做**一次**有界补查；只要还有
      // 任意可引用命中或事实，就尊重模型停止，不额外扩大检索。
      const needsSupplement = round > 1
        && !supplementUsed
        && results.length > 0
        && results.every(result => !resultHasEvidence(result))
      if ((round === 1 || needsSupplement) && !fallbackUsed) {
        if (needsSupplement) supplementUsed = true
        const fallback = await runFallback({
          loop: input,
          traceIndex: traces.length,
          round,
          cache,
          cacheOrder,
          deadlineMs,
          ...(needsSupplement ? { skipKeys: noEvidenceKeys } : {}),
        })
        if (fallback.length > 0) {
          fallbackUsed = true
          for (const outcome of fallback) {
            traces.push(outcome.trace)
            results.push(outcome.result)
          }
        }
        stopReason = turn.text.trim() === '' ? 'no-output' : 'no-tool-call'
      }
      break
    }

    messages.push(assistantMessage(turn.blocks, source))
    for (const [offset, call] of calls.entries()) {
      const traceIndex = traces.length
      const overLimit = offset >= maxCalls
      const outcome = await executeCall({
        call,
        traceIndex,
        round,
        loop: input,
        cache,
        cacheOrder,
        deadlineMs,
        overLimit,
      })
      traces.push(outcome.trace)
      if (!overLimit && !outcome.trace.deduplicated) {
        results.push(outcome.result)
        if (!resultHasEvidence(outcome.result) && outcome.cacheKey !== undefined) {
          noEvidenceKeys.add(outcome.cacheKey)
        }
      }
      messages.push(createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: serializeResult(outcome.result) }],
        isError: !outcome.result.ok,
      }))
    }
    if (round === maxRounds) {
      stopReason = 'max-rounds'
    }
  }

  return {
    messages,
    finalText: lastText,
    finalBlocks: lastBlocks,
    rounds,
    exhausted: stopReason === 'max-rounds',
    fallbackUsed,
    stopReason,
    toolResults: results,
    toolCalls: traces,
    cachedResults: cacheOrder,
    usages,
  }
}

export { summarizeToolArguments }
