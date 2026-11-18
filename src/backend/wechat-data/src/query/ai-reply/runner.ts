/**
 * 会话级 AI 回复后台执行器。
 *
 * 触发来自微信实时同步事件与 10s 兜底，不依赖聊天页是否打开。
 * 每个会话单飞；同一条入站消息用 sourceRef 幂等。
 *
 * 具体恢复锚点、租约状态机和生成/投递流水线分别位于
 * runner-recovery.ts、runner-state.ts、runner-pipeline.ts；本文件只保留
 * 对外接口、扫描编排、单会话调度与孤儿预约收口。
 */
import { randomUUID } from 'node:crypto'
import {
  initializeChatAiReplyCursor,
  readEnabledChatAiReplyStates,
} from './config-store.ts'
import {
  CHAT_AI_REPLY_LEASE_MS,
  claimChatAiReplyRun,
  releaseChatAiReplyRunClaim,
  renewChatAiReplyRunClaim,
} from './lease-store.ts'
import type { ChatAiReplyLease } from './lease-store.ts'
import { listPendingAiReplyMessageListRecords } from '../message-list-store.ts'
import type {
  ChatAiReplyAnchor,
  ChatAiReplyScanDeps,
  ChatAiReplyScanResult,
  ChatAiReplyState,
} from './types.ts'
import {
  anchorOf,
  anchorOfRecord,
  conversationProgressedAfter,
  errorText,
  inspectReply,
  isUnfinishedStage,
  isVisibleConversationMessage,
  latestInboundAfterCursor,
  latestMessageCursor,
  latestVisibleMessage,
  loadMessagesForState,
  messageAfterAnchor,
  ownSentSegmentsOf,
  parseSourceRef,
  pendingAnchorOf,
  sourceRefOf,
} from './runner-recovery.ts'
import {
  createChatAiReplyCancellation,
} from './runner-cancel.ts'
import type { ChatAiReplyCancellation } from './runner-cancel.ts'
import {
  createAdmissionLimiter,
} from './runner-admission.ts'
import {
  formatChatAiReplyScanDetail,
  shouldWriteChatAiReplyScanReport,
} from './scan-report.ts'
import type { ChatAiReplyAdmissionLimiter } from './runner-admission.ts'
import {
  type ChatAiReplyRunRef,
  ChatAiReplyLeaseLostError,
  ChatAiReplyTransientWriteError,
  notifyChatAiReplyRecordUpdated,
} from './runner-state.ts'
import {
  CHAT_AI_REPLY_COALESCE_QUIET_MS,
  cancelSupersededBeforeReservation,
  coalesceChatAiReplyRun,
} from './runner-coalesce.ts'
import {
  beginChatAiReplyRun,
  cancelStaleChatAiReplyRun,
  cancelSupersededChatAiReplyRun,
  dispatchChatAiReply,
  failChatAiReplyRun,
  reserveChatAiReplyRun,
  saveAndDispatchChatAiReply,
} from './runner-pipeline.ts'
import {
  regenerateChatAiReplyRecord,
} from './runner-regenerate.ts'
import type { ChatAiReplyRegenerateResult } from './runner-regenerate.ts'

/** Runtime snapshot for diagnostics/tests; cursor intentionally excluded from display. */
export interface ChatAiReplyRunnerSnapshot {
  executing: number
}

export interface ChatAiReplyRunnerOptions {
  /** 测试可注入假时钟；生产默认 Date.now。 */
  now?: () => number
  leaseMs?: number
  /** 0 表示禁用心跳，仅用于确定性的租约接管测试。 */
  heartbeatMs?: number
  /**
   * 同一轮连发的合并静默期（毫秒）；0 关闭合并。
   * 生产默认 900ms：对方连发时等这一轮说完再生成，一条消息一次模型调用。
   */
  coalesceMs?: number
  /** 测试可固定 owner；生产每个 runner 实例自动生成唯一值。 */
  owner?: string
  /** 跨会话同时执行的会话数上限；默认 2，避免一轮扫描同时开太多付费调用。 */
  maxConcurrentSessions?: number
  /** 超出并发上限后的排队上限；默认 8，0 表示本拍直接跳过。 */
  maxQueue?: number
}

