/**
 * 消息列表 / 回复投递规则的取数与写入口。
 *
 * 读列表不缓存：后台任务扫描与局域网 Webhook 会持续写入；写操作成功后广播
 * `dsh-wechat-message-list-updated`，记录页与规则页各自回源。
 */
import type {
  MessageListAttachmentStageInput,
  MessageListAttachmentStageResult,
  MessageListBatchDeleteResult,
  MessageListBatchResendResult,
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListWebhookInfo,
  MessageListWebhookJob,
  MessageListWebhookPayload,
  MessageListWebhookProbe,
} from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'
import { notifyMessageListUpdated } from './message-list-events.ts'

export async function apiListMessageListRecords(query?: MessageListQuery): Promise<MessageListSnapshot> {
  return unwrap(await remote().listMessageListRecords(query))
}

export async function apiListMessageListRules(): Promise<MessageListRuleSnapshot> {
  return unwrap(await remote().listMessageListRules())
}

export async function apiSaveMessageListRule(options: MessageListRuleInput): Promise<MessageListMutationResult> {
  const result = unwrap(await remote().saveMessageListRule(options))
  if (result.ok) notifyMessageListUpdated()
  return result
}

export async function apiDeleteMessageListRule(options: { id: number }): Promise<MessageListMutationResult> {
  const result = unwrap(await remote().deleteMessageListRule(options))
  if (result.ok) notifyMessageListUpdated()
  return result
}

export async function apiInsertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult> {
  const result = unwrap(await remote().insertMessageListRecord(options))
  notifyMessageListUpdated()
  return result
}

/** 桌面端选择文件后调用；只返回随机资源引用，不把本机路径写入记录。 */
export async function apiStageMessageListAttachment(
  options: MessageListAttachmentStageInput,
): Promise<MessageListAttachmentStageResult> {
  return unwrap(await remote().stageMessageListAttachment(options))
}

export async function apiIngestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult> {
  const result = unwrap(await remote().ingestMessageListWebhook(payload))
  notifyMessageListUpdated()
  return result
}

export async function apiResendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
  const result = unwrap(await remote().resendMessageListRecord(options))
  notifyMessageListUpdated()
  return result
}

export async function apiBatchResendMessageListRecords(options: {
  ids: number[]
}): Promise<MessageListBatchResendResult> {
  const result = unwrap(await remote().batchResendMessageListRecords(options))
  notifyMessageListUpdated()
  return result
}

export async function apiBatchDeleteMessageListRecords(options: {
  ids: number[]
}): Promise<MessageListBatchDeleteResult> {
  const result = unwrap(await remote().batchDeleteMessageListRecords(options))
  notifyMessageListUpdated()
  return result
}

export async function apiGetMessageListWebhookInfo(): Promise<MessageListWebhookInfo> {
  return unwrap(await remote().getMessageListWebhookInfo())
}

export async function apiProbeMessageListWebhook(options: {
  recordId?: number
  ruleId?: number
}): Promise<MessageListWebhookProbe> {
  return unwrap(await remote().probeMessageListWebhook(options))
}

export async function apiQueryMessageListWebhookJob(options: {
  recordId: number
  jobId?: string
}): Promise<MessageListWebhookJob> {
  const result = unwrap(await remote().queryMessageListWebhookJob(options))
  notifyMessageListUpdated()
  return result
}
