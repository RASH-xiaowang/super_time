/**
 * 桌面端「重新生成」一条空白失败的 AI 回复。
 *
 * 这是一个**明确再花一次模型钱**的动作，因此守卫比自动扫描更严格：只有整组
 * 从未生成正文、没有附件、没有异步任务、没有发送尝试，且是 24 小时内由
 * superseded / generation_failed / config_changed 收口的失败记录才允许重跑。
 *
 * 执行顺序刻意与自动扫描保持一致：
 *   领租约 → `beginChatAiReplyRun` 建立 pending 锚点 → 把记录 CAS 重置为
 *   pending 空白 → 跳过 reserve 直接 `saveAndDispatchChatAiReply`。
 * 任何一步失败都收口为 failed；租约丢失时不回填记录，避免旧 owner 覆盖新任务。
 */
import { readChatAiReplyStateStrict } from './config-store.ts'
import {
  claimChatAiReplyRun,
  releaseChatAiReplyRunClaim,
  renewChatAiReplyRunClaim,
} from './lease-store.ts'
import type { ChatAiReplyLease } from './lease-store.ts'
import { parseChatAiReplySourceRef } from './segments.ts'
import type {
  ChatAiReplyAnchor,
  ChatAiReplyRecordSnapshot,
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
  ChatAiReplySegmentSnapshot,
  ChatAiReplyState,
} from './types.ts'
import {
  anchorOf,
  conversationProgressedAfter,
  errorText,
  inspectReply,
  isUnfinishedStage,
  isVisibleConversationMessage,
  mergeMessageWindows,
  messageAfterAnchor,
  sourceRefOf,
} from './runner-recovery.ts'
import { createChatAiReplyCancellation } from './runner-cancel.ts'
import {
  type ChatAiReplyRunRef,
  ChatAiReplyLeaseLostError,
  readCurrentChatAiReplyState,
  requireGuardedUpdate,
} from './runner-state.ts'
import {
  beginChatAiReplyRun,
  failChatAiReplyRun,
  saveAndDispatchChatAiReply,
} from './runner-pipeline.ts'

/** 只有 24 小时内创建、且仍可追溯到原始入站消息的记录才值得重跑。 */
const REGENERATE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 允许重新生成的失败分类；空分类与投递失败一律拒绝。 */
const REGENERATE_FAILURE_KINDS = new Set(['superseded', 'generation_failed', 'config_changed'])
const REGENERATE_SEGMENT_WINDOW = 80
const REGENERATE_SEGMENT_BEFORE = 20

export interface ChatAiReplyRegenerateOptions {
  owner: string
  now: () => number
  leaseMs: number
  /** 租约续期间隔；0 关闭（测试/无后台运行时）。 */
  heartbeatMs: number
  /** dispose 后不再开始新的模型调用；已经开始的一轮按正常取消路径收口。 */
  isCancelled: () => boolean
}

export interface ChatAiReplyRegenerateResult {
  ok: boolean
  error?: string
}

/** 从记录的 sourceRef 反查原始入站消息；找不到或身份不一致都拒绝。 */
async function resolveRegenerateAnchor(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  ref: { createTime: number; localId: number; baseSourceRef: string },
): Promise<{ anchor: ChatAiReplyAnchor; messages: ChatAiReplyScanMessage[] }> {
  const windows: Array<Awaited<ReturnType<ChatAiReplyScanDeps['listMessages']>>> = []
  if (deps.listMessagesAtOrBefore !== undefined) {
    windows.push(await deps.listMessagesAtOrBefore(
      state.chatUsername,
      ref.localId,
      REGENERATE_SEGMENT_BEFORE,
    ))
  }
  // 最新一页始终合并进来：它既用于查找锚点，也用于判断会话是否已经推进。
  windows.push(await deps.listMessages(state.chatUsername, REGENERATE_SEGMENT_WINDOW))
  const messages = mergeMessageWindows(...windows)
  const matched = messages.find((message) => message.localId === ref.localId)
  if (matched === undefined) {
    throw new Error('原始消息已不在当前会话窗口中，不能重新生成')
  }
  const anchor = anchorOf(matched)
  if (anchor === null) {
    throw new Error('原始消息不是可重新回复的文本消息，不能重新生成')
  }
  if (anchor.createTime !== ref.createTime || sourceRefOf(state, anchor) !== ref.baseSourceRef) {
    throw new Error('AI 回复记录的 sourceRef 与原始消息不一致，不能重新生成')
  }
  return { anchor, messages }
}

