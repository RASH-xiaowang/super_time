/**
 * AI 回复从预约到投递的执行流水线。
 *
 * 生成、消息列表补全和 Webhook 投递按阶段显式推进；每个阶段在产生副作用
 * 前重新校验租约、设置 revision 与记录状态，避免重复生成或重复出网。
 */
import {
  readChatAiReplyGenerationStrict,
  updateChatAiReplyRunStateResult,
} from './config-store.ts'
import type { ChatAiReplyLease } from './lease-store.ts'
import { normalizeChatAiReplyText } from './context.ts'
import { generateChatAiReply } from './runner-generate.ts'
import {
  CHAT_AI_REPLY_MAX_SEGMENTS,
  segmentLimitForChat,
  splitChatAiReplyText,
} from './segments.ts'
import type {
  ChatAiReplyAnchor,
  ChatAiReplyMessageStatus,
  ChatAiReplyRecordSnapshot,
  ChatAiReplyScanDeps,
  ChatAiReplySegmentSnapshot,
  ChatAiReplyState,
} from './types.ts'
import { FEATHER_MESSAGE_MAX_UTF16 } from '../message-list-store-shared.ts'
import {
  conversationProgressedAfter,
  cursorOf,
  errorText,
  inspectReply,
  isVisibleConversationMessage,
  messageAfterAnchor,
  sourceRefOf,
} from './runner-recovery.ts'
import { STALE_REPLY_REASON, dropOrFailStaleReservation } from './runner-coalesce.ts'
import { queueEntryOf } from './queue-plan.ts'
import { deliverChatAiReply } from './runner-policy.ts'
import {
  type ChatAiReplyRunRef,
  deferChatAiReplyRun,
  failChatAiReplyReservation,
  guardedUpdate,
  notifyChatAiReplyRecordUpdated,
  readCurrentChatAiReplyState,
  requireGuardedUpdate,
  requireLiveLease,
  settleChatAiReplyRun,
  settleFromRecord,
  waitForChatAiReplyConfig,
} from './runner-state.ts'

type SegmentReadResult =
  | { ok: true; segments: ChatAiReplySegmentSnapshot[]; grouped: boolean }
  | { ok: false; error: string }

async function readSegmentsForRun(
  deps: ChatAiReplyScanDeps,
  run: ChatAiReplyRunRef,
  fallback: ChatAiReplyRecordSnapshot,
): Promise<SegmentReadResult> {
  if (deps.listReplySegments === undefined) {
    return {
      ok: true,
      grouped: false,
      segments: [{
        id: run.recordId ?? 0,
        segmentIndex: 1,
        segmentCount: 1,
        status: fallback.status ?? 'pending',
        text: fallback.text ?? '',
        sourceRef: fallback.sourceRef ?? run.sourceRef,
        ...(fallback.error === undefined ? {} : { error: fallback.error }),
        ...(fallback.imageCount === undefined ? {} : { imageCount: fallback.imageCount }),
        ...(fallback.jobId === undefined ? {} : { jobId: fallback.jobId }),
        ...(fallback.attempts === undefined ? {} : { attempts: fallback.attempts }),
        ...(fallback.failureKind === undefined ? {} : { failureKind: fallback.failureKind }),
      }],
    }
  }
  let segments: ChatAiReplySegmentSnapshot[]
  try {
    segments = await deps.listReplySegments(run.sourceRef)
  } catch (e) {
    return { ok: false, error: 'AI 回复分段暂时不可读：' + errorText(e) }
  }
  if (segments.length === 0) {
    return { ok: false, error: 'AI 回复分段记录暂时不可读或不存在' }
  }
  if (segments.length > CHAT_AI_REPLY_MAX_SEGMENTS) {
    return { ok: false, error: 'AI 回复分段数超过安全上限' }
  }
  const count = segments[0]?.segmentCount ?? 0
  if (count !== segments.length
    || segments.some((segment, index) =>
      segment.segmentIndex !== index + 1 || segment.segmentCount !== count)
    || segments[0]?.id !== run.recordId) {
    return { ok: false, error: 'AI 回复分段记录结构不完整，已停止自动发送' }
  }
  return {
    ok: true,
    segments,
    grouped: segments.length > 1,
  }
}

interface SegmentProblem {
  index: number
  error: string
  uncertain: boolean
}

function segmentProblemOf(
  segments: ChatAiReplySegmentSnapshot[],
): SegmentProblem | null {
  for (const segment of segments) {
    if (segment.status === 'dispatching' || segment.status === 'sent_unconfirmed') {
      return {
        index: segment.segmentIndex,
        uncertain: true,
        error: segment.error ?? '消息已进入投递但结果无法确认，请人工核对后处理',
      }
    }
  }
  const failed = segments.find((segment) => segment.status === 'failed')
  return failed === undefined
    ? null
    : {
        index: failed.segmentIndex,
        uncertain: false,
        error: failed.error ?? 'AI 回复分段发送失败',
      }
}