async function runOne(
  deps: ChatAiReplyScanDeps,
  inFlight: Map<string, Promise<boolean>>,
  state: ChatAiReplyState,
  anchor: ChatAiReplyAnchor,
  resumed: boolean,
  isCancelled: () => boolean,
  options: {
    owner: string
    now: () => number
    leaseMs: number
    heartbeatMs: number
    coalesceMs: number
    stale: boolean
    canUseLease: () => boolean
    admission: ChatAiReplyAdmissionLimiter
    /** 只上报原因码（计数用），不携带任何聊天内容。 */
    onEvent?: (event: string) => void
  },
): Promise<boolean> {
  const key = state.accountKey + '\u0000' + state.chatUsername
  const existing = inFlight.get(key)
  if (existing !== undefined) return existing
  const initialRun: ChatAiReplyRunRef = {
    revision: 0,
    anchor,
    sourceRef: sourceRefOf(state, anchor),
    leaseMs: options.leaseMs,
    now: options.now,
    leaseLost: false,
    reservationMade: false,
    recordOpen: false,
    resumed,
    revisionChanged: false,
  }
  let activeRun = initialRun
  let claimedLease: ChatAiReplyLease | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancellation: ChatAiReplyCancellation | undefined
  let admitted = false

  // 先登记再启动，避免两个并发 scan 都通过上面的检查。
  const task = Promise.resolve().then(async (): Promise<boolean> => {
    try {
      // 跨会话并发上限先于租约：拿不到槽位时本拍完全不碰数据库。
      admitted = await options.admission.acquire(isCancelled)
      if (!admitted || isCancelled()) return false
      const claimed = claimChatAiReplyRun(
        deps.decryptedDir(),
        state.accountKey,
        state.chatUsername,
        {
          owner: options.owner,
          expected: state,
          now: options.now(),
          leaseMs: options.leaseMs,
        },
      )
      if (claimed === null) {
        options.onEvent?.('lease_miss')
        return false
      }
      claimedLease = claimed
      const started = await beginChatAiReplyRun(
        deps,
        state,
        anchor,
        resumed,
        claimed,
        state.revision,
        {
          leaseMs: options.leaseMs,
          now: options.now,
          stale: options.stale,
        },
      )
      if (started === null) {
        options.onEvent?.('control_changed')
        return false
      }
      activeRun = started
      // 生成期取消：只把判据汇成信号，不在这里写状态或投递。
      cancellation = createChatAiReplyCancellation({
        isCancelled,
        isLeaseLost: () => activeRun.leaseLost,
        hasNewerMessage: async () => {
          let messages: Awaited<ReturnType<ChatAiReplyScanDeps['listMessages']>>
          try {
            messages = await deps.listMessages(state.chatUsername, 80)
          } catch {
            // 读失败按“没有新消息”处理，避免数据库抖动误杀付费调用。
            return false
          }
          return messages.some((message) =>
            message.isSender !== 1
            && isVisibleConversationMessage(message)
            && messageAfterAnchor(message, activeRun.anchor))
        },
      })
      started.signal = cancellation.signal
      if (options.heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          const lease = activeRun.lease
          if (lease === undefined || activeRun.leaseLost || !options.canUseLease()) return
          let renewed: ChatAiReplyLease | null
          try {
            renewed = renewChatAiReplyRunClaim(
              deps.decryptedDir(),
              state.accountKey,
              state.chatUsername,
              activeRun.revision,
              lease,
              { now: activeRun.now(), leaseMs: activeRun.leaseMs },
            )
          } catch {
            // 单次数据库忙不宣告租约丢失；下一拍重试，真正写入仍受 fence 保护。
            return
          }
          if (renewed === null) {
            activeRun.leaseLost = true
            return
          }
          activeRun.lease = renewed
        }, options.heartbeatMs)
        heartbeat.unref?.()
      }
      if (started.revisionChanged) {
        options.onEvent?.('skipped')
        return await cancelSupersededChatAiReplyRun(deps, state, started)
      }
      if (isCancelled()) return false
      if (options.stale) {
        options.onEvent?.('stale_closed')
        return await cancelStaleChatAiReplyRun(deps, state, started)
      }
      // 同一轮连发先合并：等对方说完了再生成，一条消息一次模型调用。
      if (await coalesceChatAiReplyRun(
        deps,
        state,
        started,
        isCancelled,
        options.coalesceMs,
      ) === 'handled') {
        options.onEvent?.('coalesced')
        return false
      }
      if (isCancelled()) return false
      // 预约之前复核：已经被更新消息越过时，不建预约、不留失败记录。
      if (await cancelSupersededBeforeReservation(deps, state, started)) return false
      const reserved = await reserveChatAiReplyRun(deps, state, started)
      if (reserved === 'done') {
        options.onEvent?.('skipped')
        return false
      }
      if (isCancelled()) return false
      if (reserved === 'dispatch') {
        options.onEvent?.('replied')
        return await dispatchChatAiReply(deps, state, started, isCancelled)
      }
      options.onEvent?.('replied')
      return await saveAndDispatchChatAiReply(deps, state, started, isCancelled)
    } catch (e) {
      if (isCancelled()) return false
      if (e instanceof ChatAiReplyTransientWriteError) {
        deps.op('chat_ai_reply', false, e.message)
        return false
      }
      if (activeRun.leaseLost
        || e instanceof ChatAiReplyLeaseLostError
        || activeRun.lease === undefined) {
        if (activeRun.recordId !== undefined) {
          deps.op(
            'chat_ai_reply',
            false,
            'record=' + String(activeRun.recordId) + ' lease lost; stale owner stopped without backfill',
          )
        }
        return false
      }
      return await failChatAiReplyRun(deps, state, activeRun, errorText(e), 'generation_failed')
    } finally {
      cancellation?.stop()
      if (heartbeat !== undefined) clearInterval(heartbeat)
      const lease = activeRun.lease ?? claimedLease
      if (lease !== undefined) {
        releaseChatAiReplyRunClaim(
          deps.decryptedDir(),
          state.accountKey,
          state.chatUsername,
          activeRun.revision > 0 ? activeRun.revision : state.revision,
          lease,
        )
      }
      // 槽位最后释放：租约已归还，下一会话可以从干净的租约开始。
      if (admitted) options.admission.release()
    }
  })
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
}

