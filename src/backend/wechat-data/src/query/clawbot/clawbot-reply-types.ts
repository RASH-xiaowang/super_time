/**
 * ClawBot 自动回复在查询层与运行详情序列化之间共享的纯类型。
 *
 * 从 `types-ops.ts` 下沉，避免 `query/clawbot/**` 为了几个类型反向依赖胶水层；
 * 胶水层仍以原路径转发，外部导入无需改动。
 *
 * @module query/clawbot/clawbot-reply-types
 */
import type { AskCitation } from '../ask-citation-types.ts'
import type { AnswerStatus, EvidenceBundle } from '../answer-runtime/evidence.ts'
import type { AppliedThreadState } from '../answer-runtime/thread-state.ts'
import type {
  AnswerRuntimeResourceCitation,
  ToolCallTrace,
} from '../answer-runtime/types.ts'

/** 自动回复发送门禁的持久化结果。 */
export interface ClawbotReplySendDecision {
  send: boolean
  detail?: string
  error?: string
  errorCode?: string
  /** 兼容旧摘要里的 `reason` 字段。 */
  reason?: string
}

/** 自动回复向编排层返回的问答结果（含可持久化的运行时摘要字段）。 */
export interface ClawbotReplyAskResult {
  ok: boolean
  answer: string
  error?: string
  status?: AnswerStatus
  statusReason?: string
  synthesisError?: string
  toolCalls?: ToolCallTrace[]
  evidence?: EvidenceBundle
  citations?: AskCitation[]
  resources?: AnswerRuntimeResourceCitation[]
  grounding?: {
    checked: number
    unsupported: string[]
    cited: number
    repaired: boolean
  }
  sendDecision?: ClawbotReplySendDecision
  errorCode?: string
  appliedThreadState?: AppliedThreadState
}

/**
 * 单条自动回复的可展示运行摘要。
 *
 * 只保留能解释「回答怎么来、为什么发/没发」的元数据：不保存 answer 正文，
 * 不保存工具完整参数或资源 URL/token/seed。
 */
export interface ClawbotReplyRunDetail {
  runId: number
  /** 数据库 run 状态由列表层覆盖；生成摘要里可临时保存回答状态。 */
  status: string
  /** 生成阶段的原始回答状态（ok/degraded/insufficient/...）。 */
  answerStatus?: AnswerStatus
  statusReason?: string
  synthesisError?: string
  toolCalls?: ToolCallTrace[]
  evidence?: EvidenceBundle
  citations?: AskCitation[]
  resources?: AnswerRuntimeResourceCitation[]
  grounding?: {
    checked: number
    unsupported: string[]
    cited: number
    repaired: boolean
  }
  sendDecision?: ClawbotReplySendDecision
  errorCode?: string
  error?: string
  appliedThreadState?: AppliedThreadState
}