async function failSegmentsAfter(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  segments: ChatAiReplySegmentSnapshot[],
  failedIndex: number,
  error: string,
  failureKind?: string,
): Promise<void> {
  const laterPending = segments.filter((segment) =>
    segment.segmentIndex > failedIndex && segment.status === 'pending')
  if (laterPending.length === 0) return
  const detail = '第 ' + String(failedIndex) + ' 段未发送成功，后续分段已取消：' + error
  try {
    const result = await deps.failReplySegmentsAfter?.({
      sourceRef: run.sourceRef,
      segmentIndex: failedIndex,
      error: detail,
      ...(failureKind === undefined ? {} : { failureKind }),
    })
    if (result !== undefined && !result.ok) {
      deps.op('chat_ai_reply', false, result.error ?? '后续分段失败收口未完成')
    }
  } catch (e) {
    deps.op('chat_ai_reply', false, '后续分段失败收口异常：' + errorText(e))
  }
  for (const segment of laterPending) {
    notifyChatAiReplyRecordUpdated(deps, state, segment.id)
  }
}

function isAcceptedStatus(status: ChatAiReplyMessageStatus): boolean {
  return status === 'success' || status === 'queued' || status === 'running'
}

/**
 * 收口已被会话新消息越过的旧任务。
 *
 * 这里绝不生成或投递：从未生成过正文的预约直接删除（这不是失败，不留失败记录），
 * 其余仍为 pending 的旧预约（含分段）标记失败，防止别的投递入口把旧问题再次发出去；
 * 已成功/已受理的段保留事实并直接收口。
 */
export async function cancelStaleChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<boolean> {
  if (run.recordId === undefined) {
    // 旧状态可能只剩 pending 锚点而丢了 recordId。先按同一 sourceRef 做一次
    // 幂等查询/预约，确保旧台账也被收口；否则后台批次仍可能捡到它。
    await requireLiveLease(deps, state, run)
    const reserved = await deps.reserveReply(reservationInputForRun(state, run))
    if (!reserved.ok || reserved.id === undefined) {
      run.recordOpen = false
      return settleChatAiReplyRun(
        deps,
        state,
        run,
        'failed',
        STALE_REPLY_REASON + '；旧回复台账查询失败，请人工核对',
        'stale reply without reservation',
      )
    }
    run.recordId = reserved.id
    run.reservationMade = true
  }
  let record = await inspectReply(deps, run.recordId)
  if (!record.found) {
    run.recordOpen = false
    return settleChatAiReplyRun(
      deps,
      state,
      run,
      'failed',
      STALE_REPLY_REASON + '；原消息列表记录暂不可读',
      'record=' + String(run.recordId) + ' stale; record unreadable',
    )
  }

  const loaded = await readSegmentsForRun(deps, run, record)
  const segments = loaded.ok ? loaded.segments : undefined
  if (segments !== undefined && segments.every((segment) => isAcceptedStatus(segment.status))) {
    run.recordOpen = false
    return settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' stale but already accepted',
    )
  }

  const pendingSegments = segments?.filter((segment) => segment.status === 'pending') ?? []
  if (record.status === 'pending' || segments === undefined || pendingSegments.length > 0) {
    // 从未生成过正文的预约直接删除（这不是失败）；删不了才退回标失败。
    if (await dropOrFailStaleReservation(deps, state, run, pendingSegments)) return true
    record = await inspectReply(deps, run.recordId)
  }

  if (record.found && record.status === 'pending') {
    run.recordOpen = false
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      STALE_REPLY_REASON + '；旧预约尚未收口，等待下一次重试',
      'record=' + String(run.recordId) + ' stale cancellation retained',
    )
  }
  if (record.found && pendingSegments.length === 0 && isAcceptedStatus(record.status as ChatAiReplyMessageStatus)) {
    run.recordOpen = false
    return settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' stale; accepted record retained',
    )
  }

  run.recordOpen = false
  const uncertain = record.found
    && (record.status === 'dispatching' || record.status === 'sent_unconfirmed')
  const previousError = record.found
    && record.status === 'failed'
    && record.error !== undefined
    && record.error !== ''
    ? '；原记录错误：' + record.error
    : ''
  return settleChatAiReplyRun(
    deps,
    state,
    run,
    'failed',
    STALE_REPLY_REASON + previousError
      + (uncertain ? '；原记录可能已发出，请人工核对' : ''),
    'record=' + String(run.recordId) + ' stale cancelled',
  )
}

async function settleSegmentFailure(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  segments: ChatAiReplySegmentSnapshot[],
  failedIndex: number,
  error: string,
  opDetail: string,
  failureKind?: string,
): Promise<boolean> {
  await failSegmentsAfter(deps, state, run, segments, failedIndex, error, failureKind)
  run.recordOpen = false
  return settleChatAiReplyRun(deps, state, run, 'failed', error, opDetail)
}

