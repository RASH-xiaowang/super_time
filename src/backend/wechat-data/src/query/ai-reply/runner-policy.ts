/** Independent group-KB confirmation barrier; ordinary reply generation remains unchanged. */
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts'
import type { ChatAiReplyRunRef } from './runner-state.ts'
import { settleChatAiReplyRun } from './runner-state.ts'
import { replyNeedsConfirmation, GROUP_KB_HOLD_REASON } from './reply-gate.ts'

export async function holdReplyIfRequired(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<'send' | 'held' | 'blocked'> {
  if (!replyNeedsConfirmation(state.chatUsername.endsWith('@chatroom'), state.kbEnabled)) return 'send'
  if (run.recordId === undefined || deps.holdReply === undefined) return 'blocked'
  const held = await deps.holdReply({ id: run.recordId, reason: GROUP_KB_HOLD_REASON })
  if (!held.ok) return 'blocked'
  const settled = await settleChatAiReplyRun(deps, state, run, 'success', GROUP_KB_HOLD_REASON, 'record=' + String(run.recordId) + ' held as draft')
  return settled ? 'held' : 'blocked'
}

export async function deliverChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean, dispatch: (deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean) => Promise<boolean>): Promise<boolean> {
  if (isCancelled()) return false
  const outcome = await holdReplyIfRequired(deps, state, run)
  if (outcome === 'held') return true
  if (outcome === 'blocked' || isCancelled()) return false
  return dispatch(deps, state, run, isCancelled)
}
