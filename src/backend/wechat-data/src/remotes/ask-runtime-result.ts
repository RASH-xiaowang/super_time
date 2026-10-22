/**
 * 问答运行时结果 → 公开 `AskResult` 的映射。
 *
 * 这一层决定「状态如何变成用户看到的话」：空回答不得外泄，失败不得伪装成
 * 没有数据，引用与资源必须保持可追溯。把它从编排文件拆出，是为了让结果契约
 * 可以单独评审与测试，也给 `ask-runtime.ts` 留出 M21 的行数预算。
 *
 * @module remotes/ask-runtime-result
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { extractAskTerms } from '../query/ask.ts'
import type { AnswerIntentDecision } from '../query/answer-runtime/intent.ts'
import type {
  AnswerRuntimeCitation,
  AnswerRuntimeResult,
} from '../query/answer-runtime/types.ts'
import type {
  AnswerStatus,
  EvidenceBundle,
  EvidenceLocator,
} from '../query/answer-runtime/evidence.ts'
import { citationsFromEvidence } from '../query/answer-runtime/runtime.ts'
import {
  blockedReply,
  clarificationReply,
  failedReply,
  insufficientReply,
} from '../query/answer-runtime/replies.ts'
import type { ThreadState } from '../query/answer-runtime/thread-state.ts'
import type { AnswerProfileId } from '../query/tools/profiles.ts'
import {
  addTokenUsage,
  askBasisLine,
  citationToAskCitation,
  describeAskScope,
  isInsufficientStatus,
  type AskDataScope,
  type AskScope,
} from './ask-runtime-prompt.ts'
import type { AskCitation, AskPlan, AskResult } from '../types.ts'

/** 与旧引用同形，并把运行时的证据定位信息一并带回（旧客户端会忽略多出来的字段）。 */
export interface AskCitationWithTrace extends AskCitation {
  index: number
  evidenceId: string
  locator: EvidenceLocator
}

/** 生产编排结果：旧字段保持不变，新增字段用于过程解释与反馈归因。 */
export interface AskRuntimeResult extends AskResult {
  status: AnswerStatus
  evidence?: EvidenceBundle
  toolCalls?: AnswerRuntimeResultLike['toolCalls']
  resources?: AnswerRuntimeResultLike['resources']
  statusReason?: string
  threadState?: ThreadState
  /** 本轮实际采用的继承/递进范围（便于诊断为什么查到这些数据）。 */
  appliedThreadState?: {
    session?: string
    from?: string
    to?: string
    reason: string[]
  }
}

type AnswerRuntimeResultLike = AnswerRuntimeResult

/** 综合生成后的接地快照；用于最终状态降级与审计展示。 */
export interface GroundingSnapshot {
  citedIndexes: number[]
  withheld: boolean
  grounding?: {
    checked: number
    unsupported: Array<{ value: string }>
  }
  repaired: boolean
  evidenceUsed?: boolean
}

export function toTraceCitation(citation: AnswerRuntimeCitation): AskCitationWithTrace {
  return {
    ...citationToAskCitation(citation),
    index: citation.index,
    evidenceId: citation.evidenceId,
    locator: citation.locator,
  }
}

/** 综合阶段按证据顺序重新编号，避免模型看到旧编号造成错配。 */
export function reindexCitations(evidence: EvidenceBundle): AnswerRuntimeCitation[] {
  return citationsFromEvidence(evidence).map((citation, offset) => ({
    ...citation,
    index: offset + 1,
  }))
}

function buildPlan(
  intent: AnswerIntentDecision,
  question: string,
  scope: AskScope,
): AskPlan {
  const range = intent.scopeHints?.timeRange
  const terms = extractAskTerms(question).slice(0, 8)
  const subQueries = terms.length > 0 ? terms : (question.trim() === '' ? [] : [question.trim()])
  const person = intent.scopeHints?.contact ?? intent.scopeHints?.entities?.[0]
  return {
    intent: intent.kind,
    subQueries,
    ...(range?.from || scope.from ? { from: range?.from || scope.from } : {}),
    ...(range?.to || scope.to ? { to: range?.to || scope.to } : {}),
    ...(person ? { person } : {}),
    terms,
  }
}