export async function beginChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  anchor: ChatAiReplyAnchor,
  resumed: boolean,
  lease: ChatAiReplyLease,
  expectedRevision: number,
  options: { leaseMs: number; now: () => number; stale?: boolean },
): Promise<ChatAiReplyRunRef | null> {
  const initialResult = readCurrentChatAiReplyState(deps, state)
  if (!initialResult.ok) throw new Error(initialResult.error)
  const initial = initialResult.state
  if (!initial.enabled) return null
  if (initial.revision !== expectedRevision) return null
  if (!Number.isSafeInteger(initial.revision) || initial.revision <= 0) {
    throw new Error('AI 回复设置 revision 无效；已停止本会话自动扫描')
  }
  const sourceRef = sourceRefOf(state, anchor)
  const samePending = initial.pendingSourceRef === sourceRef
  if (samePending && (initial.pendingRevision === undefined
    || !Number.isSafeInteger(initial.pendingRevision)
    || initial.pendingRevision <= 0)) {
    throw new Error('AI 回复 pendingRevision 缺失或不合法；已停止本会话自动扫描')
  }
  const pendingRevision = samePending ? initial.pendingRevision : initial.revision
  const revisionChanged = samePending && pendingRevision !== initial.revision
  const stale = options.stale === true
  const patch: Parameters<typeof updateChatAiReplyRunStateResult>[3] = {
    stage: 'generating',
    pendingCursor: cursorOf(anchor),
    pendingSourceRef: sourceRef,
    pendingRevision: initial.revision,
    lastRunAt: Date.now(),
    error: '',
  }
  if (!samePending) {
    patch.recordId = null
    patch.generationState = ''
    patch.generationSourceRef = null
    patch.generationText = null
    patch.generationRevision = null
  }
  const run: ChatAiReplyRunRef = {
    revision: initial.revision,
    anchor,
    sourceRef,
    lease,
    leaseMs: options.leaseMs,
    now: options.now,
    leaseLost: false,
    reservationMade: false,
    ...((samePending || stale) && initial.recordId !== undefined
      ? { recordId: initial.recordId }
      : {}),
    recordOpen: false,
    resumed,
    revisionChanged,
  }
  if (!revisionChanged
    && !stale
    && (await guardedUpdate(deps, state, run, patch)) !== 'updated') return null
  return run
}

