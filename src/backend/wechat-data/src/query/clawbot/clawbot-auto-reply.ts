/**
 * 微信 ClawBot 的 **AI 自动回复**（2026-10-13，多实例）。
 *
 * ## 它回答的问题
 *
 * 「收到微信消息时，要不要自动回一条、回什么」。三件事在这里定死：
 *   · **回不回** —— 开关（`autoReply`，默认关）**且**有有效知识库时才回；
 *   · **带哪个知识库** —— `kbEnabled && kbId > 0`，没有「所有库」或「无库纯聊天」模式；
 *   · **谁来答** —— 走注入的 `ask` 能力，也就是与「微信问答」**同一条 ask 管道**
 *     （模型统一由设置里的「对话模型」决定、同过隐私闸与审计）。
 *     本模块**不碰模型、不碰网络**：它只做「决策 + 编排」；正文出网与消息落库
 *     发生在注入进来的 `send` 里，持久化 run/outbox 通过 `reply-store` 管理。
 *
 * ## 三条容易被忽略的边界（都写成了守卫）
 *
 * ① **无人值守出网**：这是本仓第一处「不是你点一下才发生」的模型调用。因此默认关、
 *    开关就在实例卡上（用户看得见），且每次回复都写一行审计（`clawbot_auto_reply`）。
 * ② **一批只回一条**：服务端不给我们消息时间（`WeixinMessage` 没有时间戳字段），
 *    所以「刚绑定就拉到一堆历史」无法按时间过滤 —— 上界只能靠「每批最多回最后一条」
 *    压到 1 条。这条边界同时写进了 PRIVACY 的 G2。
 * ③ **错误不许抛**：调用方是常驻长轮询循环，自动回复失败若抛出去会把收消息一起弄挂。
 *    这里所有失败路径都记账返回，一条都不外抛。
 *
 * @module query/clawbot/clawbot-auto-reply
 */
import { randomUUID } from 'node:crypto'
import type {
  ClawbotAutoReplyStage,
  ClawbotAutoReplyStats,
  ClawbotInstanceConfig,
  ClawbotReplyAskResult,
  ClawbotReplyRunDetail,
  ClawbotSendResult,
  OperationCategory,
  OperationStatus,
} from '../../types.ts'
import { splitReplyText } from './clawbot-prompt.ts'
import { AUTO_REPLY_KB_REQUIRED_MESSAGE, hasValidAutoReplyKnowledgeBase } from './clawbot-config-invariant.ts'
import { mergeReplyRunDetail, replyRunDetailJson } from './clawbot-db.ts'
import {
  DEFAULT_REPLY_DEBOUNCE_MS,
  MAX_REPLY_RECOVERABLE_LIMIT,
  REPLY_GENERATING_LEASE_MS,
  REPLY_SENDING_LEASE_MS,
  claimReplyPartSending,
  claimReplyRunGeneration,
  enqueueOrMergeReplyRun,
  failReplyPartAndRunClaimed,
  listRecoverableReplyRunsAfterId,
  markReplyPartRetryClaimed,
  markReplyPartSentClaimed,
  markReplyRunDoneClaimed,
  markReplyRunDoneIfIdle,
  markReplyRunFailedClaimed,
  markReplyRunFailedIfIdle,
  markReplyRunRetryClaimed,
  markReplyRunSkippedClaimed,
  markReplyRunSkippedIfIdle,
  readReplyRun,
  renewReplyPartSendingClaim,
  renewReplyRunGenerationClaim,
  saveReplyPartsClaimed,
} from './clawbot-reply-store.ts'
import type {
  ClawbotReplyGenerationClaim,
  ClawbotReplyPart,
  ClawbotReplyRun,
  ClawbotReplyRunSnapshot,
  ClawbotReplySendClaim,
} from './clawbot-reply-store.ts'

/**
 * 自动回复正文的**总长**上限（超出截断并注明）。
 *
 * 取 **300**（2026-10-17 用户要求「每次回复不能超过 30 字」）：单条上限 30 字，
 * 300 字 = 最多 10 条 —— 再多就不是「回一条消息」而是「刷屏」了。
 * 模型可以输出很长，微信会话不该被一条回复刷屏。
 */
export const MAX_REPLY_CHARS = 300

/** 每实例的待回复上限（超出丢弃并记账）：一批几百条消息不该把模型调用打爆。 */
export const MAX_PENDING = 5

const RECOVERY_PAGE_SIZE = 500
const MAX_RECOVERY_SCAN_PER_ROUND = 10_000
const MAX_RECOVERY_SCHEDULES_PER_ROUND = 5_000
const RECOVERY_ERROR_RETRY_MS = 5_000
/** 恢复扫描的协作式时间片；单项同步 SQLite 调用不可抢占，但整页不应独占事件循环。 */
const RECOVERY_MAX_SLICE_MS = 20

function positiveLimit(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.max(Math.floor(value as number), 1) : fallback
}

/** 后台恢复默认周期；durable runner 用 unref timer 定期吸收分页上限之后的积压。 */
export const DEFAULT_RECOVERY_INTERVAL_MS = 60_000
/** 一轮恢复撞到安全预算后，短延迟续跑而不是干等下一个完整周期。 */
export const DEFAULT_RECOVERY_CONTINUATION_MS = 100

export type AutoReplyRunnerStage = ClawbotAutoReplyStage

/** runner 的稳定可观测快照；类型与 Remote 契约共用。 */
export type AutoReplyRunnerStats = ClawbotAutoReplyStats

/**
 * 一条对话上下文消息（自动回复把最近几轮一起送进 ask 管道）。
 *
 * 为什么要带上下文（2026-10-18 用户报「不能关联上下文」）：只把最后一条文本当问题，
 * 模型会把「分析一下图中右边那辆车」当成一句孤立的话，于是回「我这边没看到图呀」。
 * 上下文里保留 `[图片]` / `[语音]` 占位，模型至少知道对方发过什么。
 */
export interface ClawbotHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 一张随消息送进模型的图片（canonical base64 + MIME）。
 *
 * 图片由调用方从 ClawBot 媒体缓存读出；是否真的能送给模型由 ask 管道按模型能力决定，
 * 本模块不判断（也不联网）。
 */
export interface ClawbotImageInput {
  data: string
  mediaType: string
  name?: string
}

/** 自动回复附带的上下文（最近对话 + 最近图片）。 */
export interface ClawbotAskContext {
  history?: ClawbotHistoryMessage[]
  images?: ClawbotImageInput[]
}

/**
 * 自动回复用的 ask 能力（由装配层注入）。
 *
 * 形状刻意保持很窄（一个问题 + 可选知识库 + 可选系统提示词 + 可选上下文 ⇒ 一段答案）：
 * 调用方不许知道模型是谁、也不许自己拼提示词 —— 那些都在 ask 管道里，
 * 与手动问答共用一份实现。
 * @param slot - 实例编号。
 * @param text - 入站消息正文（作为问题）。
 * @param kbId - 非 null 时把该知识库纳入检索（知识库增强回复）。
 * @param systemPrompt - 该实例的系统提示词（空串 = 用内置拟人化默认值）。
 * @param context - 最近对话与图片（2026-10-18 起；旧注入方可忽略）。
 */
export type ClawbotAskFn = (
  slot: number,
  text: string,
  kbId: number | null,
  systemPrompt: string,
  context?: ClawbotAskContext,
) => Promise<ClawbotReplyAskResult>

/** 决策结果（`should` 为假时 `reason` 说明为什么，供审计与用例断言）。 */
export interface AutoReplyDecision {
  should: boolean
  reason: string
  /** 要带进 ask 的知识库；null = 不检索（**不是**「所有库」）。 */
  kbId: number | null
}

/**
 * 该实例现在该不该自动回复。
 *
 * 仍不看消息内容 —— 是否回复由用户开关决定；但 `clawbot-auto` 是 kb-only + requireKb，
 * 所以开关打开后还必须存在有效知识库（`kbEnabled && kbId > 0`）才允许运行。
 * @param cfg - 该实例的行为配置（每次现读，用户改完立即生效）。
 * @returns 决策（含实际要用的 kbId）。
 */
export function decideAutoReply(cfg: ClawbotInstanceConfig): AutoReplyDecision {
  if (!cfg.autoReply) return { should: false, reason: '实例未开启自动回复', kbId: null }
  if (!hasValidAutoReplyKnowledgeBase(cfg)) {
    return { should: false, reason: AUTO_REPLY_KB_REQUIRED_MESSAGE, kbId: null }
  }
  return { should: true, reason: '自动回复 + 知识库增强', kbId: cfg.kbId }
}

/** 一条候选消息里，本模块关心的那几列。 */
export interface ReplyableMessage {
  direction: 'in' | 'out'
  msgType: string | null
  content: string
  /** 落库行 id（用于从库里取「这条之前的对话」与媒体缓存；旧调用方可不带）。 */
  id?: number
}

/**
 * 这条消息值不值得回。
 *
 * `direction === 'out'` 的是**本机发出去的**（含 bot 回显）——回它就成了自己跟自己说话；
 * 非文本（图片/语音/文件/视频）不做自动回复：媒体的语义要么靠转写（未接入）、
 * 要么本来就是「转存给人看」而不是「问问题」。
 * @param msg - 候选消息。
 * @returns 可回复为 true。
 */
