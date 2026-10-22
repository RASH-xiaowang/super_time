/**
 * 问答线程 hook —— 「微信问答」页签与「群聊内 AI 对话」共用同一套问答/流式链路。
 *
 * 抽出来的理由：这段逻辑（流式 id 防串台、历史裁剪、多轮拼装、引用归属）在
 * Ask.tsx 里已有约 80 行且踩过坑（迟到的增量会串进新一轮），再复制一份必然走样。
 *
 * 线程按 `threadKey` 隔离：群聊内 AI 用会话 username 做键，于是每个会话各留一份
 * 上下文；「微信问答」页签用默认键，行为与重构前完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { apiAskWechat, apiCancelAsk, remote } from '../api.ts'
import { createAskGate, type AskGate } from './ask-gate.ts'
import { getActiveKbId } from './kb-scope.ts'
import { appendAskStage, type AskStage } from './ask-stage-merge.ts'
import type { AskResult, ThreadState } from '@deepseek-ai/dsh-wechat-data/types'

export type { AskStage } from './ask-stage-merge.ts'

/**
 * 统一问答运行时的新增结果字段。
 *
 * 本文件的类型入口来自 `build:types` 生成的宿主声明。统一运行时已经返回这些
 * 字段，但生成声明可能落后一个构建周期；这里只做**读侧**的兼容声明，请求与
 * 映射仍走同一份运行时契约，避免前端为了显示过程信息去修改生成物。
 */
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
  hits: number
  facts: number
  deadlineExceeded?: boolean
  skipped?: boolean
  note?: string
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
  time: string
  sender?: string
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
interface AskResultRuntimeFields {
  status?: AnswerStatus
  statusReason?: string
  synthesisError?: string
  toolCalls?: ToolCallTrace[]
  evidence?: EvidenceBundle
  resources?: AnswerRuntimeResourceCitation[]
  threadState?: AskThreadState
  grounding?: AskGrounding
}

/** 一轮对话（用户提问或助手回答）。 */
export interface AskTurn {
  role: 'user' | 'assistant'
  text: string
  citations?: AskResult['citations']
  plan?: AskResult['plan']
  /** 回答正文里真正引用到的来源序号（1 基）。 */
  citedIndexes?: number[]
  /** 数据来源说明（条数/会话数/时间跨度），由后端按检索结果算出，非模型生成。 */
  basis?: string
  /** 本轮没检索到任何原文（未调模型）。 */
  insufficient?: boolean
  /** 模型内容无法对应到任何原文，已不予采用。 */
  withheld?: boolean
  /** 多阶段检索统计（意图 / 通道 / 漏斗 / 耗时）。 */
  retrieval?: AskResult['retrieval']
  /** 本轮检索追踪 id：反馈时回传给后端做特征归因。 */
  retrievalId?: string
  /** 本轮运行时的最终状态（工具、证据、综合生成各阶段收敛后）。 */
  status?: AnswerStatus
  /** 状态的可读原因；优先展示综合失败原因，其次为空证据/阻断原因。 */
  statusReason?: string
  /** 综合生成失败时的原始错误（证据仍保留并降级返回）。 */
  synthesisError?: string
  /** 本轮真实执行过的工具调用（脱敏参数摘要，不含正文）。 */
  toolCalls?: ToolCallTrace[]
  /** 收敛、去重、预算截断后的证据包。 */
  evidence?: EvidenceBundle
  /** 文件/收藏/朋友圈等独立资源，不能伪造成消息引用。 */
  resources?: AnswerRuntimeResourceCitation[]
  /** 本轮结束后的线程状态：下一轮请求要原样回传以继承指代与时间窗。 */
  threadState?: AskThreadState
  /**
   * 该轮实际使用的检索范围签名（仅前端内部使用）。
   *
   * 线程状态只在**同一范围**的紧邻轮次之间继承；用户切换会话/时间/知识库
   * 范围后，旧 `threadState` 会把上一范围的时间窗、联系人或引用消息带进
   * 新一轮，因此必须用这个签名做隔离。
   */
  scopeSignature?: string
  /** 接地核对结果（确定性复核）。 */
  grounding?: AskGrounding
  /** 反馈结果（undefined = 未反馈）。 */
  feedback?: 'up' | 'down'
  /** 用户逐条标注：引用序号（1 基）→ 有用 / 没用。 */
  marks?: Record<number, 'useful' | 'useless'>
  /** 这一轮被用户主动停止（不是错误，也不该显示成错误）。 */
  stopped?: boolean
  /** 本轮失败时的稳定错误码（用于重试建议与排查）。 */
  errorCode?: string
  /**
   * 模型的**思考过程**（2026-10-16 新增）。
   *
   * 与 `text`（可见正文）分开存：界面上要能**只收起思考**、只复制正文。
   * 只在模型真的产出 reasoning 时才有值（多数非推理模型没有）。
   */
  reasoning?: string
  /**
   * 流水线各阶段的执行记录（2026-10-16 新增）。
   *
   * 这是「工具调用过程」的数据源：规划 → 检索 → 精排 → 生成 → 核对，
   * 每步有状态（running/done/skipped）与结果摘要。生成中实时更新，完成后定格。
   */
  stages?: AskStage[]
}

