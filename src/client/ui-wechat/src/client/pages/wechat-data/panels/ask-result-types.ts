/**
 * Runtime result shapes shared by the ask hook and its renderers.
 *
 * These are wire/read-side contracts rather than hook state. Keeping them out
 * of use-ask.ts makes the hook's orchestration boundaries easier to review and
 * lets presentation modules depend on data shapes without importing the hook.
 */
import type { AskStage } from './ask-stage-merge.ts'
import type { AskReasoningSegment } from './answer-run-trace.ts'
import type { AskRunMetrics } from './ask-run-model.ts'
import type { ThreadState } from '@deepseek-ai/dsh-wechat-data/types'

export type AnswerStatus = 'ok' | 'insufficient' | 'needs_clarification' | 'degraded' | 'blocked' | 'failed'

export interface ToolCallTrace {
  index: number
  round: number
  callId: string
  name: string
  argumentsSummary: string
  ok: boolean
  deduplicated: boolean
  attempts: number
  retries: number
  elapsedMs: number
  errorClass?: string
  errorCode?: string
  /** 后端脱敏后的错误正文；可能比 errorClass/errorCode 更适合直接解释原因。 */
  errorMessage?: string
  hits: number
  facts: number
  deadlineExceeded?: boolean
  skipped?: boolean
  note?: string
  /** 脱敏后的结果摘要；旧后端缺省。 */
  resultSummary?: string
  /** 脱敏、截断后的结构化结果快照；旧后端缺省。 */
  resultDetail?: string
  /** 结果详情是否因条数或长度限制被截断。 */
  resultTruncated?: boolean
}

export type EvidenceSource = 'msg' | 'kb' | 'agg' | 'resource'

export type EvidenceLocator =
  | { type: 'message'; username: string; localId: number; key: string }
  | {
    type: 'kb'
    kbId: number
    fileId: number
    chunkId: number
    key: string
    fileName: string
    fileExt: string
    ordinal: number
    page: number
    heading: string
  }
  | { type: 'fact'; tool: string; index?: number; title?: string; bodyDigest?: string; key?: string }
  | {
    type: 'resource'
    tool: string
    key: string
    stableKey?: string
    resourceKind?: 'file' | 'favorite' | 'moment' | 'record'
    time?: string
    session?: string
    sourceId?: string
    fileName?: string
    size?: number
    category?: string
    md5?: string
    thumbMd5?: string
    fullMd5?: string
    favoriteId?: number
    serverId?: string
    transferId?: string
    messageServerId?: string
    timelineId?: string
    username?: string
    mediaId?: string
    mediaKind?: string
    url?: string
    token?: string
    seed?: string
    recordType?: 'transfers' | 'redpackets'
  }

export interface EvidenceItem {
  evidenceId: string
  kind: 'hit' | 'fact'
  tool: string
  tools: string[]
  source: EvidenceSource
  name: string
  /** 会话 / 来源所属企业；企业微信会话才有。 */
  enterpriseName?: string
  time: string
  sender?: string
  /** 群消息发送者所属企业；单聊发送者使用会话企业名。 */
  senderEnterpriseName?: string
  snippet: string
  score?: number
  key: string
  locator: EvidenceLocator
  truncated?: boolean
  fact?: boolean
}

export interface EvidenceBundleStats {
  count: number
  messages: number
  kb: number
  sessions: number
  candidateCount: number
  total: number
  hitCount: number
  factCount: number
  duplicateCount: number
  droppedByBudget: number
  truncated: boolean
  snippetChars: number
  /** 旧后端不返回 resource 计数，因此除三类既有来源外保持可选。 */
  sourceCounts: Record<'msg' | 'kb' | 'agg', number> & { resource?: number }
  toolCounts: Record<string, number>
  failedTools: string[]
  attemptedTools: number
  successfulTools: number
  malformedResults?: number
  malformedHits?: number
  malformedFacts?: number
  normalizationWarnings?: string[]
}

export interface EvidenceBundle {
  items: EvidenceItem[]
  facts: Array<{ title: string; body: string }>
  status: AnswerStatus
  missing: string[]
  stats: EvidenceBundleStats
  assessment: {
    status: 'missing' | 'insufficient' | 'sufficient'
    sufficient: boolean
    usableItems: number
    reason: string
  }
}

export interface AnswerRuntimeResourceCitation {
  evidenceId: string
  tool: string
  key: string
  name: string
  time: string
  snippet: string
  locator: EvidenceLocator
}

/** 可序列化的多轮线程状态；直接复用后端生成的宿主契约，避免前后端枚举漂移。 */
export type AskThreadState = ThreadState

export interface AskGrounding {
  checked: number
  unsupported: string[]
  cited: number
  repaired: boolean
}

/** 统一运行时附加到 `AskResult` 上的读侧字段。 */
export interface AskResultRuntimeFields {
  status?: AnswerStatus
  statusReason?: string
  synthesisError?: string
  toolCalls?: ToolCallTrace[]
  evidence?: EvidenceBundle
  resources?: AnswerRuntimeResourceCitation[]
  threadState?: AskThreadState
  grounding?: AskGrounding
  /** 后端聚合的端到端耗时；旧后端缺省。 */
  durationMs?: number
  /** 后端收集的本轮阶段快照；旧后端缺省时沿用流式快照。 */
  stages?: AskStage[]
  /** 后端收集的分段思考；旧后端缺省时沿用流式分段。 */
  reasoningSegments?: AskReasoningSegment[]
}

/** Timing data attached to a completed, stopped, or failed turn. */
export type AskTurnMetrics = AskRunMetrics