export function isReplyable(msg: ReplyableMessage): boolean {
  return msg.direction === 'in' && msg.msgType === 'text' && msg.content.trim() !== ''
}

/**
 * 从一批候选里挑出**唯一**要回的那条：最后一条可回复的入站文本。
 *
 * 为什么一批只回一条（而不是逐条回）：服务端不下发消息时间，所以「刚绑定、首次长轮询
 * 拉回一堆历史」与「用户连发几条」在数据上长得一样。逐条回会在前者场景里刷屏，
 * 只回最后一条把上界压到 1 条，且对后者也是最自然的反应（人也不会逐条回）。
 * @param candidates - 本批新落库的消息。
 * @returns 目标（无则 null）与被跳过的条数（供审计说清「这一批跳了多少」）。
 */
export function pickReplyTarget(candidates: readonly ReplyableMessage[]): { target: ReplyableMessage | null, dropped: number } {
  const ok = candidates.filter(isReplyable)
  const target = ok.at(-1)
  if (target === undefined) return { target: null, dropped: 0 }
  return { target, dropped: ok.length - 1 }
}

/** 超长回复截断（带上「已截断」字样，不假装完整）。 */
export function truncateReply(text: string): string {
  const t = text.trim()
  if (t.length <= MAX_REPLY_CHARS) return t
  return t.slice(0, MAX_REPLY_CHARS) + '…（内容较长，已截断）'
}

/** 自动回复发送时带出的持久化关联键（手动发送不传）。 */
export interface AutoReplySendContext {
  clientId: string
  runId: number
  partId: number
  partIndex: number
}

/**
 * 持久化编排依赖。
 *
 * 不传时执行器保持原来的纯内存队列行为（既有单测与旧注入方零改动）；
 * 生产装配传入后，每个目标消息先落 reply_run，再按 outbox 分段发送。
 */
export interface AutoReplyDurableDeps {
  /** 解密数据根（clawbot.db 在它的父目录）。 */
  dir: () => string
  /** 同 slot 的入站合并窗口；缺省 1s。 */
  debounceMs?: number
  /** 生成阶段最多尝试次数；缺省 3。 */
  maxGenerationAttempts?: number
  /** 单段发送最多尝试次数；缺省 5。 */
  maxPartAttempts?: number
  /** 指数退避基数；缺省 3s。 */
  retryBaseMs?: number
  /** 生成租约；缺省 60s，长任务由 runner 心跳续租。 */
  generationLeaseMs?: number
  /** 单段发送租约；缺省 30s，长任务由 runner 心跳续租。 */
  sendLeaseMs?: number
  /** 单次生成截止时间；缺省 120s，<=0 表示不额外限时。 */
  askTimeoutMs?: number
  /** 单段发送截止时间；缺省 60s，<=0 表示不额外限时。 */
  sendTimeoutMs?: number
  /** 恢复分页大小；缺省 500，主要供压测和故障注入调小。 */
  recoveryPageSize?: number
  /** 单轮恢复最多扫描多少行；缺省 10000。 */
  recoveryMaxScanPerRound?: number
  /** 单轮恢复最多新增多少个调度；缺省 5000。 */
  recoveryMaxSchedulesPerRound?: number
}

export interface AutoReplyRunnerDeps {
  /** 取该实例的配置（**每次现读**：用户关掉开关后，队列里的下一条就不再回）。 */
  readConfig: (slot: number) => ClawbotInstanceConfig
  /**
   * 同一 slot 的候选合并窗口（毫秒）。默认 0 = 立即入队，保持旧行为。
   * > 0 时窗口内连续 consider 只保留最后一条可回复文本。
   */
  debounceMs?: number
  /** 统一问答管道（缺省 = 未注入 ⇒ 自动回复不可用，只记账不发送）。 */
  ask?: ClawbotAskFn
  /** 发送（生产 = `sendClawbotText`：**成功才落库**，失败不写假记录）。 */
  send: (slot: number, text: string, context?: AutoReplySendContext) => Promise<ClawbotSendResult>
  /** 审计一行（`category='clawbot'`）。 */
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  /** 回复成功后通知外层（发 `clawbot/message` 事件，前端实时可见）。 */
  onReplied: (info: { slot: number, id: number }) => void
  /** 取目标消息之前的最近对话（缺省 = 不带上下文，退回旧行为）。 */
  history?: (slot: number, target: ReplyableMessage) => ClawbotHistoryMessage[]
  /** 取目标消息之前最近的入站图片（缺省 = 不送图；读取失败按空处理）。 */
  images?: (slot: number, target: ReplyableMessage) => Promise<ClawbotImageInput[]>
  /** 持久化 run/outbox；缺省 = 纯内存队列（旧行为）。 */
  durable?: AutoReplyDurableDeps
  /** durable 后台恢复周期；缺省 60s，非正数禁用。 */
  recoverIntervalMs?: number
}

interface AutoReplyTelemetry {
  isActive: (slot: number, generation: number) => boolean
  setStage: (stage: Exclude<AutoReplyRunnerStage, 'idle' | 'recovering'>, slot: number, runId?: number) => void
  countRecovered: (count: number) => void
  countRecoveryContinuation: () => void
  countLeaseLost: (message: string) => void
  countCoalesced: () => void
  countDropped: (count: number) => void
  countBackpressure: (message: string) => void
  countGenerationSucceeded: () => void
  countGenerationFailed: (message: string) => void
  countSendSucceeded: () => void
  countSendRetried: (message: string) => void
  countSendFailedPermanently: (message: string) => void
  noteError: (message: string) => void
  completed: (at: number) => void
  setRecovering: (recovering: boolean) => void
  clearStage: () => void
  reset: () => void
  snapshot: (pending: number) => AutoReplyRunnerStats
}

function createAutoReplyTelemetry(
  isDisposed: () => boolean,
  currentGeneration: (slot: number) => number,
): AutoReplyTelemetry {
  let activeStage: Exclude<AutoReplyRunnerStage, 'idle' | 'recovering'> | 'idle' = 'idle'
  let activeSlot: number | null = null
  let activeRunId: number | null = null
  let recovering = false
  const counters = {
    recovered: 0,
    recoveryContinuations: 0,
    leaseLost: 0,
    coalesced: 0,
    generationSucceeded: 0,
    generationFailed: 0,
    sendSucceeded: 0,
    sendRetried: 0,
    sendFailedPermanently: 0,
    dropped: 0,
    backpressure: 0,
  }
  let lastError: string | null = null
  let lastCompletedAt: number | null = null

  return {
    isActive: (slot, generation) => !isDisposed() && currentGeneration(slot) === generation,
    setStage: (stage, slot, runId) => {
      if (isDisposed()) return
      activeStage = stage
      activeSlot = slot
      activeRunId = runId ?? null
    },
    countRecovered: (count) => {
      if (!isDisposed()) counters.recovered += Math.max(Math.floor(count), 0)
    },
    countRecoveryContinuation: () => {
      if (!isDisposed()) counters.recoveryContinuations += 1
    },
    countLeaseLost: (message) => {
      if (isDisposed()) return
      counters.leaseLost += 1
      lastError = message
    },
    countCoalesced: () => {
      if (!isDisposed()) counters.coalesced += 1
    },
    countDropped: (count) => {
      if (!isDisposed()) counters.dropped += Math.max(Math.floor(count), 0)
    },
    countBackpressure: (message) => {
      if (isDisposed()) return
      counters.backpressure += 1
      lastError = message
    },
    countGenerationSucceeded: () => {
      if (!isDisposed()) counters.generationSucceeded += 1
    },
    countGenerationFailed: (message) => {
      if (isDisposed()) return
      counters.generationFailed += 1
      lastError = message
    },
    countSendSucceeded: () => {
      if (!isDisposed()) counters.sendSucceeded += 1
    },
    countSendRetried: (message) => {
      if (isDisposed()) return
      counters.sendRetried += 1
      lastError = message
    },
    countSendFailedPermanently: (message) => {
      if (isDisposed()) return
      counters.sendFailedPermanently += 1
      lastError = message
    },
    noteError: (message) => {
      if (!isDisposed()) lastError = message
    },
    completed: (at) => {
      if (!isDisposed()) lastCompletedAt = at
    },
    setRecovering: (value) => {
      if (!isDisposed()) recovering = value
    },
    clearStage: () => {
      activeStage = 'idle'
      activeSlot = null
      activeRunId = null
    },
    reset: () => {
      recovering = false
      activeStage = 'idle'
      activeSlot = null
      activeRunId = null
    },
    snapshot: (pending) => {
      const stage: AutoReplyRunnerStage = activeStage !== 'idle'
        ? activeStage
        : recovering ? 'recovering' : 'idle'
      return {
        pending,
        inFlight: stage !== 'idle',
        stage,
        inFlightSlot: activeSlot,
        inFlightRunId: activeRunId,
        ...counters,
        lastError,
        lastCompletedAt,
      }
    },
  }
}