/** hook 选项。 */
export interface UseAskSessionOptions {
  /** 检索范围：限定到某个会话（群聊/单聊内问答）。 */
  scopeUsername?: string
  /** 时间范围（可选）。 */
  from?: string
  to?: string
  /** 线程键：变化即切到另一份独立对话（默认 'default'）。 */
  threadKey?: string
  /**
   * 写进「问答历史」的入口来源：'ask'（微信问答页签）/ 'session'（会话内问答）。
   * 缺省由后端按 'ask' 处理 —— 这里传是为了让历史列表能区分「在哪问的」。
   */
  source?: string
  /** 会话显示名：写进历史记录，列表可直接显示（不必再查会话表）。 */
  scopeUsernameName?: string
  /**
   * 是否把**当前知识库**的文件块一并检索（缺省 false）。
   *
   * 只有「微信问答」页签打开它：会话内问答（`SessionAsk`）的范围是那一场聊天，
   * 往里掺文件会让「这个群里谁说过」答成文件里的内容。
   *
   * 开启时把当前库 id 一并传进来：库切换必须进入线程签名，否则切换前的问题、
   * 旧 threadState 和正在返回的请求都会落在新库的线程里。未传时仍回退到
   * `getActiveKbId()`，兼容旧调用方。
   */
  useKb?: boolean
  /** 当前知识库 id（`useKb` 为 true 时参与线程隔离）。 */
  kbId?: number
}

/** hook 返回值。 */
export interface UseAskSessionResult {
  turns: AskTurn[]
  asking: boolean
  /** 生成中的**全文**（后端按 80ms 节流推送，渲染端整体替换）。 */
  streamText: string
  /** 生成中的**思考全文**（2026-10-16；与 streamText 分开的一条流）。 */
  streamReasoning: string
  /** 生成中的**阶段列表**（2026-10-16；「工具调用过程」的实时数据源）。 */
  streamStages: AskStage[]
  error: string | null
  ask: (question: string) => Promise<void>
  /** 停止当前这一轮的生成（W3-6.1）。幂等，没有在跑的轮次时点它也只是空取消。 */
  cancel: () => void
  /**
   * 重试最近一轮失败回答。复用原提问与失败轮次之前的同范围 threadState，
   * 不要求用户重新输入；失败轮次本身会被新一次生成替换。
   */
  retry: (turnIndex: number) => Promise<void>
  /** 清空当前线程。 */
  reset: () => void
  /** 作废当前范围的在飞提问并清空线程；用于「清空对话 / 新对话」。 */
  resetAndCancel: () => void
  /** 就地更新某一轮（标注引用 / 记录已反馈）。 */
  patchTurn: (index: number, patch: Partial<AskTurn>) => void
  clearError: () => void
}

/**
 * 检索范围签名：用于隔离 threadState 与流式缓冲。
 * @param options - 影响检索范围的稳定字段。
 * @returns 可直接比较的签名。
 */