/** 目标记录本身的守卫；整组守卫由分段快照与 store 的 CAS 共同完成。 */
function recordRejectReason(
  record: ChatAiReplyRecordSnapshot,
  now: number,
): string | undefined {
  if (!record.found) return 'AI 回复记录不存在'
  if (record.source !== 'ai_reply') return '目标记录不是 AI 回复来源'
  if (record.status !== 'failed') return '只有生成失败的空白记录可以重新生成'
  if ((record.text ?? '').trim() !== '') return 'AI 回复记录已有正文，不能重新生成'
  if ((record.imageCount ?? 0) > 0) return 'AI 回复记录包含图片，不能重新生成'
  if ((record.jobId ?? '') !== '') return 'AI 回复记录存在异步发送任务，不能重新生成'
  if ((record.attempts ?? 0) !== 0) return 'AI 回复记录已有发送尝试，不能重新生成'
  if (record.failureKind === undefined || !REGENERATE_FAILURE_KINDS.has(record.failureKind)) {
    return 'AI 回复记录的失败分类不允许重新生成'
  }
  const createdAt = record.createdAt ?? 0
  // 与界面口径一致：正好 24 小时即拒绝（界面用 `>=`，这里不能用 `>`）。
  if (createdAt <= 0 || now - createdAt >= REGENERATE_MAX_AGE_MS) {
    return 'AI 回复记录超过 24 小时，不能重新生成'
  }
  return undefined
}

/** 整组分段守卫：只要有一段进过投递或带过内容，就拒绝。 */
function segmentsRejectReason(segments: ChatAiReplySegmentSnapshot[]): string | undefined {
  for (const segment of segments) {
    if (segment.status !== 'pending' && segment.status !== 'failed') {
      return 'AI 回复分组已有发送或受理事实，不能重新生成'
    }
    if (segment.text.trim() !== '') return 'AI 回复分组已有生成正文，不能重新生成'
    if ((segment.imageCount ?? 0) > 0) return 'AI 回复分组包含图片，不能重新生成'
    if ((segment.jobId ?? '') !== '') return 'AI 回复分组存在异步发送任务，不能重新生成'
    if ((segment.attempts ?? 0) !== 0) return 'AI 回复分组已有发送尝试，不能重新生成'
  }
  return undefined
}

/** 校验设置行与账号归属；单聊限制由严格读取的 canonical 解析负责。 */
function readRegenerateState(
  deps: ChatAiReplyScanDeps,
  ref: { accountKey: string; chatUsername: string; baseSourceRef: string },
  recordId: number,
): { state: ChatAiReplyState } | { error: string } {
  const self = deps.selfUsername().trim()
  if (self === '' || ref.accountKey !== self) {
    return { error: 'AI 回复记录不属于当前账号，不能重新生成' }
  }
  const result = readChatAiReplyStateStrict(
    deps.decryptedDir(),
    ref.accountKey,
    ref.chatUsername,
  )
  if (!result.ok) return { error: result.error }
  const state = result.state
  if (!state.enabled) return { error: 'AI 回复已关闭，不能重新生成' }
  if (state.pendingSourceRef !== undefined
    && state.pendingSourceRef !== ''
    && state.pendingSourceRef !== ref.baseSourceRef) {
    return { error: '当前会话还有未完成的 AI 回复任务，请先处理' }
  }
  // record_id 在 success/failed 终态后仍会保留；只有仍处于未完成阶段时才算
  // 「还有未完成的记录」，否则会对同会话更早的失败记录误报。
  if (isUnfinishedStage(state.stage)
    && state.recordId !== undefined
    && state.recordId > 0
    && state.recordId !== recordId) {
    return { error: '当前会话还有未完成的 AI 回复记录，请先处理' }
  }
  return { state }
}