/** 单实例内存队列：多个 slot 之间按环轮转，避免 Map 插入顺序造成饥饿。 */
function createMemoryReplyQueue(onFull: (slot: number) => void): {
enqueue: (slot: number, msg: ReplyableMessage) => boolean
takeNext: () => { slot: number, msg: ReplyableMessage } | null
discard: (slot: number) => void
  dispose: () => void
  pending: () => number
} {
  const queues = new Map<number, ReplyableMessage[]>()
  const ring: number[] = []
  const ringSlots = new Set<number>()
  let cursor = 0

  function registerSlot(slot: number): void {
    if (ringSlots.has(slot)) return
    ringSlots.add(slot)
    ring.push(slot)
  }

  return {
    enqueue(slot, msg): boolean {
      let q = queues.get(slot)
      if (q === undefined) {
        q = []
        queues.set(slot, q)
      }
      if (q.length >= MAX_PENDING) {
        onFull(slot)
        return false
      }
      registerSlot(slot)
      q.push(msg)
      return true
    },

    takeNext(): { slot: number, msg: ReplyableMessage } | null {
      while (ring.length > 0) {
        if (cursor >= ring.length) cursor = 0
        const slot = ring[cursor]
        if (slot === undefined) {
          cursor = 0
          continue
        }
        const q = queues.get(slot)
        if (q === undefined || q.length === 0) {
          ring.splice(cursor, 1)
          ringSlots.delete(slot)
          queues.delete(slot)
          continue
        }
        const msg = q.shift()
        if (msg === undefined) {
          ring.splice(cursor, 1)
          ringSlots.delete(slot)
          queues.delete(slot)
          continue
        }
        cursor += 1
        return { slot, msg }
      }
      cursor = 0
      return null
    },

    discard(slot: number): void {
      queues.delete(slot)
      if (!ringSlots.delete(slot)) return
      const index = ring.indexOf(slot)
      if (index >= 0) {
        ring.splice(index, 1)
        if (index < cursor) cursor -= 1
      }
      if (cursor >= ring.length) cursor = 0
    },

    dispose(): void {
      queues.clear()
      ring.length = 0
      ringSlots.clear()
      cursor = 0
    },

    pending(): number {
      let n = 0
      for (const q of queues.values()) n += q.length
      return n
    },
  }
}

/**
 * durable run 的定时器与公平队列。
 *
 * 定时器只负责把 run 放回环里；真正的数据库读写统一在 `drain()` 的全局单飞中顺序执行。
 */