function scopeSignatureOf(
  options: Pick<UseAskSessionOptions, 'scopeUsername' | 'from' | 'to' | 'source' | 'useKb' | 'kbId'>,
): string {
  return JSON.stringify({
    username: options.scopeUsername ?? '',
    from: options.from ?? '',
    to: options.to ?? '',
    source: options.source ?? '',
    useKb: options.useKb === true,
    kbId: options.useKb === true ? options.kbId ?? 0 : 0,
  })
}

/**
 * 只从紧邻的、同范围且正常完成的助手轮次继承结构化线程状态。
 * @param prevTurns - 当前线程已有的轮次。
 * @param signature - 本轮检索范围签名。
 * @param previousFailed - 上一轮是否在同一范围失败（失败不追加助手轮次）。
 * @returns 可回传的 threadState；不应继承时为 undefined。
 */
function inheritedThreadState(
  prevTurns: readonly AskTurn[],
  signature: string,
  previousFailed: boolean,
): AskThreadState | undefined {
  const previous = prevTurns[prevTurns.length - 1]
  if (previousFailed || previous?.role !== 'assistant') return undefined
  if (previous.stopped === true || previous.status === 'failed' || previous.status === 'blocked') return undefined
  return previous.scopeSignature === signature ? previous.threadState : undefined
}

/**
 * 把运行时结果映射成助手轮次。
 * @param r - 后端答案。
 * @param runtime - 统一运行时附加字段。
 * @param scopeSignature - 发起请求时的范围签名。
 * @param streamedReasoning - 流式思考兜底文本。
 * @param streamedStages - 流式阶段快照。
 * @returns 可直接追加到线程的助手轮次。
 */
function assistantTurnFromResult(
  r: AskResult,
  runtime: AskResult & AskResultRuntimeFields,
  scopeSignature: string,
  streamedReasoning: string,
  streamedStages: AskStage[],
): AskTurn {
  const reasoning = r.reasoning ?? streamedReasoning
  return {
    role: 'assistant',
    text: r.answer,
    citations: r.citations,
    plan: r.plan,
    citedIndexes: r.citedIndexes,
    basis: r.basis,
    insufficient: r.insufficient,
    withheld: r.withheld,
    retrieval: r.retrieval,
    retrievalId: r.retrievalId,
    ...(runtime.status !== undefined ? { status: runtime.status } : {}),
    ...(runtime.statusReason !== undefined ? { statusReason: runtime.statusReason } : {}),
    ...(runtime.synthesisError !== undefined ? { synthesisError: runtime.synthesisError } : {}),
    ...(runtime.toolCalls !== undefined ? { toolCalls: runtime.toolCalls } : {}),
    ...(runtime.evidence !== undefined ? { evidence: runtime.evidence } : {}),
    ...(runtime.resources !== undefined ? { resources: runtime.resources } : {}),
    ...(runtime.threadState !== undefined ? { threadState: runtime.threadState } : {}),
    scopeSignature,
    ...(runtime.grounding !== undefined ? { grounding: runtime.grounding } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(streamedStages.length > 0 ? { stages: streamedStages } : {}),
  }
}

/**
 * 订阅回答 / 思考 / 阶段三条流式事件，并统一按当前轮次 id 过滤。
 * @param streamIdRef - 当前轮次 id（迟到事件的过滤器）。
 * @param setStreamText - 回答全文写入器。
 * @param setStreamReasoning - 思考全文写入器。
 * @param setStreamStages - 阶段快照写入器。
 */
function useAskStreamFeed(
  streamIdRef: MutableRefObject<string>,
  setStreamText: Dispatch<SetStateAction<string>>,
  setStreamReasoning: Dispatch<SetStateAction<string>>,
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>,
): void {
  useEffect(() => {
    const onDelta = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text === 'string') setStreamText(d.text)
    }
    window.addEventListener('dsh-wechat-ask-delta', onDelta)
    return () => { window.removeEventListener('dsh-wechat-ask-delta', onDelta) }
  }, [setStreamText, streamIdRef])

  useEffect(() => {
    const onReasoning = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text === 'string') setStreamReasoning(d.text)
    }
    window.addEventListener('dsh-wechat-ask-reasoning', onReasoning)
    return () => { window.removeEventListener('dsh-wechat-ask-reasoning', onReasoning) }
  }, [setStreamReasoning, streamIdRef])

  useEffect(() => {
    const onStage = (e: Event): void => {
      const d = (e as CustomEvent).detail as ({ id?: string } & Record<string, unknown>) | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      setStreamStages(prev => appendAskStage(prev, d))
    }
    window.addEventListener('dsh-wechat-ask-stage', onStage)
    return () => { window.removeEventListener('dsh-wechat-ask-stage', onStage) }
  }, [setStreamStages, streamIdRef])
}