function reservationInputForRun(
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Parameters<ChatAiReplyScanDeps['reserveReply']>[0] {
  // 入队规则收在 `queue-plan.ts`：私聊 target=对方（永不发 mention），
  // 群聊 target=提问者（只有批次首条 @ 他）。runner 这里只传原始身份。
  const entry = queueEntryOf({
    chatUsername: state.chatUsername,
    chatName: state.chatName,
    ...(run.anchor.mentionName === undefined ? {} : { mentionName: run.anchor.mentionName }),
    ...(run.anchor.mentionUsername === undefined
      ? {}
      : { mentionUsername: run.anchor.mentionUsername }),
  })
  return {
    chatName: entry.chatName,
    chatUsername: entry.chatUsername,
    targetName: entry.targetName,
    targetUsername: entry.targetUsername,
    // 台账按触发时间倒序展示。若沿用历史消息时间，开启 AI 回复后的
    // pending 记录会被首屏 200 条遮住；原始消息时间仍由 sourceRef 保留。
    triggeredAt: run.now(),
    sourceRef: run.sourceRef,
    note: 'AI 回复 · 生成中',
  }
}

/**
 * 设置 revision 已推进时，旧 pending 只能收口，不能沿用新配置继续生成或投递。
 * 若状态里丢了 recordId，先用 sourceRef 做一次幂等查找再标记失败。
 */
export async function cancelSupersededChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<boolean> {
  const reason = 'AI 回复设置已变更，旧任务已取消；请按当前配置重新触发'
  if (run.recordId === undefined) {
    await requireLiveLease(deps, state, run)
    const reserved = await deps.reserveReply(reservationInputForRun(state, run))
    if (!reserved.ok || reserved.id === undefined) {
      return await deferChatAiReplyRun(deps, state, run, reason, 'superseded; reservation lookup failed')
    }
    run.recordId = reserved.id
    run.reservationMade = true
  }
  let record = await inspectReply(deps, run.recordId)
  if (record.found && record.status === 'pending') {
    record = await failChatAiReplyReservation(deps, state, run, reason, 'config_changed')
  }
  run.recordOpen = false
  if (record.found) {
    return settleFromRecord(
      deps,
      state,
      run,
      record,
      reason,
    )
  }
  return await deferChatAiReplyRun(
    deps,
    state,
    run,
    reason + '；消息列表记录暂时不可读',
    'superseded; record unreadable',
  )
}

export async function reserveChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<'generate' | 'dispatch' | 'done'> {
  await requireLiveLease(deps, state, run)
  const reserved = await deps.reserveReply(reservationInputForRun(state, run))
  if (!reserved.ok || reserved.id === undefined) {
    throw new Error(reserved.error ?? '预约消息列表记录失败')
  }
  run.recordId = reserved.id
  run.reservationMade = true
  const current = await inspectReply(deps, reserved.id)
  const fallback = current.found
    ? current
    : {
        found: true,
        status: reserved.status ?? 'pending',
        text: reserved.text ?? '',
        sourceRef: run.sourceRef,
      }

  try {
    deps.onRecordSaved?.({
      accountKey: state.accountKey,
      chatUsername: state.chatUsername,
      recordId: run.recordId,
      created: reserved.created !== false,
    })
  } catch {
    // 预约已经落库；广播失败只会让界面等下一次定时回源。
  }

  const loaded = await readSegmentsForRun(deps, run, fallback)
  if (!loaded.ok) throw new Error(loaded.error)
  const segments = loaded.segments
  const base = segments[0]
  if (base === undefined) throw new Error('AI 回复预约记录不存在')
  const problem = segmentProblemOf(segments)
  if (problem !== null) {
    const kind = problem.uncertain ? 'unconfirmed' : 'send_failed'
    await failSegmentsAfter(deps, state, run, segments, problem.index, problem.error, kind)
    run.recordOpen = false
    await settleChatAiReplyRun(
      deps,
      state,
      run,
      'failed',
      problem.error,
      'record=' + String(run.recordId) + (problem.uncertain
        ? ' recovered uncertain'
        : ' recovered failed'),
    )
    return 'done'
  }
  if (segments.every((segment) => segment.status === 'success')) {
    run.recordOpen = false
    await settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' duplicate success',
    )
    return 'done'
  }
  if (segments.every((segment) => isAcceptedStatus(segment.status))) {
    run.recordOpen = false
    await settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' downstream accepted',
    )
    return 'done'
  }
  if (segments.some((segment) => segment.status === 'pending'
    && segment.segmentIndex > 1
    && segment.text.trim() === '')) {
    const reason = 'AI 回复分段正文补全不完整；为避免乱序发送，已停止本组投递'
    await failSegmentsAfter(deps, state, run, segments, 1, reason, 'generation_failed')
    run.recordOpen = false
    await settleChatAiReplyRun(
      deps,
      state,
      run,
      'failed',
      reason,
      'record=' + String(run.recordId) + ' incomplete segments; failed closed',
    )
    return 'done'
  }
  if (segments.some((segment) => segment.segmentIndex > 1 && segment.status === 'pending')) {
    run.recordOpen = false
    await requireGuardedUpdate(
      deps,
      state,
      run,
      { stage: 'dispatching', recordId: run.recordId, error: '' },
    )
    return 'dispatch'
  }
  if (base.status === 'pending') {
    if (segments.length > 1 && base.text.trim() === '') {
      const reason = 'AI 回复首段正文为空但分组已存在；为避免乱序发送，已停止本组投递'
      await failSegmentsAfter(deps, state, run, segments, 1, reason, 'generation_failed')
      run.recordOpen = false
      await settleChatAiReplyRun(
        deps,
        state,
        run,
        'failed',
        reason,
        'record=' + String(run.recordId) + ' empty first segment; failed closed',
      )
      return 'done'
    }
    if (base.text.trim() !== '') {
      // 正文已经落库，但进程在预约和投递之间退出。此处只能续投，
      // 不能再次进入生成快照判断，否则会把合法恢复误判为缺少生成意图。
      run.recordOpen = false
      await requireGuardedUpdate(
        deps,
        state,
        run,
        { stage: 'dispatching', recordId: run.recordId, error: '' },
      )
      return 'dispatch'
    }
    const generationResult = readChatAiReplyGenerationStrict(
      deps.decryptedDir(),
      state.accountKey,
      state.chatUsername,
    )
    if (!generationResult.ok) throw new Error(generationResult.error)
    const generation = generationResult.generation
    if (generation !== undefined
      && generation.sourceRef === run.sourceRef
      && generation.revision === run.revision) {
      if (generation.state === 'result' && generation.text.trim() !== '') {
        run.generatedText = generation.text
        run.recordOpen = true
        return 'generate'
      }
      if (generation.state === 'intent') {
        const reason = 'AI 回复模型生成已开始但没有可恢复结果；为避免重复生成，已 fail-closed，等待人工重新触发'
        const failed = await failChatAiReplyReservation(deps, state, run, reason, 'generation_failed')
        deps.op('chat_ai_reply', false, 'record=' + String(run.recordId) + ' interrupted generation; failed closed')
        await settleFromRecord(deps, state, run, failed, reason)
        return 'done'
      }
      const reason = 'AI 回复生成快照不完整；为避免重复生成，已 fail-closed'
      const failed = await failChatAiReplyReservation(deps, state, run, reason, 'generation_failed')
      deps.op('chat_ai_reply', false, 'record=' + String(run.recordId) + ' invalid generation snapshot; failed closed')
      await settleFromRecord(deps, state, run, failed, reason)
      return 'done'
    }
    // A record that was already present before this run has no durable
    // generation intent. It is a legacy/unknown window: never guess whether
    // the model was called, fail closed instead of paying for a second call.
    if (reserved.created === false) {
      const reason = 'AI 回复预约缺少生成意图；无法证明模型是否已执行，已 fail-closed'
      const failed = await failChatAiReplyReservation(deps, state, run, reason, 'generation_failed')
      deps.op('chat_ai_reply', false, 'record=' + String(run.recordId) + ' legacy blank pending; failed closed')
      await settleFromRecord(deps, state, run, failed, reason)
      return 'done'
    }
    run.recordOpen = true
    await requireGuardedUpdate(
      deps,
      state,
      run,
      {
        stage: 'generating',
        recordId: run.recordId,
        generationState: 'intent',
        generationSourceRef: run.sourceRef,
        generationText: '',
        generationRevision: run.revision,
        error: '',
      },
    )
    return 'generate'
  }
  if (isAcceptedStatus(base.status)) {
    // 前一段已受理但后续仍有 pending 时，交给 dispatch 逻辑等待其终态，
    // 绝不能在这里误把整组标记成功而越过后续分段。
    run.recordOpen = false
    await requireGuardedUpdate(
      deps,
      state,
      run,
      { stage: 'dispatching', recordId: run.recordId, error: '' },
    )
    return 'dispatch'
  }
  throw new Error('消息列表返回了无法识别的 AI 回复状态')
}