interface SessionWork {
  anchor: ChatAiReplyAnchor
  resumed: boolean
  /** 恢复对象已被更新的会话消息越过，只收口旧任务，不再生成或投递。 */
  stale: boolean
}

async function workForSession(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  messages: Awaited<ReturnType<ChatAiReplyScanDeps['listMessages']>>,
  recoverOnly: boolean,
): Promise<SessionWork | null> {
  const hasPendingIntent = state.pendingCursor !== undefined || state.pendingSourceRef !== undefined
  const pending = pendingAnchorOf(state, messages)
  if (pending !== null) {
    if (state.pendingRevision === undefined
      || !Number.isSafeInteger(state.pendingRevision)
      || state.pendingRevision <= 0) {
      throw new Error('AI 回复 pendingRevision 缺失、为 0 或非法；已停止本会话自动扫描')
    }
    // 同上：恢复 pending 时也要排除「本批次已发出的分段」，否则分段落库后
    // 第 1 段一发出，下一拍就会把整个 pending 判成过期。
    const own = await ownSentSegmentsOf(deps, state.pendingSourceRef)
    return {
      anchor: pending,
      resumed: true,
      stale: await conversationProgressedAfter(deps, state, pending, messages, own),
    }
  }
  if (hasPendingIntent && state.recordId === undefined) {
    throw new Error('AI 回复恢复锚点损坏；为避免越过未完成消息，已停止本会话自动扫描')
  }

  if (state.recordId !== undefined && (isUnfinishedStage(state.stage) || hasPendingIntent)) {
    const record = await inspectReply(deps, state.recordId)
    if (!record.found) {
      throw new Error('AI 回复记录暂时不可读；为避免越过未完成消息，已停止本会话自动扫描')
    }
    const anchor = anchorOfRecord(state, record, messages)
    if (anchor === null) {
      throw new Error('AI 回复记录缺少可恢复的 sourceRef；已停止本会话自动扫描')
    }
    // 本批次已经发出去的分段会以本机身份回到会话里；它们不是「会话推进」，
    // 必须排除，否则多段回复只发第 1 段就被判过期。
    const own = await ownSentSegmentsOf(deps, record.sourceRef ?? state.pendingSourceRef)
    return {
      anchor,
      resumed: true,
      stale: await conversationProgressedAfter(deps, state, anchor, messages, own),
    }
  }
  if (recoverOnly) return null

  // 首次开启只建立水位；否则会把历史消息整体回一遍。
  if (state.cursor === '') {
    const cursor = latestMessageCursor(messages)
    if (cursor === undefined) return null
    initializeChatAiReplyCursor(
      deps.decryptedDir(),
      state.accountKey,
      state.chatUsername,
      cursor,
      state.revision,
    )
    return null
  }

  const latestVisible = latestVisibleMessage(messages)
  if (latestVisible === undefined) return null

  // 只有对方最后发言才需要自动回复。若最新可视消息是自己（人工或上一条 AI
  // 回复），说明上一轮已经有人回答，绝不能再拿更早的问题补答一次。
  if (latestVisible.isSender === 1) return null

  // 对方连续发送多条时，只回复最新一条；上下文会自然包含前面的同一轮消息。
  // 逐条补答旧消息正是“每次都回复上次问题”的根因。
  const anchor = latestInboundAfterCursor(messages, state.cursor)
  return anchor === undefined
    ? null
    : { anchor, resumed: false, stale: false }
}

