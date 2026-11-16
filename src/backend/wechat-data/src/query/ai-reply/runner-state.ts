/**
 * AI 回复执行期间的租约与状态机持久化。
 *
 * 所有状态写入都通过 revision + lease fence；本模块不生成文本、不投递，
 * 只负责把当前执行安全地推进到下一阶段或保留可恢复锚点。
 */
import {
  readChatAiReplyStateStrict,
  updateChatAiReplyRunStateResult,
} from './config-store.ts'
import { renewChatAiReplyRunClaim } from './lease-store.ts'
import type { ChatAiReplyLease } from './lease-store.ts'
import type {
  ChatAiReplyAnchor,
  ChatAiReplyRecordSnapshot,
  ChatAiReplyScanDeps,
  ChatAiReplyStage,
  ChatAiReplyState,
} from './types.ts'
import {
  cursorOf,
  delay,
  inspectReply,
  isBusyError,
} from './runner-recovery.ts'

export class ChatAiReplyLeaseLostError extends Error {}
export class ChatAiReplyTransientWriteError extends Error {}

export interface ChatAiReplyRunRef {
  revision: number
  anchor: ChatAiReplyAnchor
  sourceRef: string
  lease?: ChatAiReplyLease
  leaseMs: number
  now: () => number
  leaseLost: boolean
  /** 从持久化 generation 快照恢复出的正文；有值时绝不再调用模型。 */
  generatedText?: string
  recordId?: number
  /** 只有 reserveReply 明确返回成功后才允许把 anchor 视为已落库。 */
  reservationMade: boolean
  recordOpen: boolean
  resumed: boolean
  /** pending 创建后设置 revision 已被推进；只收口旧预约，不再生成/投递。 */
  revisionChanged: boolean
  /**
   * 运行期取消信号；只读传递，不落库。
   * 生成器在流式调用期间收到 abort 后应尽快停止并交回部分结果。
   */
  signal?: AbortSignal
}

export function readCurrentChatAiReplyState(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
) {
  return readChatAiReplyStateStrict(
    deps.decryptedDir(),
    state.accountKey,
    state.chatUsername,
    state.chatName,
  )
}

export function notifyChatAiReplyRecordUpdated(
  deps: ChatAiReplyScanDeps,
  state: Pick<ChatAiReplyState, 'accountKey' | 'chatUsername'>,
  recordId: number | undefined,
): void {
  if (recordId === undefined) return
  try {
    deps.onRecordUpdated?.({
      accountKey: state.accountKey,
      chatUsername: state.chatUsername,
      recordId,
    })
  } catch {
    // Event broadcast is best effort; persisted state remains authoritative.
  }
}

export async function requireLiveLease(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<ChatAiReplyLease> {
  if (run.leaseLost || run.lease === undefined) throw new ChatAiReplyLeaseLostError()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let renewed: ChatAiReplyLease | null
    try {
      renewed = renewChatAiReplyRunClaim(
        deps.decryptedDir(),
        state.accountKey,
        state.chatUsername,
        run.revision,
        run.lease,
        { now: run.now(), leaseMs: run.leaseMs },
      )
    } catch (e) {
      if (isBusyError(e)) {
        if (attempt < 3) {
          await delay(10 * attempt)
          continue
        }
        throw new ChatAiReplyTransientWriteError('AI 回复租约续期遇到数据库忙；本次执行延后')
      }
      throw e
    }
    if (renewed === null) {
      run.leaseLost = true
      throw new ChatAiReplyLeaseLostError()
    }
    run.lease = renewed
    return renewed
  }
  throw new ChatAiReplyTransientWriteError('AI 回复租约续期失败；本次执行延后')
}

export async function guardedUpdate(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  patch: Parameters<typeof updateChatAiReplyRunStateResult>[3],
  releaseLease = false,
): Promise<'updated' | 'guard-mismatch' | 'transient'> {
  if (run.leaseLost || run.lease === undefined) return 'guard-mismatch'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const outcome = updateChatAiReplyRunStateResult(
      deps.decryptedDir(),
      state.accountKey,
      state.chatUsername,
      patch,
      { revision: run.revision, lease: run.lease, releaseLease },
    )
    if (outcome !== 'transient') return outcome
    if (attempt < 3) await delay(10 * attempt)
  }
  return 'transient'
}

export async function requireGuardedUpdate(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  patch: Parameters<typeof updateChatAiReplyRunStateResult>[3],
  releaseLease = false,
): Promise<void> {
  const outcome = await guardedUpdate(deps, state, run, patch, releaseLease)
  if (outcome === 'updated') return
  if (outcome === 'guard-mismatch') {
    run.leaseLost = true
    throw new ChatAiReplyLeaseLostError()
  }
  throw new ChatAiReplyTransientWriteError('AI 回复状态写入遇到数据库忙；本次执行延后')
}