function createDurableRunScheduler(
  readRun: (runId: number) => ClawbotReplyRunSnapshot | null,
  wake: () => void,
  onError: (message: string) => void,
): {
  queue: (runId: number, slot: number) => void
  schedule: (runId: number, slot: number, delayMs: number) => boolean
  takeNext: () => { runId: number, slot: number } | null
  finish: (runId: number) => void
  hasQueued: () => boolean
  isKnown: (runId: number) => boolean
  discardSlot: (slot: number) => void
  dispose: () => void
  pending: () => number
} {
  const queuedRuns = new Set<number>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const runSlots = new Map<number, number>()
  const activeRuns = new Set<number>()
  const activeSlots = new Map<number, number>()
  const unknownSlot = -1
  const queues = new Map<number, number[]>()
  const ring: number[] = []
  const ringSlots = new Set<number>()
  let cursor = 0
  let disposed = false

  function registerSlot(slot: number): void {
    if (ringSlots.has(slot)) return
    ringSlots.add(slot)
    ring.push(slot)
  }

  function queue(runId: number, slot: number): void {
    if (disposed || queuedRuns.has(runId)) return
    queuedRuns.add(runId)
    runSlots.set(runId, slot)
    let q = queues.get(slot)
    if (q === undefined) {
      q = []
      queues.set(slot, q)
    }
    q.push(runId)
    registerSlot(slot)
  }

  return {
    queue,

    schedule(runId: number, slot: number, delayMs: number): boolean {
      if (disposed || queuedRuns.has(runId)) return false
      const hadTimer = timers.has(runId)
      const old = timers.get(runId)
      if (old !== undefined) clearTimeout(old)
      runSlots.set(runId, slot)
      const timer = setTimeout(() => {
        timers.delete(runId)
        if (disposed) return
        if (runSlots.get(runId) !== slot) return
        runSlots.delete(runId)
        try {
          const snap = readRun(runId)
          if (snap === null) return
          const done = snap.run.status === 'done' || snap.run.status === 'failed' || snap.run.status === 'skipped'
          if (done) return
          queue(runId, snap.run.slot)
          wake()
        } catch (e) {
          runSlots.delete(runId)
          onError(`run=${String(runId)} 定时唤醒失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }, Math.max(Math.floor(delayMs), 0))
      const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
      unrefTimer.unref?.()
      timers.set(runId, timer)
      return !hadTimer
    },

    takeNext(): { runId: number, slot: number } | null {
      if (disposed) return null
      while (ring.length > 0) {
        if (cursor >= ring.length) cursor = 0
        const slot = ring[cursor]
        if (slot === undefined) {
          cursor = 0
          continue
        }
        const q = queues.get(slot)
        if (q === undefined || q.length === 0) {
          ring.splice(cursor, 1)
          ringSlots.delete(slot)
          queues.delete(slot)
          continue
        }
        const runId = q.shift()
        if (runId === undefined) continue
        queuedRuns.delete(runId)
        runSlots.delete(runId)
        activeRuns.add(runId)
        activeSlots.set(runId, slot)
        cursor += 1
        return { runId, slot }
      }
      cursor = 0
      return null
    },

    finish(runId: number): void {
      activeRuns.delete(runId)
      activeSlots.delete(runId)
    },

    hasQueued(): boolean {
      return !disposed && queuedRuns.size > 0
    },

    isKnown(runId: number): boolean {
      return queuedRuns.has(runId) || timers.has(runId) || activeRuns.has(runId)
    },

    discardSlot(slot: number): void {
      if (disposed) return
      for (const [runId, runSlot] of runSlots) {
        let matches = runSlot === slot
        if (runSlot === unknownSlot) {
          try {
            const snap = readRun(runId)
            matches = snap === null || snap.run.slot === slot
          } catch {
            matches = false
          }
        }
        if (!matches) continue
        const timer = timers.get(runId)
        if (timer !== undefined) clearTimeout(timer)
        timers.delete(runId)
        queuedRuns.delete(runId)
        runSlots.delete(runId)
      }
      for (const [runId, runSlot] of activeSlots) {
        if (runSlot !== slot) continue
        const timer = timers.get(runId)
        if (timer !== undefined) clearTimeout(timer)
        timers.delete(runId)
        queuedRuns.delete(runId)
        runSlots.delete(runId)
      }
      queues.delete(slot)
      if (!ringSlots.delete(slot)) return
      const index = ring.indexOf(slot)
      if (index >= 0) {
        ring.splice(index, 1)
        if (index < cursor) cursor -= 1
      }
      if (cursor >= ring.length) cursor = 0
    },

    dispose(): void {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      queuedRuns.clear()
      runSlots.clear()
      activeRuns.clear()
      activeSlots.clear()
      queues.clear()
      ring.length = 0
      ringSlots.clear()
      cursor = 0
    },

    pending(): number {
      return disposed ? 0 : queuedRuns.size + timers.size
    },
  }
}

/** 自动回复的上下文读取：失败一律按空上下文处理，不许阻断回复。 */
function contextFor(
  deps: AutoReplyRunnerDeps,
  slot: number,
  msg: ReplyableMessage,
): ClawbotAskContext | Promise<ClawbotAskContext> {
  const context: ClawbotAskContext = {}
  try {
    const history = deps.history?.(slot, msg)
    if (history !== undefined && history.length > 0) context.history = history
  } catch { /* 上下文尽力而为 */ }
  if (deps.images === undefined) return context
  try {
    return deps.images(slot, msg)
      .then((images) => {
        if (images.length > 0) context.images = images
        return context
      })
      .catch(() => context)
  } catch {
    return context
  }
}

/** 审计出口是尽力而为；它抛错不能中断恢复链或主循环。 */
function safeOp(
  deps: Pick<AutoReplyRunnerDeps, 'op'>,
  category: OperationCategory,
  action: string,
  status: OperationStatus,
  target?: string,
  detail?: string,
): void {
  try {
    deps.op(category, action, status, target, detail)
  } catch { /* 审计失败不改变业务结果 */ }
}

/**
 * 给无法物理取消的外部调用加一道截止时间。
 *
 * Promise.race 只能让编排继续前进；底层请求是否真正取消仍取决于注入实现。
 */
class LeaseLostError extends Error {
  constructor() {
    super('回复任务的租约已被接管')
    this.name = 'LeaseLostError'
  }
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  leaseLoss?: Promise<void>,
): Promise<T> {
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0
  if (!hasDeadline && leaseLoss === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      action()
    }
    if (hasDeadline) {
      timer = setTimeout(() => {
        finish(() => reject(new Error(`${label}超过 ${String(timeoutMs)}ms 截止时间`)))
      }, timeoutMs)
      const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
      unrefTimer.unref?.()
    }
    leaseLoss?.then(() => {
      finish(() => reject(new LeaseLostError()))
    })
    promise.then(
      (value) => {
        finish(() => resolve(value))
      },
      (error: unknown) => {
        finish(() => reject(error))
      },
    )
  })
}

/** 大积压恢复按页主动让出事件循环，避免同步 SQLite/timer 建链阻塞收发与 UI 状态。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** 旧的内存队列路径：生成后逐段发送；任一段失败即停。 */
async function handleMemoryReply(
  deps: AutoReplyRunnerDeps,
  slot: number,
  msg: ReplyableMessage,
  cfg: ClawbotInstanceConfig,
  telemetry: AutoReplyTelemetry,
  generation: number,
): Promise<void> {
  const tag = `slot=${slot}`
  const ask = deps.ask
  if (ask === undefined) {
    telemetry.countGenerationFailed('ask 能力未注入（自动回复不可用）')
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, 'ask 能力未注入（自动回复不可用）')
    return
  }
  const kbId = cfg.kbEnabled && cfg.kbId !== null ? cfg.kbId : null
  telemetry.setStage('generating', slot)
  const pendingContext = contextFor(deps, slot, msg)
  const context = pendingContext instanceof Promise ? await pendingContext : pendingContext
  if (!telemetry.isActive(slot, generation)) return
  let r: Awaited<ReturnType<ClawbotAskFn>>
  try {
    r = await ask(slot, msg.content, kbId, cfg.systemPrompt, context)
  } catch (e) {
    if (!telemetry.isActive(slot, generation)) return
    const reason = e instanceof Error ? e.message : String(e)
    telemetry.countGenerationFailed(reason)
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag,
      '自动回复失败：' + reason)
    return
  }
  if (!telemetry.isActive(slot, generation)) return
  if (!r.ok) {
    const reason = r.error ?? '未知原因'
    telemetry.countGenerationFailed(reason)
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '自动回复失败：' + reason)
    return
  }
  const text = truncateReply(r.answer)
  if (text === '') {
    telemetry.countGenerationFailed('模型返回空答案，未发送')
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '模型返回空答案，未发送')
    return
  }
  telemetry.countGenerationSucceeded()
  const parts = cfg.splitReply ? splitReplyText(text) : [text]
  telemetry.setStage('sending', slot)
  let sentCount = 0
  for (const part of parts) {
    let sent: ClawbotSendResult
    try {
      sent = await deps.send(slot, part)
    } catch (e) {
      if (!telemetry.isActive(slot, generation)) return
      const reason = e instanceof Error ? e.message : String(e)
      telemetry.countSendFailedPermanently(reason)
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag,
        `回复发送失败（第 ${String(sentCount + 1)}/${String(parts.length)} 段）：` +
        reason)
      return
    }
    if (!telemetry.isActive(slot, generation)) return
    if (!sent.ok || sent.id === null) {
      const reason = sent.error ?? '未知原因'
      telemetry.countSendFailedPermanently(reason)
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag,
        `回复未发出（第 ${String(sentCount + 1)}/${String(parts.length)} 段）：` +
        reason)
      return
    }
    telemetry.countSendSucceeded()
    sentCount += 1
    if (!telemetry.isActive(slot, generation)) return
    try {
      deps.onReplied({ slot, id: sent.id })
    } catch { /* 事件尽力而为 */ }
  }
  if (!telemetry.isActive(slot, generation)) return
  telemetry.completed(Date.now())
  deps.op('clawbot', 'clawbot_auto_reply', 'ok', tag,
    `已自动回复 ${String(text.length)} 字` +
    (parts.length > 1 ? `（分 ${String(parts.length)} 段发送）` : '') +
    (kbId === null ? '（未检索知识库）' : `（知识库 ${String(kbId)}）`) +
    (context.history === undefined ? '' : `（上下文 ${String(context.history.length)} 条）`) +
    (context.images === undefined ? '' : `（图片 ${String(context.images.length)} 张）`))
}

interface DurableReplyRuntime {
  deps: AutoReplyRunnerDeps
  durable: AutoReplyDurableDeps
  telemetry: AutoReplyTelemetry
  owner: string
  maxGenerationAttempts: number
  maxPartAttempts: number
  retryBaseMs: number
  generationLeaseMs: number
  sendLeaseMs: number
  askTimeoutMs: number
  sendTimeoutMs: number
  leaseHeartbeats: Set<ReturnType<typeof setInterval>>
  currentGeneration: (slot: number) => number
  scheduleRun: (
    runId: number,
    slot: number | null,
    delayMs: number,
    generation: number | null,
  ) => boolean
  isRunKnown: (runId: number) => boolean
}

interface DurableReplyRuntimeParts {
  runtime: DurableReplyRuntime
  scheduler: ReturnType<typeof createDurableRunScheduler>
}

function createDurableReplyRuntime(
  deps: AutoReplyRunnerDeps,
  durable: AutoReplyDurableDeps,
  telemetry: AutoReplyTelemetry,
  isDisposed: () => boolean,
  currentGeneration: (slot: number) => number,
  wake: () => void,
): DurableReplyRuntimeParts {
  const scheduler = createDurableRunScheduler(
    (runId) => readReplyRun(durable.dir(), runId),
    wake,
    (message) => {
      telemetry.noteError(message)
      safeOp(deps, 'clawbot', 'clawbot_auto_reply', 'fail', '', message)
    },
  )
  const runtime: DurableReplyRuntime = {
    deps,
    durable,
    telemetry,
    owner: `clawbot-${String(process.pid)}-${randomUUID()}`,
    maxGenerationAttempts: Math.max(Math.floor(durable.maxGenerationAttempts ?? 3), 1),
    maxPartAttempts: Math.max(Math.floor(durable.maxPartAttempts ?? 5), 1),
    retryBaseMs: Math.max(Math.floor(durable.retryBaseMs ?? 3_000), 0),
    generationLeaseMs: Math.max(
      Math.floor(durable.generationLeaseMs ?? REPLY_GENERATING_LEASE_MS),
      1_000,
    ),
    sendLeaseMs: Math.max(
      Math.floor(durable.sendLeaseMs ?? REPLY_SENDING_LEASE_MS),
      1_000,
    ),
    askTimeoutMs: Number.isFinite(durable.askTimeoutMs)
      ? Math.max(Math.floor(durable.askTimeoutMs as number), 0)
      : 120_000,
    sendTimeoutMs: Number.isFinite(durable.sendTimeoutMs)
      ? Math.max(Math.floor(durable.sendTimeoutMs as number), 0)
      : 60_000,
    leaseHeartbeats: new Set(),
    currentGeneration,
    scheduleRun: (runId, slot, delayMs, generation) => {
      if (isDisposed()) return false
      if (slot !== null && generation !== null && currentGeneration(slot) !== generation) return false
      return scheduler.schedule(runId, slot ?? -1, delayMs)
    },
    isRunKnown: (runId) => scheduler.isKnown(runId),
  }
  return { runtime, scheduler }
}

interface AutoReplyRecoveryController {
  start: () => void
  recover: () => void
  scheduleAfterError: () => void
  dispose: () => void
}

function createAutoReplyRecoveryController(
  runtime: DurableReplyRuntime | null,
  telemetry: AutoReplyTelemetry,
  isDisposed: () => boolean,
  currentGeneration: (slot: number) => number,
  wake: () => void,
  configuredIntervalMs: number | undefined,
): AutoReplyRecoveryController {
  const recoveryIntervalMs = configuredIntervalMs === undefined
    ? DEFAULT_RECOVERY_INTERVAL_MS
    : Number.isFinite(configuredIntervalMs)
      ? Math.max(Math.floor(configuredIntervalMs), 0)
      : 0
  const recoveryPageSize = runtime === null
    ? RECOVERY_PAGE_SIZE
    : Math.min(
        positiveLimit(runtime.durable.recoveryPageSize, RECOVERY_PAGE_SIZE),
        MAX_REPLY_RECOVERABLE_LIMIT,
      )
  const maxScanPerRound = runtime === null
    ? MAX_RECOVERY_SCAN_PER_ROUND
    : positiveLimit(runtime.durable.recoveryMaxScanPerRound, MAX_RECOVERY_SCAN_PER_ROUND)
  const maxSchedulesPerRound = runtime === null
    ? MAX_RECOVERY_SCHEDULES_PER_ROUND
    : positiveLimit(
        runtime.durable.recoveryMaxSchedulesPerRound,
        MAX_RECOVERY_SCHEDULES_PER_ROUND,
      )
  let periodicTimer: ReturnType<typeof setTimeout> | null = null
  let errorTimer: ReturnType<typeof setTimeout> | null = null
  let continuationTimer: ReturnType<typeof setTimeout> | null = null
  /** 跨轮保留；扫到 EOF 或短页后回卷，避免每轮都从 id=0 重扫造成高 id 饿死。 */
  let recoveryCursor = 0
  let recoveringNow = false
  /** 恢复进行中收到的新触发不能丢；本轮结束后立刻再扫一遍。 */
  let rerunRequested = false

  type RecoveryOutcome = 'complete' | 'budget' | 'error'

  async function scanRecoverableRuns(): Promise<RecoveryOutcome> {
    if (runtime === null || isDisposed()) return 'complete'
    try {
      let scanned = 0
      let scheduled = 0
      let stoppedAtBudget = false
      let sliceStartedAt = Date.now()
      while (!isDisposed()) {
        const now = Date.now()
        const page = listRecoverableReplyRunsAfterId(
          runtime.durable.dir(),
          recoveryCursor,
          recoveryPageSize,
        )
        if (page.length === 0) {
          recoveryCursor = 0
          break
        }

        let processedInPage = 0
        let lastProcessed = recoveryCursor
        for (const run of page) {
          if (isDisposed()) return 'complete'
          if (
            scanned >= maxScanPerRound ||
            scheduled >= maxSchedulesPerRound
          ) {
            stoppedAtBudget = true
            break
          }
          scanned += 1
          processedInPage += 1
          lastProcessed = run.id
          if (runtime.isRunKnown(run.id)) continue
          if (runtime.scheduleRun(
            run.id,
            run.slot,
            Math.max(run.nextAttemptAt - now, 0),
            currentGeneration(run.slot),
          )) {
            scheduled += 1
            telemetry.countRecovered(1)
          }
          if (Date.now() - sliceStartedAt >= RECOVERY_MAX_SLICE_MS) {
            await yieldToEventLoop()
            sliceStartedAt = Date.now()
          }
        }
        if (lastProcessed <= recoveryCursor && processedInPage > 0) {
          throw new Error(`恢复分页游标未前进：${String(recoveryCursor)} -> ${String(lastProcessed)}`)
        }
        recoveryCursor = lastProcessed

        if (processedInPage < page.length) stoppedAtBudget = true
        if (stoppedAtBudget) {
          const overflow = listRecoverableReplyRunsAfterId(runtime.durable.dir(), recoveryCursor, 1)
          if (overflow.length === 0) {
            recoveryCursor = 0
          } else {
            return 'budget'
          }
          break
        }
        if (page.length < recoveryPageSize) {
          recoveryCursor = 0
          break
        }
        await yieldToEventLoop()
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      telemetry.noteError(reason)
      safeOp(runtime.deps, 'clawbot', 'clawbot_auto_reply', 'fail', '',
        '恢复待回复 run 失败：' + reason)
      return 'error'
    }
    return 'complete'
  }

  async function runRecoveryPass(): Promise<void> {
    if (runtime === null || isDisposed()) return
    if (recoveringNow) {
      rerunRequested = true
      return
    }
    recoveringNow = true
    telemetry.setRecovering(true)
    let outcome: RecoveryOutcome
    try {
      outcome = await scanRecoverableRuns()
    } finally {
      recoveringNow = false
      telemetry.setRecovering(false)
    }
    if (isDisposed()) return
    wake()
    if (rerunRequested) {
      rerunRequested = false
      scheduleContinuation(0)
    } else if (outcome === 'budget') {
      scheduleContinuation(DEFAULT_RECOVERY_CONTINUATION_MS)
    } else if (outcome === 'error') {
      scheduleErrorRetry()
    }
  }

  function requestRecovery(): void {
    if (runtime === null || isDisposed()) return
    if (recoveringNow) {
      rerunRequested = true
      return
    }
    if (continuationTimer !== null) {
      clearTimeout(continuationTimer)
      continuationTimer = null
    }
    if (errorTimer !== null) {
      clearTimeout(errorTimer)
      errorTimer = null
    }
    void runRecoveryPass()
  }

  function scheduleContinuation(delayMs = DEFAULT_RECOVERY_CONTINUATION_MS): void {
    if (isDisposed() || runtime === null || continuationTimer !== null) return
    telemetry.countRecoveryContinuation()
    const timer = setTimeout(() => {
      continuationTimer = null
      requestRecovery()
    }, delayMs)
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    unrefTimer.unref?.()
    continuationTimer = timer
  }

  function scheduleErrorRetry(): void {
    if (isDisposed() || runtime === null || errorTimer !== null) return
    const timer = setTimeout(() => {
      errorTimer = null
      requestRecovery()
    }, RECOVERY_ERROR_RETRY_MS)
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    unrefTimer.unref?.()
    errorTimer = timer
  }

  function schedulePeriodic(): void {
    if (isDisposed() || runtime === null || recoveryIntervalMs <= 0 || periodicTimer !== null) return
    const timer = setTimeout(() => {
      periodicTimer = null
      if (isDisposed()) return
      schedulePeriodic()
      requestRecovery()
    }, recoveryIntervalMs)
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    unrefTimer.unref?.()
    periodicTimer = timer
  }

  return {
    start(): void {
      schedulePeriodic()
    },

    recover(): void {
      requestRecovery()
    },

    scheduleAfterError: scheduleErrorRetry,

    dispose(): void {
      if (periodicTimer !== null) {
        clearTimeout(periodicTimer)
        periodicTimer = null
      }
      if (errorTimer !== null) {
        clearTimeout(errorTimer)
        errorTimer = null
      }
      if (continuationTimer !== null) {
        clearTimeout(continuationTimer)
        continuationTimer = null
      }
      rerunRequested = false
    },
  }
}

function durableBackoffMs(rt: DurableReplyRuntime, attempts: number): number {
  return Math.min(rt.retryBaseMs * (2 ** Math.max(attempts - 1, 0)), 60_000)
}

/** 跳过与生成失败共用同一口径；错误详情只保留代码和可读原因，不含回答正文。 */
function skipRunDetail(runId: number, decision: AutoReplyDecision): string {
  const errorCode = decision.reason === AUTO_REPLY_KB_REQUIRED_MESSAGE ? 'kb_required' : 'auto_reply_skipped'
  return replyRunDetailJson(runId, { ok: false, answer: '', error: decision.reason }, {
    status: 'skipped',
    statusReason: decision.reason,
    sendDecision: { send: false, reason: decision.reason, errorCode },
    errorCode,
  })
}

function failedRunDetail(
  runId: number,
  reason: string,
  errorCode: string,
  result?: ClawbotReplyAskResult,
): string {
  return replyRunDetailJson(runId, result ?? { ok: false, answer: '', error: reason }, {
    status: 'failed',
    sendDecision: { send: false, error: reason, errorCode },
    errorCode,
    error: reason,
  })
}

function heartbeatEvery(leaseMs: number): number {
  return Math.max(Math.floor(leaseMs / 3), 50)
}

interface LeaseHeartbeat {
  /**
   * 结果写回前的同步门禁：lost / 已停止 / 已到 leaseUntil 任一成立都拒绝。
   * 若截止时间刚过而心跳 timer 尚未跑到，本方法会补记一次租约丢失。
   */
  canCommitResult: () => boolean
  lost: () => boolean
  loss: Promise<void>
  stop: () => void
}

function startLeaseHeartbeat(
  rt: DurableReplyRuntime,
  slot: number,
  generation: number,
  initialUntil: number,
  label: string,
  renew: () => number | null,
  leaseMs: number,
): LeaseHeartbeat {
  let active = true
  let lost = false
  let leaseUntil = initialUntil
  let resolveLoss: () => void = () => {}
  const loss = new Promise<void>((resolve) => { resolveLoss = resolve })

  const stop = (): void => {
    active = false
    clearInterval(timer)
    rt.leaseHeartbeats.delete(timer)
  }
  const markLost = (reason: string): void => {
    if (lost) return
    lost = true
    stop()
    rt.telemetry.countLeaseLost(reason)
    safeOp(rt.deps, 'clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(slot)}`,
      `${label}：${reason}`)
    resolveLoss()
  }
  const canCommitResult = (): boolean => {
    if (lost || !active) return false
    if (Date.now() < leaseUntil) return true
    markLost('结果返回时本机租约已过期，已丢弃晚到结果')
    return false
  }
  const timer = setInterval(() => {
    if (!active) return
    if (!rt.telemetry.isActive(slot, generation)) {
      stop()
      return
    }
    if (Date.now() >= leaseUntil) {
      markLost('本机租约已过期，停止等待晚到结果')
      return
    }
    try {
      const until = renew()
      if (until === null) {
        markLost('租约续期返回失效，已停止等待晚到结果')
        return
      }
      leaseUntil = until
    } catch (e) {
      if (Date.now() >= leaseUntil) {
        const reason = e instanceof Error ? e.message : String(e)
        markLost(`租约续期失败且已过期：${reason}`)
      }
    }
  }, heartbeatEvery(leaseMs))
  timer.unref?.()
  rt.leaseHeartbeats.add(timer)

  return {
    canCommitResult,
    lost: () => lost,
    loss,
    stop,
  }
}

function startGenerationLeaseHeartbeat(
  rt: DurableReplyRuntime,
  claim: ClawbotReplyGenerationClaim,
  generation: number,
): LeaseHeartbeat {
  return startLeaseHeartbeat(
    rt,
    claim.run.slot,
    generation,
    claim.lease.until,
    `run=${String(claim.run.id)} 生成租约丢失`,
    () => renewReplyRunGenerationClaim(rt.durable.dir(), claim, rt.generationLeaseMs)?.lease.until ?? null,
    rt.generationLeaseMs,
  )
}

function startSendLeaseHeartbeat(
  rt: DurableReplyRuntime,
  claim: ClawbotReplySendClaim,
  generation: number,
): LeaseHeartbeat {
  return startLeaseHeartbeat(
    rt,
    claim.part.slot,
    generation,
    Math.min(claim.lease.until, claim.runLease.until),
    `run=${String(claim.part.runId)} part=${String(claim.part.partIndex + 1)} 发送租约丢失`,
    () => {
      const renewed = renewReplyPartSendingClaim(rt.durable.dir(), claim, rt.sendLeaseMs)
      return renewed === null ? null : Math.min(renewed.lease.until, renewed.runLease.until)
    },
    rt.sendLeaseMs,
  )
}

async function sendDurableParts(
  rt: DurableReplyRuntime,
  run: ClawbotReplyRun,
  parts: readonly ClawbotReplyPart[],
  cfg: ClawbotInstanceConfig,
  generation: number,
): Promise<void> {
  const { deps, durable } = rt
  let lastClaim: ClawbotReplySendClaim | null = null
  const sendFailedDetail = (reason: string): string => mergeReplyRunDetail(run.resultJson, run.id, {
    status: 'failed',
    sendDecision: { send: false, error: reason, errorCode: 'send_failed' },
    errorCode: 'send_failed',
    error: reason,
  })

  for (const part of parts) {
    if (!rt.telemetry.isActive(run.slot, generation)) return
    rt.telemetry.setStage('sending', run.slot, run.id)
    if (part.status === 'sent') continue
    if (part.status === 'failed') {
      const reason = `第 ${String(part.partIndex + 1)} 段此前已永久失败`
      try {
        if (markReplyRunFailedIfIdle(durable.dir(), run.id, reason, undefined, sendFailedDetail(reason)) === null) {
          rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, part.attempts), generation)
          return
        }
        rt.telemetry.countSendFailedPermanently(reason)
      } catch (e) {
        rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
          `run=${String(run.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
        rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, part.attempts), generation)
      }
      return
    }

    let claim: ClawbotReplySendClaim | null
    try {
      claim = claimReplyPartSending(durable.dir(), {
        partId: part.id,
        owner: rt.owner,
        leaseMs: rt.sendLeaseMs,
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      rt.telemetry.noteError(reason)
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} stage=claim_sending 失败：${reason}`)
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, Math.max(part.attempts, 1)), generation)
      return
    }
    if (claim === null) {
      // 另一个 worker 正持有租约，或该段已在他处终结；不重复出网。
      rt.scheduleRun(run.id, run.slot, Math.max(rt.retryBaseMs, 1_000), generation)
      return
    }
    const sending = claim.part
    if (sending.attempts > rt.maxPartAttempts) {
      const reason = '发送尝试已达上限'
      try {
        const failed = failReplyPartAndRunClaimed(
          durable.dir(),
          claim,
          `第 ${String(sending.partIndex + 1)} 段发送尝试已达上限`,
          undefined,
          sendFailedDetail('发送尝试已达上限'),
        )
        if (failed === null) return
        rt.telemetry.countSendFailedPermanently(reason)
      } catch (e) {
        rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
          `run=${String(run.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
        rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, sending.attempts), generation)
      }
      return
    }

    let sent: ClawbotSendResult
    let canCommitResult = false
    const heartbeat = startSendLeaseHeartbeat(rt, claim, generation)
    try {
      sent = await withDeadline(
        deps.send(run.slot, sending.text, {
          clientId: sending.clientId,
          runId: run.id,
          partId: sending.id,
          partIndex: sending.partIndex,
        }),
        rt.sendTimeoutMs,
        '回复发送',
        heartbeat.loss,
      )
      canCommitResult = heartbeat.canCommitResult()
    } catch (e) {
      if (heartbeat.lost()) return
      canCommitResult = heartbeat.canCommitResult()
      if (!canCommitResult) return
      sent = { ok: false, id: null, error: e instanceof Error ? e.message : String(e) }
    } finally {
      heartbeat.stop()
    }
    if (!canCommitResult) return
    if (heartbeat.lost()) return
    if (!rt.telemetry.isActive(run.slot, generation)) return
    if (!sent.ok || sent.id === null) {
      const reason = sent.error ?? '未知原因'
      if (sending.attempts >= rt.maxPartAttempts) {
        try {
          const failed = failReplyPartAndRunClaimed(
            durable.dir(),
            claim,
            `第 ${String(sending.partIndex + 1)} 段发送失败：${reason}`,
            undefined,
            sendFailedDetail(reason),
          )
          if (failed === null) return
          rt.telemetry.countSendFailedPermanently(reason)
        } catch (e) {
          rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
          deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
            `run=${String(run.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
          rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, sending.attempts), generation)
          return
        }
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
          `run=${String(run.id)} part=${String(sending.partIndex + 1)}/${String(parts.length)} ` +
          `client=${sending.clientId} attempts=${String(sending.attempts)}：${reason}`)
        return
      }
      const next = Date.now() + durableBackoffMs(rt, sending.attempts)
      try {
        const retried = markReplyPartRetryClaimed(durable.dir(), claim, reason, next)
        if (retried === null) return
        rt.telemetry.countSendRetried(reason)
      } catch (e) {
        rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
          `run=${String(run.id)} stage=mark_retry 失败：${e instanceof Error ? e.message : String(e)}`)
      }
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} part=${String(sending.partIndex + 1)}/${String(parts.length)} ` +
        `client=${sending.clientId} stage=send_retry attempt=${String(sending.attempts)}：${reason}`)
      rt.scheduleRun(run.id, run.slot, Math.max(next - Date.now(), 0), generation)
      return
    }
    try {
      const marked = markReplyPartSentClaimed(durable.dir(), claim, sent.id)
      if (marked === null) return
      rt.telemetry.countSendSucceeded()
      deps.onReplied({ slot: run.slot, id: sent.id })
      lastClaim = claim
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} part=${String(sending.partIndex + 1)} stage=mark_sent 失败：` +
        (e instanceof Error ? e.message : String(e)))
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, sending.attempts), generation)
      return
    }
  }

  if (!rt.telemetry.isActive(run.slot, generation)) return
  rt.telemetry.setStage('completing', run.slot, run.id)
  try {
    const completed = lastClaim === null
      ? markReplyRunDoneIfIdle(durable.dir(), run.id)
      : markReplyRunDoneClaimed(durable.dir(), lastClaim)
    if (completed === null) {
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
      return
    }
  } catch (e) {
    rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
      `run=${String(run.id)} stage=mark_done 失败：${e instanceof Error ? e.message : String(e)}`)
    rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
    return
  }
  rt.telemetry.completed(Date.now())
  deps.op('clawbot', 'clawbot_auto_reply', 'ok', `slot=${String(run.slot)}`,
    `run=${String(run.id)} 已完成 ${String(parts.length)} 段 outbox` +
    (cfg.kbEnabled && cfg.kbId !== null ? `（知识库 ${String(cfg.kbId)}）` : '（未检索知识库）'))
}