/**
 * 生成被取消后的收口。
 *
 * 取消不是失败：模型已经流出的部分正文先写进 generation 快照（绝不补全消息
 * 列表、绝不投递），再按原因收口——会话已被新消息越过走 stale，设置 revision
 * 变了走 superseded；租约丢失时没有写入资格，直接结束本次执行。
 */
async function cancelAbortedChatAiReplyGeneration(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  text: string,
): Promise<boolean> {
  if (run.leaseLost || run.lease === undefined) return false
  const partial = text.trim()
  if (partial !== '') {
    const persisted = await guardedUpdate(deps, state, run, {
      stage: 'saving',
      generationState: 'result',
      generationSourceRef: run.sourceRef,
      generationText: partial,
      generationRevision: run.revision,
      // 部分正文只作本次执行内的诊断快照；收口时按既有语义清空，绝不补全或投递。
      error: 'AI 回复生成已取消；本次结果不会发送',
    })
    if (persisted === 'guard-mismatch') {
      run.leaseLost = true
      return false
    }
    if (persisted !== 'updated') return false
    run.generatedText = partial
  }
  const currentResult = readCurrentChatAiReplyState(deps, state)
  if (!currentResult.ok) return false
  const current = currentResult.state
  if (!current.enabled || current.revision !== run.revision) {
    return await cancelSupersededChatAiReplyRun(deps, state, run)
  }
  try {
    if (await conversationProgressedAfter(deps, state, run.anchor)) {
      return await cancelStaleChatAiReplyRun(deps, state, run)
    }
  } catch {
    // 读不到新消息时保留生成快照与 pending 锚点，下一拍再收口；本拍不投递。
    return false
  }
  // 轻量/测试适配器可能没注入 listMessagesAfter；最新一页同样能证明会话推进。
  try {
    const latest = await deps.listMessages(state.chatUsername, 80)
    if (latest.some((message) =>
      message.isSender !== 1
      && isVisibleConversationMessage(message)
      && messageAfterAnchor(message, run.anchor))) {
      return await cancelStaleChatAiReplyRun(deps, state, run)
    }
  } catch {
    return false
  }
  // dispose 导致的取消没有会话推进可收口：保留快照等重启恢复，本拍不投递。
  return false
}