/**
 * 本地立即结束当前轮：作废 ticket，保留已收到的正文与阶段。
 *
 * 不能只调远端取消 —— 远端的 `ASK_CANCELED` 可能几百毫秒后才到，期间界面仍显示
 * 「生成中」，用户看不到停止生效；而一旦作废 streamId，迟到的增量与结果都会被丢弃。
 * @returns 被结束的 ticket（没有在飞轮次时为 undefined）。
 */
function finishLocalStream(input: {
  gate: AskGate | null
  streamIdRef: MutableRefObject<string>
  streamOwnerRef: MutableRefObject<string>
  setError: Dispatch<SetStateAction<string | null>>
  setStreamText: Dispatch<SetStateAction<string>>
  setStreamReasoning: Dispatch<SetStateAction<string>>
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>
  setAsking: Dispatch<SetStateAction<boolean>>
}): string | undefined {
  const id = input.streamIdRef.current
  if (id === '') return undefined
  input.gate?.finish(id)
  input.streamIdRef.current = ''
  input.streamOwnerRef.current = ''
  input.setStreamText('')
  input.setStreamReasoning('')
  input.setStreamStages([])
  input.setAsking(false)
  input.setError(null)
  return id
}

/** 用户停止时写入线程的助手轮次：保留已生成部分与过程信息。 */
function stoppedTurn(input: {
  text: string
  reasoning: string
  stages: AskStage[]
  scopeSignature: string
}): AskTurn {
  const text = input.text.trim()
  return {
    role: 'assistant',
    text: text === '' ? '（已停止生成）' : `${input.text}\n\n（已停止生成）`,
    stopped: true,
    scopeSignature: input.scopeSignature,
    ...(input.reasoning.trim() !== '' ? { reasoning: input.reasoning } : {}),
    ...(input.stages.length > 0 ? { stages: input.stages } : {}),
  }
}

/** 失败轮次保留原问题、错误码与部分内容，供用户一键重试。 */
function failedTurn(input: {
  text: string
  reasoning: string
  stages: AskStage[]
  scopeSignature: string
  code: string
  message: string
}): AskTurn {
  return {
    role: 'assistant',
    text: input.text,
    status: 'failed',
    statusReason: input.message,
    errorCode: input.code,
    scopeSignature: input.scopeSignature,
    ...(input.reasoning.trim() !== '' ? { reasoning: input.reasoning } : {}),
    ...(input.stages.length > 0 ? { stages: input.stages } : {}),
  }
}

/**
 * 切范围时释放旧轮次。
 *
 * 旧请求不能继续占着单飞闸，否则界面已经显示新范围的空线程，用户再次提问
 * 却会被同步闸门静默忽略。旧线程补一条停止标记，切回来时能区分“没发出”与
 * “被范围切换取消”。
 */