interface DurableRunHandling {
  run: ClawbotReplyRun
  parts: readonly ClawbotReplyPart[]
  cfg: ClawbotInstanceConfig
  decision: AutoReplyDecision
  generation: number
}

/** 读取 run、配置与自动回复决策；失败时按原有退避策略重新排期。 */
function loadDurableRunForHandling(rt: DurableReplyRuntime, runId: number): DurableRunHandling | null {
  const { deps, durable } = rt
  let snap: ClawbotReplyRunSnapshot | null
  try {
    snap = readReplyRun(durable.dir(), runId)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    rt.telemetry.noteError(reason)
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', '', `run=${String(runId)} 读取失败：${reason}`)
    rt.scheduleRun(runId, null, Math.max(durableBackoffMs(rt, 3), 5_000), null)
    return null
  }
  if (snap === null) return null
  const run = snap.run
  if (run.status === 'done' || run.status === 'failed' || run.status === 'skipped') return null
  const generation = rt.currentGeneration(run.slot)

  let cfg: ClawbotInstanceConfig
  try {
    cfg = deps.readConfig(run.slot)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    rt.telemetry.noteError(reason)
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
      `run=${String(run.id)} stage=read_config 失败：${reason}`)
    rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
    return null
  }
  return { run, parts: snap.parts, cfg, decision: decideAutoReply(cfg), generation }
}

