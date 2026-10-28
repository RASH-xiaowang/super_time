/**
 * 消息列表 / 回复投递规则的取数与写入口。
 *
 * 读列表不缓存：后台任务扫描与局域网 Webhook 会持续写入；写操作成功后广播
 * `dsh-wechat-message-list-updated`，记录页与规则页各自回源。
 */
import type {
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListWebhookInfo,
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

export async function apiResendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
  const result = unwrap(await remote().resendMessageListRecord(options))
  notifyMessageListUpdated()
  return result
}

export async function apiGetMessageListWebhookInfo(): Promise<MessageListWebhookInfo> {
  return unwrap(await remote().getMessageListWebhookInfo())
}