async function closeOrphanAiReplyPending(
  deps: ChatAiReplyScanDeps,
  dir: string,
  enabledStates: ChatAiReplyState[],
  errors: string[],
): Promise<number> {
  const enabled = new Set(enabledStates.map((state) => state.accountKey + '\u0000' + state.chatUsername))
  let closed = 0
  for (const record of listPendingAiReplyMessageListRecords(dir)) {
    const ref = parseSourceRef(record.sourceRef)
    if (ref !== null && enabled.has(ref.accountKey + '\u0000' + ref.chatUsername)) continue
    const reason = ref === null
      ? 'AI 回复预约的 sourceRef 无法解析，设置行可能缺失；已安全收口，避免永久生成中'
      : 'AI 回复预约对应的设置行缺失或已关闭；已安全收口，未生成也未出网'
    try {
      const failed = await deps.failReply({ id: record.id, error: reason })
      if (failed.ok) {
        closed += 1
        notifyChatAiReplyRecordUpdated(deps, {
          accountKey: ref?.accountKey ?? '',
          chatUsername: ref?.chatUsername ?? '',
        }, record.id)
        deps.op('chat_ai_reply', false, 'record=' + String(record.id) + ' orphan pending; failed closed')
      }
    } catch (e) {
      if (errors.length < 10) errors.push('孤儿 AI 预约 ' + String(record.id) + '：' + errorText(e))
    }
  }
  return closed
}

