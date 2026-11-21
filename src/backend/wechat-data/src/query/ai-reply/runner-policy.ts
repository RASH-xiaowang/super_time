/**
 * 把 AI 队友的发送闸接进回复运行器。
 *
 * 运行器本身仍然负责预约、生成和投递。这里只回答两件事：这一拍要不要先别
 * 调用模型，以及生成完成后要不要改成草稿。测试不注入闸门时，两条都是空操作。
 *
 * @module query/ai-reply/runner-policy
 */
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts'
import type { ChatAiReplyRunRef } from './runner-state.ts'
import { settleChatAiReplyRun } from './runner-state.ts'

const deferLogAt = new Map<string, number>()

/** 同一会话同一原因 10 分钟内只记一次操作日志，避免静默时段把日志刷满。 */
function shouldLogDefer(key: string, now: number): boolean {
  const last = deferLogAt.get(key) ?? 0
  if (now - last < 10 * 60_000) return false
  deferLogAt.set(key, now)
  return true
}

export function resetReplyPolicyLog(): void {
  deferLogAt.clear()
}

/**
 * 生成前拦截。返回 true 表示这一拍到此结束，水位不动，下一拍再看。
 */
export function deferReplyIfBlocked(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  now = Date.now(),
): boolean {
  if (deps.assessOutbound === undefined) return false
  const decision = deps.assessOutbound({
    accountKey: state.accountKey,
    chatUsername: state.chatUsername,
    group: state.chatUsername.endsWith('@chatroom'),
    kbEnabled: state.kbEnabled,
    phase: 'preflight',
  })
  if (decision.action !== 'defer') return false
  const key = state.accountKey + '\u0000' + state.chatUsername + '\u0000' + decision.reason
  if (shouldLogDefer(key, now)) deps.op('chat_ai_reply', true, 'deferred ' + decision.reason)
  return true
}

/**
 * 生成后、出网前。`held` 表示已经收成草稿并推进水位；`blocked` 表示本不该发、
 * 但草稿没写上，调用方不得改走投递。
 */
export async function holdReplyIfRequired(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<'send' | 'held' | 'blocked'> {
  if (deps.assessOutbound === undefined || run.recordId === undefined) return 'send'
  const decision = deps.assessOutbound({
    accountKey: state.accountKey,
    chatUsername: state.chatUsername,
    group: state.chatUsername.endsWith('@chatroom'),
    kbEnabled: state.kbEnabled,
    phase: 'postflight',
  })
  if (decision.action === 'defer') {
    const key = state.accountKey + '\u0000' + state.chatUsername + '\u0000' + decision.reason
    if (shouldLogDefer(key, Date.now())) deps.op('chat_ai_reply', true, 'deferred ' + decision.reason)
    return 'blocked'
  }
  if (decision.action !== 'hold') return 'send'
  if (deps.holdReply === undefined) return 'blocked'
  const held = await deps.holdReply({ id: run.recordId, reason: decision.reason })
  if (!held.ok) return 'blocked'
  const settled = await settleChatAiReplyRun(
    deps,
    state,
    run,
    'success',
    decision.reason,
    'record=' + String(run.recordId) + ' held as draft',
  )
  return settled ? 'held' : 'blocked'
}

/** 出网前问草稿闸。允许发送时才调用传入的投递函数，并记下额度。 */
export async function deliverChatAiReply(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  isCancelled: () => boolean,
  dispatch: (
    deps: ChatAiReplyScanDeps,
    state: ChatAiReplyState,
    run: ChatAiReplyRunRef,
    isCancelled: () => boolean,
  ) => Promise<boolean>,
): Promise<boolean> {
  const outcome = await holdReplyIfRequired(deps, state, run)
  if (outcome === 'held') return true
  if (outcome === 'blocked') return false
  const sent = await dispatch(deps, state, run, isCancelled)
  if (sent) {
    try {
      deps.noteReplySent?.({ accountKey: state.accountKey, chatUsername: state.chatUsername })
    } catch {
      deps.op('chat_ai_reply', false, 'reply budget update failed')
    }
  }
  return sent
}
