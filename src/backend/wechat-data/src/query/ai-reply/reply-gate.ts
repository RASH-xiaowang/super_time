/** Independent automatic-reply safeguards; no global policy/state or budget store. */
import { parseChatAiReplySourceRef } from './segments.ts'
import { readChatAiReplyState } from './config-store.ts'

export function replyNeedsConfirmation(group: boolean, kbEnabled: boolean): boolean {
  return group && kbEnabled
}
export const GROUP_KB_HOLD_REASON = '群聊回复用了知识库，不能在无人确认时发到群里'

/** Recheck current conversation settings on automatic retries. Explicit single resend is separate. */
export function automaticReplyBlock(decryptedDir: string, sourceRef: string | undefined, chatUsername: string): { action: 'hold' | 'defer'; reason: string } | undefined {
  const parsed = parseChatAiReplySourceRef(sourceRef)
  // Preserve the existing source parser/lookup contract; runner owns enabled/revision checks.
  const accountKey = parsed?.accountKey ?? ''
  const chat = parsed?.chatUsername || chatUsername
  if (accountKey === '' || chat === '') return undefined
  const state = readChatAiReplyState(decryptedDir, accountKey, chat)
  return replyNeedsConfirmation(chat.endsWith('@chatroom'), state.kbEnabled)
    ? { action: 'hold', reason: GROUP_KB_HOLD_REASON } : undefined
}
