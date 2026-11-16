/**
 * 「消息列表 / 回复投递规则」持久化层的兼容入口。
 *
 * 具体实现按 schema、规则、记录、AI 预约和投递认领拆分；本模块只保留显式
 * 再导出，既避免内部循环依赖，也保持既有调用方无需改 import。
 *
 * @module query/message-list-store
 */
export { MESSAGE_LIST_QUERY_MAX } from './message-list-store-shared.ts'
export {
  ensureMessageListSchema,
  rowToMessageListRecord,
  rowToMessageListRule,
  sanitizeMessageListImages,
} from './message-list-store-schema.ts'
export {
  type EnsureExactMessageListRuleInput,
  type EnsureExactMessageListRuleResult,
  type MessageListRuleScope,
  deleteMessageListRule,
  ensureExactMessageListRule,
  getMessageListRule,
  listMessageListRules,
  matchMessageListRule,
  matchMessageListRuleAt,
  saveMessageListRule,
} from './message-list-store-rules.ts'
export {
  type MessageListRecordCursor,
  type TaskGreetingInput,
  cleanupMessageListAttachmentSpool,
  decodeMessageListCursor,
  deleteMessageListRecords,
  encodeMessageListCursor,
  getMessageListRecord,
  ingestMessageListWebhook,
  insertMessageListRecord,
  insertTaskTriggerGreeting,
  listMessageListRecords,
  pendingMessageListRecordIds,
  referencedStagedAttachmentIds,
} from './message-list-store-records.ts'
export {
  type PendingAiReplyMessageListRecord,
  completeAiReplyMessageListRecord,
  completeAiReplyMessageListRecordSegments,
  dropAiReplyMessageListRecord,
  failAiReplyMessageListSegmentsAfter,
  failAiReplyMessageListRecord,
  insertAiReplyMessageListRecord,
  listAiReplyMessageListSegments,
  listPendingAiReplyMessageListRecords,
  reserveAiReplyMessageListRecord,
} from './message-list-store-ai.ts'
export {
  type MessageListDispatchIntent,
  claimMessageListRecordForDispatch,
  messageListRecordCanBeClaimed,
  recoverInterruptedMessageListDispatches,
  saveMessageListDispatchResult,
  saveMessageListJobResult,
} from './message-list-store-dispatch.ts'