/** 运行结束后的结果判定：记录被删/失败/仍空白都不算重新生成成功。 */
async function resultAfterRegenerate(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  recordId: number,
  completed: boolean,
): Promise<ChatAiReplyRegenerateResult> {
  const after = await inspectReply(deps, recordId)
  if (completed) {
    if (!after.found) {
      return {
        ok: false,
        error: 'AI 回复记录已不存在或已被会话新消息取消，本次重新生成未完成',
      }
    }
    if (after.status === 'failed') {
      return { ok: false, error: after.error ?? 'AI 回复重新生成失败' }
    }
    if (after.status === 'pending' && (after.text ?? '').trim() === '') {
      return { ok: false, error: 'AI 回复尚未生成完成，请稍后重试' }
    }
    return { ok: true }
  }
  if (after.found && after.error !== undefined && after.error !== '') {
    return { ok: false, error: after.error }
  }
  const current = readCurrentChatAiReplyState(deps, state)
  if (current.ok && current.state.error !== undefined && current.state.error !== '') {
    return { ok: false, error: current.state.error }
  }
  return { ok: false, error: 'AI 回复重新生成未完成，请稍后重试' }
}

/**
 * 执行一次桌面端重新生成。
 *
 * 调用方必须已经确认这是用户明确点击的动作；本函数自身仍会完整复核所有守卫，
 * 不信任前端传入的 recordId/sourceRef。
 */