/** 已有 outbox 时只做发送；配置中途关闭则按策略跳过，不再重新生成。 */
async function handleExistingParts(rt: DurableReplyRuntime, state: DurableRunHandling): Promise<void> {
  const { deps, durable } = rt
  const { run, parts, cfg, decision, generation } = state
  if (!decision.should) {
    try {
      const skipped = skipRunDetail(run.id, decision)
      if (markReplyRunSkippedIfIdle(durable.dir(), run.id, decision.reason, undefined, skipped) === null) {
        rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
      }
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} stage=mark_skipped 失败：${e instanceof Error ? e.message : String(e)}`)
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
    }
    return
  }
  await sendDurableParts(rt, run, parts, cfg, generation)
}

/** 生成失败：未到上限回 queued，达到上限落永久失败；均保留已脱敏详情。 */
function settleGenerationFailure(
  rt: DurableReplyRuntime,
  claim: ClawbotReplyGenerationClaim,
  generating: ClawbotReplyRun,
  result: ClawbotReplyAskResult,
  generation: number,
): void {
  const { deps, durable } = rt
  const reason = result.error ?? '未知原因'
  const failedDetail = failedRunDetail(
    generating.id,
    reason,
    result.errorCode ?? 'generation_failed',
    result,
  )
  rt.telemetry.countGenerationFailed(reason)
  if (generating.attempts >= rt.maxGenerationAttempts) {
    try {
      if (markReplyRunFailedClaimed(durable.dir(), claim, reason, undefined, failedDetail) === null) return
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
        `run=${String(generating.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
      rt.scheduleRun(generating.id, generating.slot, durableBackoffMs(rt, generating.attempts), generation)
    }
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
      `run=${String(generating.id)} stage=generate attempts=${String(generating.attempts)}：${reason}`)
    return
  }
  const next = Date.now() + durableBackoffMs(rt, generating.attempts)
  try {
    if (markReplyRunRetryClaimed(durable.dir(), claim, reason, next, undefined, failedDetail) === null) return
  } catch (e) {
    rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
      `run=${String(generating.id)} stage=mark_retry 失败：${e instanceof Error ? e.message : String(e)}`)
  }
  deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
    `run=${String(generating.id)} stage=generate_retry attempt=${String(generating.attempts)}：${reason}`)
  rt.scheduleRun(generating.id, generating.slot, Math.max(next - Date.now(), 0), generation)
}