export async function settleChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  stage: Extract<ChatAiReplyStage, 'success' | 'failed'>,
  error: string,
  opDetail: string,
): Promise<boolean> {
  if (run.revision <= 0 || run.lease === undefined) return false
  const updated = await guardedUpdate(
    deps,
    state,
    run,
    {
      stage,
      cursor: cursorOf(run.anchor),
      pendingCursor: null,
      pendingSourceRef: null,
      pendingRevision: null,
      generationState: '',
      generationSourceRef: null,
      generationText: null,
      generationRevision: null,
      lastRunAt: Date.now(),
      ...(run.recordId === undefined ? { recordId: null } : { recordId: run.recordId }),
      error,
    },
    true,
  )
  if (updated === 'guard-mismatch') run.leaseLost = true
  if (updated === 'updated') deps.op('chat_ai_reply', stage === 'success', opDetail)
  return updated === 'updated'
}

export async function deferChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  error: string,
  opDetail: string,
  options: {
    stage?: Extract<ChatAiReplyStage, 'failed' | 'waiting_config' | 'dispatching'>
  } = {},
): Promise<boolean> {
  if (run.revision <= 0 || run.lease === undefined) return false
  const stage = options.stage ?? 'failed'
  // 记录尚未到终态：保留 cursor 与 pending 锚点，下一次恢复仍从同一条消息开始。
  const updated = await guardedUpdate(
    deps,
    state,
    run,
    {
      stage,
      pendingCursor: cursorOf(run.anchor),
      pendingSourceRef: run.sourceRef,
      pendingRevision: run.revision,
      lastRunAt: Date.now(),
      ...(run.recordId === undefined ? { recordId: null } : { recordId: run.recordId }),
      error,
    },
    true,
  )
  if (updated === 'guard-mismatch') run.leaseLost = true
  if (updated === 'updated') {
    const repeatedWaitingConfig = stage === 'waiting_config'
      && state.stage === 'waiting_config'
      && state.error === error
    // 待配置不是投递失败。首次进入记录一次普通操作事件，同一原因后续扫描静默。
    if (!repeatedWaitingConfig) deps.op('chat_ai_reply', stage === 'waiting_config', opDetail)
  }
  return updated === 'updated'
}

export async function waitForChatAiReplyConfig(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  error: string,
  opDetail: string,
): Promise<boolean> {
  // 防御：没有正文的预约不能进入「待配置」——那会被界面说成“正文已保存”，
  // 恢复路径也会误以为只差一个地址。空白预约按 no_webhook 收口后仍保留
  // pending 锚点，交给下一拍重新判断。
  const record = run.recordId === undefined ? undefined : await inspectReply(deps, run.recordId)
  if (record?.found === true && (record.text ?? '').trim() === '') {
    await failChatAiReplyReservation(
      deps,
      state,
      run,
      '未匹配到 Webhook，且预约正文为空；已停止本轮等待配置',
      'no_webhook',
    )
    return deferChatAiReplyRun(deps, state, run, error, opDetail)
  }
  return deferChatAiReplyRun(deps, state, run, error, opDetail, {
    stage: 'waiting_config',
  })
}

export async function failChatAiReplyReservation(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  error: string,
  failureKind?: string,
): Promise<ChatAiReplyRecordSnapshot> {
  await requireLiveLease(deps, state, run)
  if (run.recordId === undefined) throw new Error('AI 回复预约记录不存在')
  const recordId = run.recordId
  try {
    await deps.failReply({ id: recordId, error, ...(failureKind === undefined ? {} : { failureKind }) })
  } catch {
    // The runner still reports the original failure in state and operation logs.
  }
  notifyChatAiReplyRecordUpdated(deps, state, recordId)
  return inspectReply(deps, recordId)
}

export async function settleFromRecord(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  record: ChatAiReplyRecordSnapshot,
  fallbackError: string,
): Promise<boolean> {
  if (record.status === 'success') {
    return await settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' recovered success',
    )
  }
  if (record.status === 'failed') {
    return await settleChatAiReplyRun(
      deps,
      state,
      run,
      'failed',
      record.error ?? fallbackError,
      'record=' + String(run.recordId) + ' recovered failed',
    )
  }
  if (record.status === 'queued' || record.status === 'running') {
    // 下游已经明确受理异步任务，AI 生成/落库这一轮可以收口；后续任务失败
    // 由消息列表任务查询同步，不应重新调用模型或再次发送。
    return await settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(run.recordId) + ' downstream accepted',
    )
  }
  if (record.status === 'dispatching' || record.status === 'sent_unconfirmed') {
    // 认领可能发生在 HTTP 之前，无法证明没有发出。这里只收口，绝不自动重发。
    return await settleChatAiReplyRun(
      deps,
      state,
      run,
      'failed',
      '消息记录 ' + String(run.recordId) + ' 的投递结果无法确认，已停止自动重发；请人工核对',
      'record=' + String(run.recordId) + ' recovered uncertain',
    )
  }
  return await deferChatAiReplyRun(
    deps,
    state,
    run,
    fallbackError,
    'record=' + String(run.recordId) + ' retained pending',
  )
}