function answerForStatus(
  runtime: AnswerRuntimeResult,
  profile: AnswerProfileId,
): string {
  const answer = runtime.answer.trim()
  if (runtime.status === 'needs_clarification') {
    return answer || clarificationReply(runtime.reason, profile)
  }
  if (runtime.status === 'blocked') return blockedReply(runtime.reason)
  if (runtime.status === 'failed') return failedReply(profile)
  if (runtime.status === 'insufficient' && profile !== 'clawbot-auto') {
    return insufficientReply(profile)
  }
  if (answer !== '') return answer
  if (runtime.status === 'degraded') {
    return runtime.citations.length > 0 || runtime.resources.length > 0
      ? '检索完成，但最终回答生成未完整通过核对。下方引用与资源仍可打开核对。'
      : failedReply(profile)
  }
  return insufficientReply(profile)
}

function retrievalOf(
  runtime: AnswerRuntimeResult,
  scope: AskScope,
  profile: AnswerProfileId,
  question: string,
): NonNullable<AskResult['retrieval']> {
  const stats = runtime.evidence.stats
  const recency = runtime.intent.legacy === 'recency_lookup' || /最近|最新|最后一次/.test(question)
  return {
    candidates: stats.candidateCount,
    kept: stats.count,
    scope: describeAskScope(scope, profile),
    recency,
    chunks: 0,
    windowMessages: stats.messages,
    intent: runtime.intent.kind,
  }
}

function usageOf(usages: readonly TokenUsage[]): TokenUsage | undefined {
  let total: TokenUsage | undefined
  for (const usage of usages) total = addTokenUsage(total, usage)
  return total
}

/** 把运行时结果映射回旧 `AskResult`（新增字段只附加，不改旧字段语义）。 */
export function askResultFromRuntime(input: {
  runtime: AnswerRuntimeResult
  profile: AnswerProfileId
  dataScope?: AskDataScope
  scope: AskScope
  question: string
  grounded?: GroundingSnapshot
  threadState?: ThreadState
}): AskRuntimeResult {
  const { runtime, profile, dataScope, scope, question } = input
  const citations = runtime.citations.map(toTraceCitation)
  const resources = runtime.resources
  const citedIndexes = input.grounded?.citedIndexes ?? []
  const basisBase = askBasisLine(citations, dataScope, resources.length)
  const basis = citedIndexes.length > 0
    ? `${basisBase}（回答引用了其中 ${String(citedIndexes.length)} 条：[${citedIndexes.join('][')}]）`
    : basisBase
  const status = runtime.status
  /*
   * 接地复核发生在证据包构建之后：模型可能一段都没有标 [n]，此时不能继续
   * 显示 `ok`。证据包本身保持不变（仍然可核对），只在最终结果上降级。
   */
  const withheld = input.grounded?.withheld === true
  const hasCitations = citations.length > 0
  // ClawBot 的 `chat` 模式按要求不标 [n]，不能把「没有角标」当成未引用。
  const uncited = profile !== 'clawbot-auto'
    && !withheld
    && runtime.synthesisError === undefined
    && hasCitations
    && citedIndexes.length === 0
  const finalStatus: AnswerStatus = (status === 'ok' && (withheld || uncited))
    ? 'degraded'
    : status
  // 综合阶段自身降级比“没有角标”更能解释用户看到的兜底文本。
  const synthesisReason = runtime.synthesisError
    ?? (runtime.reason?.includes('综合生成') ? runtime.reason : undefined)
  const statusReason = withheld
    ? '模型内容未通过接地核对，已不予采用'
    : synthesisReason
      ? synthesisReason
      : uncited
      ? '最终回答没有标注任何可核对来源，已按降级结果返回'
      : runtime.reason
  return {
    answer: answerForStatus(runtime, profile),
    citations,
    plan: buildPlan(runtime.intent, question, scope),
    citedIndexes,
    basis,
    insufficient: isInsufficientStatus(finalStatus),
    status: finalStatus,
    evidence: runtime.evidence,
    toolCalls: runtime.toolCalls,
    resources,
    retrieval: retrievalOf(runtime, scope, profile, question),
    ...(runtime.reason ? { reason: runtime.reason } : {}),
    ...(runtime.synthesisError ? { synthesisError: runtime.synthesisError } : {}),
    ...(input.grounded?.withheld ? { withheld: true } : {}),
    ...(input.grounded?.evidenceUsed === false ? { evidenceUsed: false } : {}),
    ...(input.grounded?.grounding
      ? {
        grounding: {
          checked: input.grounded.grounding.checked,
          unsupported: input.grounded.grounding.unsupported.map(item => item.value),
          cited: citedIndexes.length,
          repaired: input.grounded.repaired,
        },
      }
      : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(input.threadState ? { threadState: input.threadState } : {}),
    ...(runtime.usages.length > 0 ? { usage: usageOf(runtime.usages) } : {}),
  }
}