/** 在生成 claim 下落永久失败；false = 租约已变或写状态抛错，调用方应立即收手。 */
function failClaimedGeneration(
  rt: DurableReplyRuntime,
  claim: ClawbotReplyGenerationClaim,
  generating: ClawbotReplyRun,
  reason: string,
  detail: string,
  generation: number,
): boolean {
  const { deps, durable } = rt
  try {
    if (markReplyRunFailedClaimed(durable.dir(), claim, reason, undefined, detail) === null) return false
    return true
  } catch (e) {
    rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
      `run=${String(generating.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
    rt.scheduleRun(generating.id, generating.slot, durableBackoffMs(rt, generating.attempts), generation)
    return false
  }
}

async function handleDurableRun(rt: DurableReplyRuntime, runId: number): Promise<void> {
  const state = loadDurableRunForHandling(rt, runId)
  if (state === null) return
  const { deps, durable } = rt
  const { run, parts: outboxParts, cfg, decision, generation } = state

  if (outboxParts.length > 0) {
    await handleExistingParts(rt, state)
    return
  }

  let claim: ClawbotReplyGenerationClaim | null
  try {
    claim = claimReplyRunGeneration(durable.dir(), {
      runId: run.id,
      owner: rt.owner,
      leaseMs: rt.generationLeaseMs,
    })
  } catch (e) {
    rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
      `run=${String(run.id)} stage=claim_generating 失败：${e instanceof Error ? e.message : String(e)}`)
    rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, Math.max(run.attempts, 1)), generation)
    return
  }
  if (claim === null) {
    // 另一个 worker 已领取，或行尚未到下一次可处理时间。
    rt.scheduleRun(run.id, run.slot, Math.max(rt.retryBaseMs, 1_000), generation)
    return
  }
  const generating = claim.run

  if (!decision.should) {
    try {
      const skipped = skipRunDetail(run.id, decision)
      if (markReplyRunSkippedClaimed(durable.dir(), claim, decision.reason, undefined, skipped) === null) return
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} stage=mark_skipped 失败：${e instanceof Error ? e.message : String(e)}`)
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
    }
    return
  }

  if (generating.attempts > rt.maxGenerationAttempts) {
    const reason = `生成尝试已达上限 ${String(rt.maxGenerationAttempts)} 次`
    try {
      const detail = failedRunDetail(run.id, reason, 'generation_attempts_exhausted')
      if (markReplyRunFailedClaimed(durable.dir(), claim, reason, undefined, detail) === null) return
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, generating.attempts), generation)
    }
    return
  }

  const ask = deps.ask
  if (ask === undefined) {
    const reason = 'ask 能力未注入（自动回复不可用）'
    try {
      const detail = failedRunDetail(run.id, reason, 'ask_unavailable')
      if (markReplyRunFailedClaimed(durable.dir(), claim, reason, undefined, detail) === null) return
      rt.telemetry.countGenerationFailed(reason)
    } catch (e) {
      rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
        `run=${String(run.id)} stage=mark_failed 失败：${e instanceof Error ? e.message : String(e)}`)
      rt.scheduleRun(run.id, run.slot, durableBackoffMs(rt, 1), generation)
    }
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(run.slot)}`,
      `run=${String(run.id)} stage=generate ask 能力未注入`)
    return
  }

  rt.telemetry.setStage('generating', generating.slot, generating.id)

  const target: ReplyableMessage = {
    direction: 'in',
    msgType: 'text',
    content: generating.question,
    id: generating.targetMessageId,
  }
  let result: Awaited<ReturnType<ClawbotAskFn>>
  let context: ClawbotAskContext = {}
  const heartbeat = startGenerationLeaseHeartbeat(rt, claim, generation)
  let canCommitResult = false
  try {
    context = await withDeadline(
      Promise.resolve(contextFor(deps, generating.slot, target)),
      rt.askTimeoutMs,
      '自动回复上下文',
      heartbeat.loss,
    )
    if (!rt.telemetry.isActive(generating.slot, generation)) return
    const kbId = decision.kbId
    result = await withDeadline(
      ask(generating.slot, generating.question, kbId, cfg.systemPrompt, context),
      rt.askTimeoutMs,
      '自动回复生成',
      heartbeat.loss,
    )
    canCommitResult = heartbeat.canCommitResult()
  } catch (e) {
    if (heartbeat.lost()) return
    canCommitResult = heartbeat.canCommitResult()
    if (!canCommitResult) return
    result = { ok: false, answer: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    heartbeat.stop()
  }
  if (!canCommitResult) return
  if (heartbeat.lost()) return
  if (!rt.telemetry.isActive(generating.slot, generation)) return
  if (!result.ok) {
    settleGenerationFailure(rt, claim, generating, result, generation)
    return
  }

  const answerDetail = replyRunDetailJson(generating.id, result, {
    status: result.status ?? 'ok',
    sendDecision: result.sendDecision ?? { send: true, detail: `运行状态 ${result.status ?? 'ok'}` },
  })
  const text = truncateReply(result.answer)
  if (text === '') {
    const reason = '模型返回空答案，未发送'
    const detail = mergeReplyRunDetail(answerDetail, generating.id, {
      status: 'failed',
      sendDecision: { send: false, error: reason, errorCode: 'empty_answer' },
      errorCode: 'empty_answer',
      error: reason,
    })
    if (failClaimedGeneration(rt, claim, generating, reason, detail, generation)) {
      rt.telemetry.countGenerationFailed(reason)
    }
    return
  }
  const parts = cfg.splitReply ? splitReplyText(text) : [text]
  if (parts.length === 0) {
    const reason = '回复分段为空，未发送'
    const detail = mergeReplyRunDetail(answerDetail, generating.id, {
      status: 'failed',
      sendDecision: { send: false, error: reason, errorCode: 'empty_parts' },
      errorCode: 'empty_parts',
      error: reason,
    })
    if (failClaimedGeneration(rt, claim, generating, reason, detail, generation)) {
      rt.telemetry.countGenerationFailed(reason)
    }
    return
  }
  let savedParts: ClawbotReplyPart[] | null
  try {
    savedParts = saveReplyPartsClaimed(durable.dir(), claim, parts, undefined, answerDetail)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    rt.telemetry.noteError(reason)
    const next = Date.now() + durableBackoffMs(rt, generating.attempts)
    const detail = mergeReplyRunDetail(answerDetail, generating.id, {
      status: 'failed',
      sendDecision: { send: false, error: reason, errorCode: 'outbox_save_failed' },
      errorCode: 'outbox_save_failed',
      error: reason,
    })
    try {
      if (markReplyRunRetryClaimed(durable.dir(), claim, reason, next, undefined, detail) === null) return
    } catch { /* 保存失败与状态失败同时发生时，恢复器仍会读到原 run */ }
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
      `run=${String(generating.id)} stage=save_outbox_retry attempt=${String(generating.attempts)}：${reason}`)
    rt.scheduleRun(generating.id, generating.slot, Math.max(next - Date.now(), 0), generation)
    return
  }
  if (savedParts === null) return
  rt.telemetry.countGenerationSucceeded()
  let saved: ClawbotReplyRunSnapshot | null
  try {
    saved = readReplyRun(durable.dir(), generating.id)
  } catch (e) {
    rt.telemetry.noteError(e instanceof Error ? e.message : String(e))
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${String(generating.slot)}`,
      `run=${String(generating.id)} stage=read_outbox 失败：${e instanceof Error ? e.message : String(e)}`)
    rt.scheduleRun(generating.id, generating.slot, durableBackoffMs(rt, generating.attempts), generation)
    return
  }
  if (saved === null || saved.parts.length === 0) {
    const reason = 'outbox 落库后读不到分段'
    rt.telemetry.noteError(reason)
    const detail = mergeReplyRunDetail(answerDetail, generating.id, {
      status: 'failed',
      sendDecision: { send: false, error: reason, errorCode: 'outbox_missing' },
      errorCode: 'outbox_missing',
      error: reason,
    })
    failClaimedGeneration(rt, claim, generating, reason, detail, generation)
    return
  }
  await sendDurableParts(rt, saved.run, saved.parts, cfg, generation)
}