export async function dispatchChatAiReply(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (isCancelled()) return false
  if (run.recordId === undefined) throw new Error('AI 回复预约记录不存在')
  const baseRecordId = run.recordId
  const before = await inspectReply(deps, baseRecordId)
  if (!before.found) {
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      '消息列表记录暂时不可读，保留待恢复锚点',
      'record=' + String(baseRecordId) + ' inspect missing',
    )
  }
  const loaded = await readSegmentsForRun(deps, run, before)
  if (!loaded.ok) {
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      loaded.error + '；投递已暂缓，等待记录恢复可读',
      'record=' + String(baseRecordId) + ' segments unreadable; dispatch retained',
    )
  }
  let segments = loaded.segments

  if (segments.every((segment) => segment.status === 'pending')) {
    try {
      if (await conversationProgressedAfter(deps, state, run.anchor)) {
        return await cancelStaleChatAiReplyRun(deps, state, run)
      }
    } catch (e) {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        '无法确认会话是否已有新消息，投递已暂缓：' + errorText(e),
        'record=' + String(baseRecordId) + ' conversation check failed before dispatch',
        { stage: 'dispatching' },
      )
    }
  }

  const fail = async (problem: SegmentProblem): Promise<boolean> => {
    const prefix = problem.uncertain ? '投递结果无法确认：' : '分段发送失败：'
    return settleSegmentFailure(
      deps,
      state,
      run,
      segments,
      problem.index,
      prefix + problem.error,
      'record=' + String(baseRecordId) + ' segment '
        + String(problem.index) + (problem.uncertain ? ' uncertain' : ' failed'),
      problem.uncertain ? 'unconfirmed' : 'send_failed',
    )
  }
  while (true) {
    if (isCancelled()) return false
    const problem = segmentProblemOf(segments)
    if (problem !== null) return fail(problem)
    const unfinished = segments.find((segment) => segment.status !== 'success')
    if (unfinished === undefined) {
      return await settleChatAiReplyRun(
        deps,
        state,
        run,
        'success',
        '',
        'record=' + String(baseRecordId) + ' all segments dispatched',
      )
    }
    if (segments.every((segment) => isAcceptedStatus(segment.status))) {
      return await settleChatAiReplyRun(
        deps,
        state,
        run,
        'success',
        '',
        'record=' + String(baseRecordId) + ' downstream accepted all segments',
      )
    }
    if (unfinished.status === 'queued' || unfinished.status === 'running') {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        '前一分段正在下游异步发送，后续分段等待其完成后再按顺序发送',
        'record=' + String(baseRecordId) + ' waiting downstream segment order',
        { stage: 'dispatching' },
      )
    }
    if (unfinished.status !== 'pending') {
      throw new Error('AI 回复分段返回了无法识别的状态')
    }
    if (unfinished.text.trim() === '') {
      throw new Error('AI 回复第 ' + String(unfinished.segmentIndex) + ' 段正文为空，拒绝投递')
    }

    const currentResult = readCurrentChatAiReplyState(deps, state)
    if (!currentResult.ok) {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        currentResult.error + '；投递已暂缓，等待设置恢复可读',
        'record=' + String(baseRecordId) + ' settings unreadable; dispatch retained',
      )
    }
    const current = currentResult.state
    if (!current.enabled || current.revision !== run.revision) {
      const reason = 'AI 回复已关闭或设置已变更，本次投递已取消'
      await failChatAiReplyReservation(deps, state, run, reason, 'config_changed')
      return await settleChatAiReplyRun(
        deps,
        state,
        run,
        'failed',
        reason,
        'record=' + String(baseRecordId) + ' superseded before segment dispatch',
      )
    }
    await requireGuardedUpdate(
      deps,
      state,
      run,
      { stage: 'dispatching', recordId: baseRecordId, error: '' },
    )
    await requireLiveLease(deps, state, run)
    if (isCancelled()) return false

    let dispatched: Awaited<ReturnType<ChatAiReplyScanDeps['dispatchReply']>>
    try {
      dispatched = await deps.dispatchReply(unfinished.id)
    } catch (e) {
      const latest = await inspectReply(deps, unfinished.id)
      if (latest.found && latest.status !== undefined && isAcceptedStatus(latest.status)) {
        // HTTP 已受理但调用在回写/返回前中断。消息列表是事实源：
        // 按已受理状态继续等待或推进，不能再把同一段自动重发。
        segments = segments.map((segment) => segment.id === unfinished.id
          ? { ...segment, status: latest.status ?? segment.status }
          : segment)
        continue
      }
      if (latest.found && latest.status === 'failed') {
        segments = segments.map((segment) => segment.id === unfinished.id
          ? { ...segment, status: 'failed', ...(latest.error === undefined ? {} : { error: latest.error }) }
          : segment)
        return fail({
          index: unfinished.segmentIndex,
          uncertain: false,
          error: latest.error ?? errorText(e),
        })
      }
      if (latest.found
        && (latest.status === 'dispatching' || latest.status === 'sent_unconfirmed')) {
        segments = segments.map((segment) => segment.id === unfinished.id
          ? { ...segment, status: latest.status ?? 'sent_unconfirmed' }
          : segment)
        return fail({
          index: unfinished.segmentIndex,
          uncertain: true,
          error: latest.error ?? errorText(e),
        })
      }
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        '已写入消息列表（记录 ' + String(unfinished.id) + '），但投递异常：' + errorText(e),
        'record=' + String(unfinished.id) + ' dispatch exception; retained for recovery',
      )
    }

    try {
      deps.onDispatchFinished?.({
        accountKey: state.accountKey,
        chatUsername: state.chatUsername,
        recordId: unfinished.id,
        ok: dispatched.ok,
      })
    } catch {
      // 投递结果广播不能改变已经发生的投递事实。
    }

    const latest = await inspectReply(deps, unfinished.id)
    if (dispatched.ok && (!latest.found || latest.status === 'pending')) {
      // 轻量 dispatcher 可能只返回成功、不写库；按成功推进，真实实现仍以台账为准。
      segments = segments.map((segment) => segment.id === unfinished.id
        ? { ...segment, status: 'success' }
        : segment)
      continue
    }
    const missingWebhook = dispatched.reason === 'missing_webhook'
      || (latest.found
        && latest.status === 'pending'
        && /未匹配到 Webhook/.test(dispatched.error ?? latest.error ?? ''))
    if (missingWebhook) {
      return await waitForChatAiReplyConfig(
        deps,
        state,
        run,
        '未匹配到 Webhook：请先在消息列表规则中为「'
          + (state.chatName || state.chatUsername)
          + '」配置发送地址；记录已保留，配置后会自动继续',
        'record=' + String(unfinished.id) + ' waiting for webhook configuration',
      )
    }
    if (dispatched.ok && latest.found && isAcceptedStatus(latest.status ?? 'pending')) {
      const nextStatus = latest.status ?? 'success'
      segments = segments.map((segment) => segment.id === unfinished.id
        ? { ...segment, status: nextStatus }
        : segment)
      if (nextStatus === 'queued' || nextStatus === 'running') {
        return await deferChatAiReplyRun(
          deps,
          state,
          run,
          '当前分段已提交下游异步任务，后续分段等待其完成后再发送',
          'record=' + String(unfinished.id) + ' downstream accepted; ordering retained',
          { stage: 'dispatching' },
        )
      }
      continue
    }
    if (latest.found && (latest.status === 'failed'
      || latest.status === 'dispatching'
      || latest.status === 'sent_unconfirmed')) {
      const uncertain = latest.status !== 'failed'
      segments = segments.map((segment) => segment.id === unfinished.id
        ? { ...segment, status: latest.status ?? 'failed',
            ...(latest.error === undefined ? {} : { error: latest.error }) }
        : segment)
      return fail({
        index: unfinished.segmentIndex,
        uncertain,
        error: latest.error ?? dispatched.error ?? '投递失败',
      })
    }
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      dispatched.error === undefined
        ? '投递未形成终态，保留记录等待下一次恢复'
        : '已写入消息列表（记录 ' + String(unfinished.id) + '），但投递失败：' + dispatched.error,
      'record=' + String(unfinished.id) + ' dispatch pending',
    )
  }
}

