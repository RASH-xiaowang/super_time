import { emitAnswerStage } from './runtime-events.ts'
import type { AnswerIntentDecision } from './intent.ts'
import {
  missingDomains,
  requiredDomainsFor,
  supplementCandidate,
  type AnswerDataDomain,
} from './required-domains.ts'
import { runToolLoop } from './tool-loop.ts'
import type { EvidenceBundle } from './evidence.ts'
import type { AnswerProfile } from '../tools/profiles.ts'
import type { RetrievalTool, ToolContext, ToolName, ToolResult } from '../tools/types.ts'
import type {
  AnswerRunTurnFn,
  AnswerRuntimeInput,
  ToolLoopResult,
} from './types.ts'

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
  /** 接在主工具循环之后，避免补查工具与第 1 轮混成一组。 */
  round: number
}): Promise<DomainSupplement> {
  const { runtime, profile, tools, context, domain, tool, offset, round } = input
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
        round,
      })
    },
  })
  const traces = loop.toolCalls.map((trace, index) => ({
    ...trace,
    index: offset + index,
    callId: `supplement_${String(offset)}_${trace.callId}`,
    round,
  }))
  return {
    domain,
    tool,
    // 即使补查没有 trace，也占用一个 UI 执行轮次。
    loop: { ...loop, rounds: round, toolCalls: traces },
  }
}

/** 计算缺失域并执行至多一次专用补查；返回 null 表示无需补查。 */
export async function supplementMissingDomain(input: {
  runtime: AnswerRuntimeInput
  profile: AnswerProfile
  tools: readonly RetrievalTool[]
  context: ToolContext
  intent: AnswerIntentDecision
  evidence: EvidenceBundle
  results: readonly ToolResult[]
  traceCount: number
  roundBase: number
}): Promise<DomainSupplement | null> {
  const { runtime, profile, tools, context, intent, evidence, results, traceCount, roundBase } = input
  const available = new Set(tools.map(tool => String(tool.name)))
  const attempted = new Set(results.map(result => String(result.tool)))
  const required = requiredDomainsFor(runtime.question, intent, profile, {
    hasKb: context.kbId !== undefined && context.kbId > 0,
    allowedTools: available,
  })
  const missing = missingDomains(required, evidence, results)
  if (missing.length === 0) return null
  const candidate = supplementCandidate(missing, available, attempted)
  if (!candidate) return null
  const supplementRound = Math.max(1, roundBase) + 1
  emitAnswerStage(runtime, 'answer:supplement', '补充数据域', 'running', candidate.domain, supplementRound)
  const supplement = await runDomainSupplement({
    runtime,
    profile,
    tools,
    context,
    domain: candidate.domain,
    tool: candidate.tool,
    offset: traceCount,
    round: supplementRound,
  })
  emitAnswerStage(runtime, 'answer:supplement', '补充数据域', 'done', candidate.domain, supplementRound)
  return supplement
}