function useAskRangeSwitch(input: {
  activeKey: string
  keyRef: MutableRefObject<string>
  gateRef: MutableRefObject<AskGate | null>
  streamIdRef: MutableRefObject<string>
  streamOwnerRef: MutableRefObject<string>
  setError: Dispatch<SetStateAction<string | null>>
  setStreamText: Dispatch<SetStateAction<string>>
  setStreamReasoning: Dispatch<SetStateAction<string>>
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>
  setAsking: Dispatch<SetStateAction<boolean>>
  setTurnList: (key: string, updater: (prev: AskTurn[]) => AskTurn[]) => void
}): void {
  const {
    activeKey, keyRef, gateRef, streamIdRef, streamOwnerRef,
    setError, setStreamText, setStreamReasoning, setStreamStages, setAsking, setTurnList,
  } = input
  useEffect(() => {
    if (keyRef.current === activeKey) return
    const oldKey = keyRef.current
    keyRef.current = activeKey
    setError(null)
    const id = streamIdRef.current
    if (!id) return
    if (gateRef.current?.finish(id)) {
      streamIdRef.current = ''
      streamOwnerRef.current = ''
      setStreamText('')
      setStreamReasoning('')
      setStreamStages([])
      setAsking(false)
    }
    const pendingCancel = apiCancelAsk({ jobId: id })
    setTurnList(oldKey, (prev) => {
      const last = prev[prev.length - 1]
      if (last?.role !== 'user') return prev
      return [...prev, {
        role: 'assistant',
        text: '（已停止生成）',
        stopped: true,
      }]
    })
    void pendingCancel.catch(() => { /* 旧轮次已释放，取消失败不影响新范围 */ })
    // 线程里已经落下「已停止生成」；错误槽保持为空，避免把正常停止显示成失败。
    setError(null)
  }, [activeKey, gateRef, keyRef, setAsking, setError, setStreamReasoning, setStreamStages, setStreamText, setTurnList, streamIdRef, streamOwnerRef])
}

interface AskSessionEnvironment {
  key: string
  currentStreamOwner: string
  threads: Record<string, AskTurn[]>
  asking: boolean
  setAsking: Dispatch<SetStateAction<boolean>>
  streamText: string
  setStreamText: Dispatch<SetStateAction<string>>
  streamReasoning: string
  setStreamReasoning: Dispatch<SetStateAction<string>>
  streamStages: AskStage[]
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>
  error: string | null
  setError: Dispatch<SetStateAction<string | null>>
  streamIdRef: MutableRefObject<string>
  streamOwnerRef: MutableRefObject<string>
  failedScopeRef: MutableRefObject<Record<string, string>>
  streamReasoningRef: MutableRefObject<string>
  streamStagesRef: MutableRefObject<AskStage[]>
  streamTextRef: MutableRefObject<string>
  gateRef: MutableRefObject<AskGate | null>
  activeTurnRef: MutableRefObject<{ key: string, scopeSignature: string }>
  threadsRef: MutableRefObject<Record<string, AskTurn[]>>
  scopeRef: MutableRefObject<Pick<UseAskSessionOptions, 'scopeUsername' | 'from' | 'to' | 'source' | 'scopeUsernameName' | 'useKb' | 'kbId'>>
  keyRef: MutableRefObject<string>
  setTurnList: (key: string, updater: (prev: AskTurn[]) => AskTurn[]) => void
}

/** useAskSession 的状态与 ref 环境；拆出后主 hook 只保留编排。 */
function useAskSessionEnvironment(options: UseAskSessionOptions): AskSessionEnvironment {
  const { scopeUsername, from, to, source, scopeUsernameName, useKb, kbId } = options
  const currentScopeSignature = scopeSignatureOf({ scopeUsername, from, to, source, useKb, kbId })
  const key = `${options.threadKey ?? 'default'}\u0000${currentScopeSignature}`
  const [threads, setThreads] = useState<Record<string, AskTurn[]>>({})
  const [asking, setAsking] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamReasoning, setStreamReasoning] = useState('')
  const [streamStages, setStreamStages] = useState<AskStage[]>([])
  const [error, setError] = useState<string | null>(null)
  const streamIdRef = useRef('')
  const streamOwnerRef = useRef('')
  const failedScopeRef = useRef<Record<string, string>>({})
  const streamReasoningRef = useRef('')
  streamReasoningRef.current = streamReasoning
  const streamStagesRef = useRef<AskStage[]>([])
  streamStagesRef.current = streamStages
  const streamTextRef = useRef('')
  streamTextRef.current = streamText
  const gateRef = useRef<AskGate | null>(null)
  const activeTurnRef = useRef({ key: '', scopeSignature: '' })
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const scopeRef = useRef({ scopeUsername, from, to, source, scopeUsernameName, useKb, kbId })
  scopeRef.current = { scopeUsername, from, to, source, scopeUsernameName, useKb, kbId }
  const keyRef = useRef(key)
  const setTurnList = useCallback((k: string, updater: (prev: AskTurn[]) => AskTurn[]): void => {
    setThreads((current) => {
      const rows = current[k] ?? []
      const next = updater(rows)
      return next === rows ? current : { ...current, [k]: next }
    })
  }, [])
  return {
    key, currentStreamOwner: key, threads, asking, setAsking,
    streamText, setStreamText, streamReasoning, setStreamReasoning,
    streamStages, setStreamStages, error, setError,
    streamIdRef, streamOwnerRef, failedScopeRef, streamReasoningRef, streamStagesRef,
    streamTextRef, gateRef, activeTurnRef, threadsRef, scopeRef, keyRef, setTurnList,
  }
}