export async function saveAndDispatchChatAiReply(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (run.recordId === undefined) throw new Error('AI 回复预约记录不存在')
  try {
    if (await conversationProgressedAfter(deps, state, run.anchor)) {
      return await cancelStaleChatAiReplyRun(deps, state, run)
    }
  } catch (e) {
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      '无法确认会话是否已有新消息，本轮生成已暂缓：' + errorText(e),
      'record=' + String(run.recordId) + ' conversation check failed before generation',
    )
  }
  const generated = run.generatedText !== undefined
    ? { text: run.generatedText, canceled: false }
    : await generateChatAiReply(deps, state, run)
  const text = generated.text
  // 取消绝不进入补全/投递：已流出的部分正文只进生成快照，然后按原因收口。
  if (generated.canceled) {
    return await cancelAbortedChatAiReplyGeneration(deps, state, run, text)
  }
  if (isCancelled()) {
    const persisted = await guardedUpdate(
      deps,
      state,
      run,
      {
        stage: 'saving',
        generationState: 'result',
        generationSourceRef: run.sourceRef,
        generationText: text,
        generationRevision: run.revision,
        error: 'AI 回复运行器已停止；生成结果已保留，等待重启恢复',
      },
    )
    if (persisted === 'updated') run.generatedText = text
    return false
  }
  const currentResult = readCurrentChatAiReplyState(deps, state)
  if (!currentResult.ok) {
    const persisted = await guardedUpdate(
      deps,
      state,
      run,
      {
        stage: 'saving',
        generationState: 'result',
        generationSourceRef: run.sourceRef,
        generationText: text,
        generationRevision: run.revision,
      },
    )
    if (persisted !== 'updated') return false
    run.generatedText = text
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      currentResult.error + '；生成结果已保留，等待设置恢复可读',
      'record=' + String(run.recordId) + ' settings unreadable; generation retained',
    )
  }
  const current = currentResult.state
  if (!current.enabled || current.revision !== run.revision) {
    await failChatAiReplyReservation(
      deps,
      state,
      run,
      'AI 回复已关闭或设置已变更，本次生成已取消',
      'config_changed',
    )
    run.recordOpen = false
    deps.op('chat_ai_reply', false, 'record=' + String(run.recordId) + ' switch changed; generation cancelled')
    return false
  }
  await requireGuardedUpdate(
    deps,
    state,
    run,
    {
      stage: 'saving',
      generationState: 'result',
      generationSourceRef: run.sourceRef,
      generationText: text,
      generationRevision: run.revision,
    },
  )
  run.generatedText = text
  await requireLiveLease(deps, state, run)
  const planned = current.splitReply
    ? splitChatAiReplyText(text, segmentLimitForChat(state.chatUsername))
    : [normalizeChatAiReplyText(text, FEATHER_MESSAGE_MAX_UTF16)]
  const plannedSegments = planned.filter((segment) => segment.trim() !== '')
  if (plannedSegments.length === 0) throw new Error('模型没有返回可用回复')

  let materialized = false
  let materializedSegments: ChatAiReplySegmentSnapshot[] = []
  if (current.splitReply
    && plannedSegments.length > 1
    && deps.completeReplySegments !== undefined) {
    const completed = await deps.completeReplySegments({
      id: run.recordId,
      segments: plannedSegments,
      note: 'AI 回复 · 自动生成',
    })
    if (completed.ok && completed.segments !== undefined) {
      materializedSegments = completed.segments
      materialized = materializedSegments.length === plannedSegments.length
        && materializedSegments.every((segment, index) =>
          segment.text === plannedSegments[index])
    }
    if (!materialized) {
      // 返回值丢失时按 sourceRef 回查完整分组，避免重复生成或只发送首段。
      const latest = await inspectReply(deps, run.recordId)
      const reread = await readSegmentsForRun(deps, run, latest.found
        ? latest
        : { found: true, status: 'pending', text: plannedSegments[0] ?? '', sourceRef: run.sourceRef })
      materialized = reread.ok
        && reread.segments.length === plannedSegments.length
        && reread.segments.every((segment, index) => segment.text === plannedSegments[index])
      if (materialized && reread.ok) materializedSegments = reread.segments
    }
    if (!materialized) {
      throw new Error(completed.error ?? 'AI 回复分段补全消息列表失败')
    }
  } else {
    const singleText = current.splitReply && plannedSegments.length > 1
      ? normalizeChatAiReplyText(plannedSegments.join('\n\n'), FEATHER_MESSAGE_MAX_UTF16)
      : (plannedSegments[0] ?? '')
    if (current.splitReply && plannedSegments.length > 1) {
      deps.op(
        'chat_ai_reply',
        false,
        '分段能力不可用，已将长回复降级为单条发送',
      )
    }
    const completed = await deps.completeReply({
      id: run.recordId,
      text: singleText,
      note: 'AI 回复 · 自动生成',
    })
    if (!completed.ok) {
      const latest = await inspectReply(deps, run.recordId)
      if (!(latest.found && latest.status === 'pending' && (latest.text ?? '').trim() !== '')) {
        throw new Error(completed.error ?? '补全消息列表记录失败')
      }
      // 补全已经落库但返回值丢失：按「有正文 pending」继续补投，绝不再次生成。
    }
  }
  run.recordOpen = false
  notifyChatAiReplyRecordUpdated(deps, state, run.recordId)
  for (const segment of materializedSegments) {
    if (segment.id !== run.recordId) notifyChatAiReplyRecordUpdated(deps, state, segment.id)
  }
  await requireGuardedUpdate(
    deps,
    state,
    run,
    { stage: 'dispatching', recordId: run.recordId, error: '' },
  )
  if (isCancelled()) return false
  const beforeDispatchResult = readCurrentChatAiReplyState(deps, state)
  if (!beforeDispatchResult.ok) {
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      beforeDispatchResult.error + '；投递已暂缓，等待设置恢复可读',
      'record=' + String(run.recordId) + ' settings unreadable before dispatch',
    )
  }
  const beforeDispatch = beforeDispatchResult.state
  if (!beforeDispatch.enabled || beforeDispatch.revision !== run.revision) {
    await failChatAiReplyReservation(deps, state, run, 'AI 回复设置已变更，已取消投递', 'config_changed')
    deps.op('chat_ai_reply', false, 'record=' + String(run.recordId) + ' switch changed; dispatch skipped')
    return false
  }
  return deliverChatAiReply(deps, state, run, isCancelled, dispatchChatAiReply)
}