/**
 * 自动回复执行器：**全局单飞 + 每实例队列**。
 *
 * 单飞是全局的（同一时刻只有一轮 ask 在跑）：模型调用本来就慢，并发起来只会
 * 让几个号一起变慢，还不好排查；而会话内部的顺序本来就必须串行。
 *
 * 多个实例都有积压时按 slot ring 公平轮转，避免 Map 插入顺序让先到的实例一直饿死其他实例。
 * @param deps - 注入依赖（见 {@link AutoReplyRunnerDeps}）。
 * @returns `consider(slot, candidates)` 与测试用的 `pending()`。
 */
export function createAutoReplyRunner(deps: AutoReplyRunnerDeps): {
  consider: (slot: number, candidates: readonly ReplyableMessage[]) => void
  pending: () => number
  recover: () => void
  discard: (slot: number) => void
  stats: () => AutoReplyRunnerStats
  dispose: () => void
} {
  const configuredDebounce = deps.debounceMs ?? 0
  const debounceMs = Number.isFinite(configuredDebounce) ? Math.max(0, configuredDebounce) : 0
  const debounceQueues = new Map<number, {
    target: ReplyableMessage
    timer: ReturnType<typeof setTimeout> | null
  }>()
  const durable = deps.durable
  const durableDebounceMs = Math.max(
    Math.floor(durable?.debounceMs ?? DEFAULT_REPLY_DEBOUNCE_MS),
    0,
  )
  const slotGenerations = new Map<number, number>()
  const currentGeneration = (slot: number): number => slotGenerations.get(slot) ?? 0
  const durableIntake = new Map<number, { runId: number, targetMessageId: number }>()
  let disposed = false
  let draining = false
  let preferDurable = true
  const telemetry = createAutoReplyTelemetry(() => disposed, currentGeneration)
  const memoryQueue = createMemoryReplyQueue((slot) => {
    const message = `待回复已积压 ${String(MAX_PENDING)} 条，本批丢弃`
    telemetry.countBackpressure(message)
    deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${slot}`, message)
  })

  const durableParts = durable === undefined
    ? null
    : createDurableReplyRuntime(
        deps,
        durable,
        telemetry,
        () => disposed,
        currentGeneration,
        () => { void drain() },
      )
  const runScheduler = durableParts?.scheduler ?? null
  const durableRuntime = durableParts?.runtime ?? null
  const recovery = createAutoReplyRecoveryController(
    durableRuntime,
    telemetry,
    () => disposed,
    currentGeneration,
    () => { void drain() },
    deps.recoverIntervalMs,
  )

  async function drain(): Promise<void> {
    if (draining || disposed) return
    draining = true
    try {
      for (;;) {
        if (disposed) break
        const durableReady = runScheduler?.hasQueued() ?? false
        const memoryReady = memoryQueue.pending() > 0
        if (!durableReady && !memoryReady) break
        const takeDurable = durableReady && (!memoryReady || preferDurable)
        if (takeDurable && runScheduler !== null && durableRuntime !== null) {
          const durableRun = runScheduler.takeNext()
          if (durableRun !== null) {
            preferDurable = false
            try {
              await handleDurableRun(durableRuntime, durableRun.runId)
            } finally {
              runScheduler.finish(durableRun.runId)
              telemetry.clearStage()
            }
            continue
          }
        }
        const next = memoryQueue.takeNext()
        if (next === null) break
        preferDurable = true
        // 配置逐条现读：用户在队列消化期间关掉开关，剩下的就不再回。
        const cfg = deps.readConfig(next.slot)
        if (!decideAutoReply(cfg).should) continue
        await handleMemoryReply(
          deps,
          next.slot,
          next.msg,
          cfg,
          telemetry,
          currentGeneration(next.slot),
        )
        telemetry.clearStage()
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      telemetry.noteError(reason)
      safeOp(deps, 'clawbot', 'clawbot_auto_reply', 'fail', '',
        '自动回复循环异常：' + reason)
      recovery.scheduleAfterError()
    } finally {
      draining = false
      telemetry.clearStage()
    }
  }

  function enqueueDurable(slot: number, target: ReplyableMessage): void {
    if (disposed || durableRuntime === null || target.id === undefined) return
    try {
      const run = enqueueOrMergeReplyRun(durableRuntime.durable.dir(), {
        slot,
        targetMessageId: target.id,
        question: target.content,
        debounceMs: durableDebounceMs,
        maxPending: MAX_PENDING,
      })
      const previous = durableIntake.get(slot)
      if (previous !== undefined && previous.runId === run.id && previous.targetMessageId !== target.id) {
        telemetry.countCoalesced()
      }
      durableIntake.set(slot, { runId: run.id, targetMessageId: target.id })
      if (run.status !== 'done' && run.status !== 'failed' && run.status !== 'skipped') {
        durableRuntime.scheduleRun(
          run.id,
          run.slot,
          Math.max(run.nextAttemptAt - Date.now(), 0),
          currentGeneration(run.slot),
        )
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      telemetry.noteError(reason)
      if (reason.includes('积压')) telemetry.countBackpressure(reason)
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${slot}`,
        '持久化回复 run 失败：' + reason)
    }
  }

  recovery.start()

  return {
    recover(): void {
      if (disposed) return
      recovery.recover()
    },

    discard(slot: number): void {
      if (disposed) return
      const targetSlot = Math.floor(slot)
      if (!Number.isFinite(targetSlot) || targetSlot < 1) return
      slotGenerations.set(targetSlot, currentGeneration(targetSlot) + 1)
      const pendingDebounce = debounceQueues.get(targetSlot)
      if (pendingDebounce?.timer != null) clearTimeout(pendingDebounce.timer)
      debounceQueues.delete(targetSlot)
      memoryQueue.discard(targetSlot)
      runScheduler?.discardSlot(targetSlot)
    },

    consider(slot: number, candidates: readonly ReplyableMessage[]): void {
      if (disposed) return
      const { target, dropped } = pickReplyTarget(candidates)
      if (target === null) return
      let decision: AutoReplyDecision
      try {
        decision = decideAutoReply(deps.readConfig(slot))
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        telemetry.noteError(reason)
        // 配置未知不等于关闭：durable 模式先把 intake 留住，库恢复后再判。
        enqueueDurable(slot, target)
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${slot}`,
          '实例配置读取失败，稍后重试：' + reason)
        return
      }
      if (!decision.should) return
      if (dropped > 0) {
        telemetry.countDropped(dropped)
        deps.op('clawbot', 'clawbot_auto_reply', 'ok', `slot=${slot}`,
          `本批 ${String(candidates.length)} 条，只回最后一条（跳过 ${String(dropped)} 条）`)
      }

      if (durableRuntime !== null && target.id !== undefined) {
        enqueueDurable(slot, target)
        return
      }

      const previous = debounceQueues.get(slot)
      if (previous?.timer != null) clearTimeout(previous.timer)
      if (previous !== undefined) telemetry.countCoalesced()
      if (debounceMs <= 0) {
        if (previous !== undefined) debounceQueues.delete(slot)
        if (memoryQueue.enqueue(slot, target)) void drain()
        return
      }

      const state: {
        target: ReplyableMessage
        timer: ReturnType<typeof setTimeout> | null
      } = { target, timer: null }
      state.timer = setTimeout(() => {
        if (disposed) return
        if (debounceQueues.get(slot) !== state) return
        debounceQueues.delete(slot)
        if (memoryQueue.enqueue(slot, state.target)) void drain()
      }, debounceMs)
      debounceQueues.set(slot, state)
      const timer = state.timer as ReturnType<typeof setTimeout> & { unref?: () => void }
      timer.unref?.()
    },

    pending(): number {
      return disposed ? 0 : memoryQueue.pending() + debounceQueues.size + (runScheduler?.pending() ?? 0)
    },

    stats(): AutoReplyRunnerStats {
      const pending = disposed
        ? 0
        : memoryQueue.pending() + debounceQueues.size + (runScheduler?.pending() ?? 0)
      return telemetry.snapshot(pending)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const pending of debounceQueues.values()) {
        if (pending.timer !== null) clearTimeout(pending.timer)
      }
      debounceQueues.clear()
      memoryQueue.dispose()
      runScheduler?.dispose()
      for (const timer of durableRuntime?.leaseHeartbeats ?? []) clearInterval(timer)
      durableRuntime?.leaseHeartbeats.clear()
      durableIntake.clear()
      slotGenerations.clear()
      recovery.dispose()
      telemetry.reset()
    },
  }
}