export function createChatAiReplyRunner(
  deps: ChatAiReplyScanDeps,
  runnerOptions: ChatAiReplyRunnerOptions = {},
): {
  scan: () => Promise<ChatAiReplyScanResult>
  recover: () => Promise<ChatAiReplyScanResult>
  /** 桌面端显式重跑一条空白失败的记录；会再调用一次模型。 */
  regenerate: (recordId: number, expectedSourceRef: string) => Promise<ChatAiReplyRegenerateResult>
  dispose: () => void
  pending: () => number
  snapshot: () => ChatAiReplyRunnerSnapshot
} {
  const inFlight = new Map<string, Promise<boolean>>()
  let scanQueue: Promise<void> = Promise.resolve()
  let disposed = false
  const now = runnerOptions.now ?? Date.now
  const leaseMs = Number.isSafeInteger(runnerOptions.leaseMs) && (runnerOptions.leaseMs ?? 0) > 0
    ? runnerOptions.leaseMs as number
    : CHAT_AI_REPLY_LEASE_MS
  const heartbeatMs = runnerOptions.heartbeatMs === undefined
    ? Math.max(1, Math.floor(leaseMs / 3))
    : Math.max(0, Math.trunc(runnerOptions.heartbeatMs))
  const coalesceMs = runnerOptions.coalesceMs === undefined
    ? CHAT_AI_REPLY_COALESCE_QUIET_MS
    : Math.max(0, Math.trunc(runnerOptions.coalesceMs))
  const owner = runnerOptions.owner?.trim()
    || 'chat-ai-reply:' + String(process.pid) + ':' + randomUUID()
  const admission = createAdmissionLimiter({
    ...(runnerOptions.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrent: runnerOptions.maxConcurrentSessions }),
    ...(runnerOptions.maxQueue === undefined ? {} : { maxQueue: runnerOptions.maxQueue }),
  })

  let lastDispatchClosureAt = 0
  const performScan = async (recoverOnly: boolean): Promise<ChatAiReplyScanResult> => {
    const empty = (): ChatAiReplyScanResult => ({
      scanned: 0,
      queued: 0,
      created: 0,
      dispatched: 0,
      recovered: 0,
    })
    if (disposed) return empty()
    // 顺带收口上一进程遗留的 dispatching：30 秒节流，避免每拍都写库；
    // 认领进程已死的记录可立即转「已发送·未确认」，不必空等 5 分钟。
    const closureAt = Date.now()
    if (deps.closeInterruptedDispatches !== undefined && closureAt - lastDispatchClosureAt >= 30_000) {
      lastDispatchClosureAt = closureAt
      try {
        const closed = deps.closeInterruptedDispatches()
        if (closed > 0) {
          deps.op('chat_ai_reply_scan', true, 'recovered_dispatches=' + String(closed))
        }
      } catch {
        // 收口失败不能阻断本轮扫描；下一拍再试。
      }
    }
    const dir = deps.decryptedDir()
    const self = deps.selfUsername()
    if (self === '') {
      return { ...empty(), errors: ['无法解析当前账号 wxid'] }
    }
    const errors: string[] = []
    const readEnabledStates = deps.readEnabledStates ?? readEnabledChatAiReplyStates
    const listedResult = readEnabledStates(dir)
    if (!listedResult.ok) {
      return { ...empty(), errors: [listedResult.error] }
    }
    const states = listedResult.states
    let scanned = 0
    let queued = 0
    let recovered = 0
    let settingsReadFailed = false
    // 只统计原因码，扫描结束后最多写一条操作日志（有事实才写、10 分钟去重）。
    const events: Record<string, number> = {}
    for (const listed of listedResult.states) {
      // 群聊与单聊都参与扫描；群聊的触发条件由消息级 `mentionSelf` 把关
      // （只有 @我 的消息才会成为锚点），这里不再按 @chatroom 跳过。
      if (listed.accountKey !== self) continue
      try {
        // 先重新取设置，再按当前 cursor/pending 选择窗口；否则延迟 scan
        // 可能用旧 cursor 截最新一页，把窗口外的积压消息永久越过。
        const currentResult = readEnabledStates(dir)
        if (!currentResult.ok) {
          settingsReadFailed = true
          if (errors.length < 10) {
            errors.push(listed.chatUsername + '：' + currentResult.error)
          }
          continue
        }
        const current = currentResult.states
          .find((candidate) => candidate.accountKey === listed.accountKey
            && candidate.chatUsername === listed.chatUsername)
        if (current === undefined) continue
        // A persisted anchor is only trustworthy when it can still be matched
        // to a real message. Never recover it from state alone.
        const messages = await loadMessagesForState(deps, current, recoverOnly)
        scanned += messages.length
        if (disposed) break
        const work = await workForSession(deps, current, messages, recoverOnly)
        if (work === null) continue
        const key = current.accountKey + '\u0000' + current.chatUsername
        if (!inFlight.has(key)) queued += 1
        if (work.resumed) recovered += 1
        const running = runOne(
          deps,
          inFlight,
          current,
          work.anchor,
          work.resumed,
          () => disposed,
          {
            owner,
            now,
            leaseMs,
            heartbeatMs,
            coalesceMs,
            stale: work.stale,
            canUseLease: () => !disposed,
            admission,
            onEvent: (event) => {
              events[event] = (events[event] ?? 0) + 1
            },
          },
        )
        void running.catch(() => {
          // runOne 自己把失败写入状态；这里只吞掉未处理的 Promise rejection。
        })
      } catch (e) {
        if (errors.length < 10) errors.push(listed.chatUsername + '：' + errorText(e))
      }
    }
    if (!disposed && !settingsReadFailed) {
      await closeOrphanAiReplyPending(deps, dir, states, errors)
    }
    const detail = formatChatAiReplyScanDetail({ ...events, queued, resumed: recovered })
    if (detail !== '' && shouldWriteChatAiReplyScanReport(detail)) {
      deps.op('chat_ai_reply_scan', true, detail)
    }
    return {
      scanned,
      queued,
      // 新建与投递是异步完成的，由 onRecordSaved / onDispatchFinished 广播。
      created: 0,
      dispatched: 0,
      recovered,
      ...(errors.length === 0 ? {} : { errors }),
    }
  }

  const enqueueScan = (recoverOnly: boolean): Promise<ChatAiReplyScanResult> => {
    const run = scanQueue.then(() => performScan(recoverOnly))
    scanQueue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    scan(): Promise<ChatAiReplyScanResult> {
      return enqueueScan(false)
    },
    recover(): Promise<ChatAiReplyScanResult> {
      return enqueueScan(true)
    },
    regenerate(
      recordId: number,
      expectedSourceRef: string,
    ): Promise<ChatAiReplyRegenerateResult> {
      // 与扫描共用同一套 deps/租约；dispose 后不再开始新的付费调用。
      return regenerateChatAiReplyRecord(
        deps,
        {
          owner,
          now,
          leaseMs,
          // 手动重生成是用户明确的一次性动作，不占自动扫描的并发槽位：
          // 否则面板请求会排在后台批扫后面等待；但仍然共用租约、心跳与取消。
          heartbeatMs,
          isCancelled: () => disposed,
        },
        recordId,
        expectedSourceRef,
      )
    },
    dispose(): void {
      disposed = true
      admission.wakeAll(false)
      inFlight.clear()
    },
    pending(): number {
      return inFlight.size
    },
    snapshot(): ChatAiReplyRunnerSnapshot {
      return { executing: inFlight.size }
    },
  }
}