export async function failChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  error: string,
  failureKind?: string,
): Promise<boolean> {
  if (!run.reservationMade || run.recordId === undefined) {
    // 预约本身失败：没有消息列表记录，不能推进水位；保留 pending 锚点供下一拍重试。
    await deferChatAiReplyRun(deps, state, run, error, 'reservation failed; retained for retry')
    return false
  }
  let record = await inspectReply(deps, run.recordId)
  const loaded = await readSegmentsForRun(deps, run, record)
  if (loaded.ok) {
    const problem = segmentProblemOf(loaded.segments)
    if (problem !== null) {
      return await settleSegmentFailure(
        deps,
        state,
        run,
        loaded.segments,
        problem.index,
        problem.error,
        'record=' + String(run.recordId) + ' segment recovered failed',
        problem.uncertain ? 'unconfirmed' : 'send_failed',
      )
    }
    if (loaded.segments.every((segment) => isAcceptedStatus(segment.status))) {
      return await settleChatAiReplyRun(
        deps,
        state,
        run,
        'success',
        '',
        'record=' + String(run.recordId) + ' recovered accepted segments',
      )
    }
    const pending = loaded.segments.filter((segment) => segment.status === 'pending')
    const hasLaterPending = pending.some((segment) => segment.segmentIndex > 1)
    if (hasLaterPending && pending.some((segment) => segment.segmentIndex > 1
      && segment.text.trim() === '')) {
      const reason = 'AI 回复分段正文补全不完整；为避免乱序发送，已停止本组投递'
      return await settleSegmentFailure(
        deps,
        state,
        run,
        loaded.segments,
        1,
        reason,
        'record=' + String(run.recordId) + ' incomplete segments; failed closed',
        'generation_failed',
      )
    }
    if (hasLaterPending
      || loaded.segments.some((segment) => segment.status === 'pending'
        && segment.text.trim() !== '')) {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        error,
        'record=' + String(run.recordId) + ' generated segments; retained for dispatch recovery',
      )
    }
  }
  if (record.found && record.status === 'pending' && (record.text ?? '').trim() !== '') {
    // 正文已经保存，只有生成之后的步骤失败。保留 pending 正文可直接补投，不重跑模型。
    return await deferChatAiReplyRun(
      deps,
      state,
      run,
      error,
      'record=' + String(run.recordId) + ' generated; retained for dispatch recovery',
    )
  }
  if (record.found && record.status === 'pending' && (record.text ?? '').trim() === '') {
    const generationResult = readChatAiReplyGenerationStrict(
      deps.decryptedDir(),
      state.accountKey,
      state.chatUsername,
    )
    if (!generationResult.ok) {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        generationResult.error + '；保留待恢复锚点',
        'record=' + String(run.recordId) + ' generation snapshot unreadable; retained',
      )
    }
    const generation = generationResult.generation
    if (generation !== undefined
      && generation.state === 'result'
      && generation.sourceRef === run.sourceRef
      && generation.revision === run.revision
      && generation.text.trim() !== '') {
      return await deferChatAiReplyRun(
        deps,
        state,
        run,
        error,
        'record=' + String(run.recordId) + ' generated result persisted; retained for materialization',
      )
    }
  }
  if (record.found && record.status === 'pending' && run.recordOpen) {
    record = await failChatAiReplyReservation(deps, state, run, error, failureKind)
  }
  return settleFromRecord(deps, state, run, record, error)
}