/**
 * 会话级问答线程。
 * @param options - 检索范围与线程键。
 * @returns 线程状态与操作。
 */
export function useAskSession(options: UseAskSessionOptions = {}): UseAskSessionResult {
  const {
    key, currentStreamOwner, threads, asking, setAsking,
    streamText, setStreamText, streamReasoning, setStreamReasoning,
    streamStages, setStreamStages, error, setError,
    streamIdRef, streamOwnerRef, failedScopeRef, streamReasoningRef, streamStagesRef,
    streamTextRef, gateRef, activeTurnRef, threadsRef, scopeRef, keyRef, setTurnList,
  } = useAskSessionEnvironment(options)

  useAskRangeSwitch({
    activeKey: key,
    keyRef,
    gateRef,
    streamIdRef,
    streamOwnerRef,
    setError,
    setStreamText,
    setStreamReasoning,
    setStreamStages,
    setAsking,
    setTurnList,
  })

  // 回答 / 思考 / 阶段三条流式事件统一订阅；每一路都按当前轮次 id 防串台。
  useAskStreamFeed(streamIdRef, setStreamText, setStreamReasoning, setStreamStages)

  /**
   * 发起一轮问答。
   * @param question - 用户问题。
   * @param replaceAt - 重试时从该用户轮次开始替换；缺省 = 追加到线程末尾。
   */
  const runAsk = useCallback(async (question: string, replaceAt?: number): Promise<void> => {
    const q = question.trim()
    if (!q) return
    // 单飞闸放在 ref 里（M13）：原来用闭包里的 `asking` 当闸门，而 React 的状态更新是
    // 异步的 —— 快速连点第二次时组件可能还没重渲染，`asking` 仍是 false，两次调用双双通过；
    // 而先返回的那轮会在 finally 里无条件 setAsking(false)，把仍在生成的那轮标记成已结束。
    const gate = gateRef.current ?? (gateRef.current = createAskGate())
    // 每轮一个流式标识：后端只推这个 id 的增量，上一轮的迟到事件不会被采纳。
    const streamId = gate.tryStart()
    if (!streamId) return
    const k = key
    setAsking(true)
    setError(null)
    setStreamText('')
    setStreamReasoning('')
    setStreamStages([])
    streamIdRef.current = streamId
    const requestScope = scopeRef.current
    const requestScopeSignature = scopeSignatureOf(requestScope)
    streamOwnerRef.current = k
    const rawPrevTurns = threadsRef.current[k] ?? []
    // 重试从原提问那一轮开始替换（失败回答与它的提问一起重来），其余历史保持原样。
    const prevTurns = replaceAt === undefined ? rawPrevTurns : rawPrevTurns.slice(0, Math.max(replaceAt, 0))
    const history = prevTurns.map(t => ({ role: t.role, content: t.text }))
    /**
     * 结构化线程状态只跟着**紧邻当前用户轮次之前**的那条助手回答走。
     *
     * `history` 只带自然语言，模型无法可靠继承「上一轮看的是哪个群 / 哪段时间」；
     * `threadState` 是后端算好的稳定字段，下一轮原样回传才能续上指代与时间窗。
     * 不向更早轮次回溯：失败、取消或本轮没有产出 threadState 时，宁可让后端
     * 重新按当前问题判断，也不要把更早一轮的范围悄悄带进来。
     */
    const previousFailed = failedScopeRef.current[k] === requestScopeSignature
    const threadState = inheritedThreadState(prevTurns, requestScopeSignature, previousFailed)
    if (previousFailed) delete failedScopeRef.current[k]
    activeTurnRef.current = { key: k, scopeSignature: requestScopeSignature }
    setTurnList(k, () => [...prevTurns, { role: 'user', text: q }])
    try {
      const { scopeUsername: su, from: f, to: t2, source: src, scopeUsernameName: suName, useKb: withKb } = requestScope
      const kbId = withKb ? (requestScope.kbId ?? getActiveKbId()) : 0
      /*
       * 变量形式（而不是内联字面量）有两个原因：
       *   ① `threadState` 是新字段，生成类型可能还没跟上；变量传给函数时不会触发
       *      对未知属性的 excess-property 检查，同时运行期字段仍会原样进入 Remote；
       *   ② 这一轮所有可选作用域在一个对象里组装，后续新增字段不必再复制一遍分支。
       */
      const request = {
        question: q,
        streamId,
        // 取消标识与流式标识同源：一轮一个 id，两处都用它（W3-6.1）。
        jobId: streamId,
        ...(su ? { username: su } : {}),
        ...(f ? { from: f } : {}),
        ...(t2 ? { to: t2 } : {}),
        ...(src ? { source: src } : {}),
        ...(suName ? { usernameName: suName } : {}),
        ...(history.length > 0 ? { history } : {}),
        ...(threadState !== undefined ? { threadState } : {}),
        // 只在明确开启时带：不传 = 本次不检索知识库（不是「搜所有库」）
        ...(kbId > 0 ? { kbId } : {}),
      }
      const r = await apiAskWechat(request)
      // 切范围时旧轮次已被主动释放；即使后端迟到返回，也不能写进任何线程。
      if (!gate.isCurrent(streamId)) return
      const runtime = r as AskResult & AskResultRuntimeFields
      delete failedScopeRef.current[k]
      setTurnList(k, prev => [...prev, assistantTurnFromResult(
        r,
        runtime,
        requestScopeSignature,
        streamReasoningRef.current.trim(),
        streamStagesRef.current,
      )])
    } catch (e) {
      if (!gate.isCurrent(streamId)) return
      // W3-6.1：用户主动停止**不是错误**。把它显示成红色错误会让「停止生成」这个功能
      // 看起来像把问答弄坏了；这里是把它记成一次正常的收尾（stopped），
      // 与「模型没配上」那类真失败分开。
      const code = (e as { code?: string } | null)?.code
      if (code === 'ASK_CANCELED') {
        setError(null)
        const active = activeTurnRef.current
        if (active.key === k) {
          setTurnList(k, prev => [...prev, stoppedTurn({
            text: streamTextRef.current,
            reasoning: streamReasoningRef.current,
            stages: streamStagesRef.current,
            scopeSignature: requestScopeSignature,
          })])
        }
      } else {
        failedScopeRef.current[k] = requestScopeSignature
        const active = activeTurnRef.current
        const message = e instanceof Error ? e.message : String(e)
        const stableCode = typeof code === 'string' && code !== '' ? code : 'ASK_FAILED'
        if (active.key === k) {
          setTurnList(k, prev => [...prev, failedTurn({
            text: streamTextRef.current,
            reasoning: streamReasoningRef.current,
            stages: streamStagesRef.current,
            scopeSignature: requestScopeSignature,
            code: stableCode,
            message,
          })])
        }
        if (keyRef.current === k) setError(message)
      }
    } finally {
      // 只有「当前轮」才能释放闸门并清状态。**防御性不变量**：当前接线下这个 false 分支不可达
      // （复审穷举 5 轮共 1920 种交错，0 次出现），保留是因为它是 `finish` 返回 boolean 的意义所在、
      // 且将来若有第二个 finish 调用点就会真的用上。先作废流式标识再清缓冲，迟到增量不会再写进 state。
      if (gate.finish(streamId)) {
        activeTurnRef.current = { key: '', scopeSignature: '' }
        streamIdRef.current = ''
        streamOwnerRef.current = ''
        setStreamText('')
        setStreamReasoning('')
        setStreamStages([])
        setAsking(false)
      }
    }
  }, [key, setTurnList])

  const ask = useCallback((question: string): Promise<void> => runAsk(question), [runAsk])

  /** 失败轮次重试：以该轮前面的用户提问重新跑一次同范围请求。 */
  const retry = useCallback(async (turnIndex: number): Promise<void> => {
    const list = threadsRef.current[key] ?? []
    const failed = list[turnIndex]
    const asked = list[turnIndex - 1]
    if (failed?.role !== 'assistant' || failed.status !== 'failed') return
    if (asked?.role !== 'user' || asked.text.trim() === '') return
    await runAsk(asked.text, turnIndex - 1)
  }, [key, runAsk])

  const resetAndCancel = useCallback((): void => {
    const id = streamIdRef.current
    failedScopeRef.current[key] = scopeSignatureOf(scopeRef.current)
    if (id !== '') {
      /*
       * 先作废当前轮，再发取消：清空后迟到的回答不能追加到空线程上；
       * 同步释放闸门也保证用户能立刻开始下一问，而不是等旧请求自然结束。
       */
      gateRef.current?.finish(id)
      streamIdRef.current = ''
      streamOwnerRef.current = ''
      setStreamText('')
      setStreamReasoning('')
      setStreamStages([])
      setAsking(false)
      void apiCancelAsk({ jobId: id }).catch(() => { /* 旧轮次已作废，取消失败不阻断清空 */ })
    }
    setError(null)
    setTurnList(key, () => [])
  }, [key, setTurnList])

  const reset = useCallback((): void => { setTurnList(key, () => []) }, [key, setTurnList])

  /**
   * 停止当前这一轮的生成（W3-6.1）。
   *
   * 幂等且永远可点：闸门释放后再点也只是一次「找不到那一轮」的空取消（后端会如实说
   * 它已经结束了），不会抛错。没有在跑的轮次时按钮本就不该出现（由 asking 决定）。
   */
  const cancel = useCallback((): void => {
    const id = streamIdRef.current
    if (!id) return
    const active = activeTurnRef.current
    if (active.key === key) {
      setTurnList(key, prev => [...prev, stoppedTurn({
        text: streamTextRef.current,
        reasoning: streamReasoningRef.current,
        stages: streamStagesRef.current,
        scopeSignature: active.scopeSignature,
      })])
    }
    finishLocalStream({
      gate: gateRef.current,
      streamIdRef,
      streamOwnerRef,
      setError,
      setStreamText,
      setStreamReasoning,
      setStreamStages,
      setAsking,
    })
    void (async (): Promise<void> => {
      try {
        await apiCancelAsk({ jobId: id })
      } catch { /* 取消失败不抛给用户：这一轮自己会跑完，界面照常显示结果 */ }
    })()
  }, [key, setTurnList])

  const patchTurn = useCallback((index: number, patch: Partial<AskTurn>): void => {
    setTurnList(key, prev => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }, [key, setTurnList])

  const clearError = useCallback((): void => { setError(null) }, [])

  return {
    turns: threads[key] ?? [],
    asking: asking && streamOwnerRef.current === currentStreamOwner,
    streamText: streamOwnerRef.current === currentStreamOwner ? streamText : '',
    streamReasoning: streamOwnerRef.current === currentStreamOwner ? streamReasoning : '',
    streamStages: streamOwnerRef.current === currentStreamOwner ? streamStages : [],
    error,
    ask,
    retry,
    cancel,
    reset,
    resetAndCancel,
    patchTurn,
    clearError,
  }
}