export async function regenerateChatAiReplyRecord(
  deps: ChatAiReplyScanDeps,
  options: ChatAiReplyRegenerateOptions,
  recordId: number,
  expectedSourceRef: string,
): Promise<ChatAiReplyRegenerateResult> {
  if (!Number.isSafeInteger(recordId) || recordId <= 0) {
    return { ok: false, error: 'AI 回复记录 id 无效' }
  }
  const expected = typeof expectedSourceRef === 'string' ? expectedSourceRef.trim() : ''
  const ref = parseChatAiReplySourceRef(expected)
  if (ref === null || ref.segmentIndex !== 1) {
    return { ok: false, error: 'AI 回复 sourceRef 无效' }
  }

  let record: ChatAiReplyRecordSnapshot
  try {
    record = await inspectReply(deps, recordId)
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
  const recordReason = recordRejectReason(record, options.now())
  if (recordReason !== undefined) return { ok: false, error: recordReason }
  if (record.sourceRef !== ref.baseSourceRef) {
    return { ok: false, error: 'AI 回复记录的 sourceRef 与请求不一致，不能重新生成' }
  }

  let stateResult: ReturnType<typeof readRegenerateState>
  try {
    stateResult = readRegenerateState(deps, ref, recordId)
  } catch (e) {
    // 设置读取可能抛（数据库忙/损坏）；对外仍是可重试的失败，不是 Promise reject。
    return { ok: false, error: '读取 AI 回复设置失败：' + errorText(e) }
  }
  if ('error' in stateResult) return { ok: false, error: stateResult.error }
  const state = stateResult.state

  if (deps.listReplySegments !== undefined) {
    let segments: ChatAiReplySegmentSnapshot[]
    try {
      segments = await deps.listReplySegments(ref.baseSourceRef)
    } catch (e) {
      return { ok: false, error: 'AI 回复分组暂时不可读，不能重新生成：' + errorText(e) }
    }
    if (segments.length === 0) {
      return { ok: false, error: 'AI 回复分组暂时不可读，不能重新生成' }
    }
    if (!segments.some((segment) => segment.id === recordId)) {
      return { ok: false, error: 'AI 回复分组与目标记录不一致，不能重新生成' }
    }
    const segmentsReason = segmentsRejectReason(segments)
    if (segmentsReason !== undefined) return { ok: false, error: segmentsReason }
  }

  let resolved: { anchor: ChatAiReplyAnchor; messages: ChatAiReplyScanMessage[] }
  try {
    resolved = await resolveRegenerateAnchor(deps, state, ref)
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
  const anchor = resolved.anchor
  try {
    if (await conversationProgressedAfter(deps, state, anchor, resolved.messages)) {
      return { ok: false, error: '会话已有新的消息，不能重新生成' }
    }
  } catch (e) {
    return { ok: false, error: '无法确认会话是否已有新消息，暂不能重新生成：' + errorText(e) }
  }
  if (options.isCancelled()) {
    return { ok: false, error: 'AI 回复运行器已停止，本次重新生成未开始' }
  }

  let claimed: ChatAiReplyLease | null | undefined
  let run: ChatAiReplyRunRef | null | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancellation: ReturnType<typeof createChatAiReplyCancellation> | undefined
  try {
    claimed = claimChatAiReplyRun(
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
      return {
        ok: false,
        error: '当前会话的 AI 回复任务正在执行或设置已变更，请稍后重试',
      }
    }
    run = await beginChatAiReplyRun(
      deps,
      state,
      anchor,
      true,
      claimed,
      state.revision,
      { leaseMs: options.leaseMs, now: options.now },
    )
    if (run === null) {
      return { ok: false, error: 'AI 回复设置已变更或会话状态已变化，请刷新后重试' }
    }
    // 手动重生成同样可能跑过 60 秒租约窗口；没有心跳会被 10 秒扫描当成过期
    // 租约接管，随后 fail-closed，付费结果白丢。
    if (options.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (run === null || run === undefined || run.leaseLost) return
        const lease = run.lease
        if (lease === undefined) return
        let renewed: ChatAiReplyLease | null
        try {
          renewed = renewChatAiReplyRunClaim(
            deps.decryptedDir(),
            state.accountKey,
            state.chatUsername,
            run.revision,
            lease,
            { now: options.now(), leaseMs: options.leaseMs },
          )
        } catch {
          // 单次数据库忙不宣告租约丢失；真正写入仍受 fence 保护。
          return
        }
        if (renewed === null) {
          run.leaseLost = true
          return
        }
        run.lease = renewed
      }, options.heartbeatMs)
      heartbeat.unref?.()
    }
    // 与自动扫描共用生成期取消判据：会话出现更新的消息/租约丢失/运行器停止
    // 都中止在途模型调用，不再为一个注定作废的结果继续付费。
    cancellation = createChatAiReplyCancellation({
      isCancelled: options.isCancelled,
      isLeaseLost: () => run?.leaseLost === true,
      hasNewerMessage: async () => {
        let messages: Awaited<ReturnType<ChatAiReplyScanDeps['listMessages']>>
        try {
          messages = await deps.listMessages(state.chatUsername, 80)
        } catch {
          return false
        }
        return messages.some((message) =>
          message.isSender !== 1
          && isVisibleConversationMessage(message)
          && messageAfterAnchor(message, anchor))
      },
    })
    run.signal = cancellation.signal
    run.recordId = recordId
    // 先把状态指向目标记录并清掉旧生成快照，再改台账；即使进程在这里退出，
    // 下一拍也只会看到「设置指向一条失败记录」，不会凭空调用模型。
    await requireGuardedUpdate(deps, state, run, {
      stage: 'generating',
      recordId,
      generationState: '',
      generationSourceRef: null,
      generationText: null,
      generationRevision: null,
      error: '',
    })
    if (deps.reopenReply === undefined) {
      throw new Error('当前版本不支持重新生成 AI 回复')
    }
    const reopened = await deps.reopenReply({ id: recordId, sourceRef: ref.baseSourceRef })
    if (!reopened.ok) throw new Error(reopened.error ?? '重新打开 AI 回复记录失败')
    // 与自动路径一致：付费调用前先落 generation intent。崩溃/租约丢失时恢复
    // 路径能识别「已经开始过」，不会把已付费的空白记录当成从未调用而重试。
    await requireGuardedUpdate(deps, state, run, {
      stage: 'generating',
      recordId,
      generationState: 'intent',
      generationSourceRef: run.sourceRef,
      generationText: '',
      generationRevision: run.revision,
      error: '',
    })
    run.reservationMade = true
    run.recordOpen = true
    // 记录已经存在，跳过 reserve；直接走生成、补全与投递流水线。
    const completed = await saveAndDispatchChatAiReply(deps, state, run, options.isCancelled)
    return await resultAfterRegenerate(deps, state, recordId, completed)
  } catch (e) {
    if (run?.leaseLost === true || e instanceof ChatAiReplyLeaseLostError) {
      return {
        ok: false,
        error: 'AI 回复任务租约已失效，本次重新生成未完成；记录不会被回填，请稍后重试',
      }
    }
    const message = errorText(e)
    try {
      if (run !== undefined && run !== null) {
        await failChatAiReplyRun(deps, state, run, message, 'generation_failed')
      }
    } catch {
      // 收口失败时保留原始错误；下一拍扫描会按 pending 锚点 fail-closed。
    }
    return { ok: false, error: message }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    cancellation?.stop()
    if (claimed !== undefined && claimed !== null) {
      releaseChatAiReplyRunClaim(
        deps.decryptedDir(),
        state.accountKey,
        state.chatUsername,
        run?.revision ?? state.revision,
        claimed,
      )
    }
  }
}
