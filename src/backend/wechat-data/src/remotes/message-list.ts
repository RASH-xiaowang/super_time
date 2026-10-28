/**
 * 「消息列表」Remote 处理器。
 *
 * 纯读留给手机端；写规则、手动插入、重发与入站 Webhook 信息均为桌面端本机能力。
 * 投递依赖由网关注入，query 层不反向 import gateway。
 *
 * @module remotes/message-list
 */
import { decodeImageDataUrlAsync } from '../query/media-image-async.ts'
import {
  deleteMessageListRule,
  ingestMessageListWebhook,
  insertMessageListRecord,
  listMessageListRecords,
  listMessageListRules,
  saveMessageListRule,
} from '../query/message-list-store.ts'
import {
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
} from '../query/message-list-dispatch.ts'
import type { MessageListDispatchDeps } from '../query/message-list-dispatch.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type {
  MessageListDispatchBatchResult,
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListWebhookInfo,
  MessageListWebhookPayload,
  OperationCategory,
  OperationStatus,
} from '../types.ts'

export interface MessageListImageContext {
  wechatBaseDir?: string
  aesKey?: string
  xorKey: number
}

export interface CreateMessageListRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  imageContext: () => MessageListImageContext
  webhookInfo: () => MessageListWebhookInfo
  changed?: (created: number, dispatched: number) => void
  fetchImpl?: RetryFetch
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

export function createMessageListRemotes(rc: CreateMessageListRemotesInputs) {
  const dirs = (): { decrypted: string; decoded: string } => rc.dirs()

  const dispatchDeps = (): MessageListDispatchDeps => {
    const { decrypted, decoded } = dirs()
    const image = rc.imageContext()
    const deps: MessageListDispatchDeps = {
      decodeImage: (username, localId) => decodeImageDataUrlAsync(
        decrypted,
        decoded,
        username,
        localId,
        image.wechatBaseDir,
        image.aesKey,
        image.xorKey,
      ),
      gate: (feature, stats, texts) => rc.privacyGate(feature, stats, texts),
    }
    if (rc.fetchImpl !== undefined) deps.fetchImpl = rc.fetchImpl
    return deps
  }

  const changed = (created: number, dispatched: number): void => {
    try {
      rc.changed?.(created, dispatched)
    } catch {
      // 事件是尽力而为，不影响已经完成的写操作。
    }
  }

  return {
    listMessageListRecords(query?: MessageListQuery): MessageListSnapshot {
      return listMessageListRecords(dirs().decrypted, query)
    },

    listMessageListRules(): MessageListRuleSnapshot {
      return listMessageListRules(dirs().decrypted)
    },

    saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult {
      const result = saveMessageListRule(dirs().decrypted, options)
      rc.op(
        'task',
        'message_list_save_rule',
        result.ok ? 'ok' : 'fail',
        options?.chatName || options?.targetName || ('id=' + String(options?.id ?? '')),
        result.error ?? ('id=' + String(result.id ?? '')),
      )
      if (result.ok) changed(0, 0)
      return result
    },

    deleteMessageListRule(options: { id: number }): MessageListMutationResult {
      const result = deleteMessageListRule(dirs().decrypted, options?.id)
      rc.op(
        'task',
        'message_list_delete_rule',
        result.ok ? 'ok' : 'fail',
        'id=' + String(options?.id ?? ''),
        result.error ?? '',
      )
      if (result.ok) changed(0, 0)
      return result
    },

    async insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult> {
      const inserted = insertMessageListRecord(dirs().decrypted, options)
      rc.op(
        'task',
        'message_list_insert',
        inserted.ok ? 'ok' : 'fail',
        inserted.record?.targetName ?? options?.targetName ?? '',
        inserted.error ?? ('id=' + String(inserted.id ?? '')),
      )
      if (!inserted.ok || inserted.id === undefined) return inserted
      changed(1, 0)
      const dispatched = await dispatchMessageListRecord(dirs().decrypted, inserted.id, dispatchDeps())
      if (dispatched.ok) changed(0, 1)
      return dispatched
    },

    async resendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
      const result = await dispatchMessageListRecord(dirs().decrypted, options?.id, dispatchDeps())
      rc.op(
        'task',
        'message_list_resend',
        result.ok ? 'ok' : 'fail',
        'id=' + String(options?.id ?? ''),
        result.error ?? '',
      )
      if (result.ok) changed(0, 1)
      return result
    },

    async ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult> {
      const inserted = ingestMessageListWebhook(dirs().decrypted, payload)
      rc.op(
        'task',
        'message_list_ingest',
        inserted.ok ? 'ok' : 'fail',
        inserted.record?.targetName ?? payload?.targetName ?? payload?.target ?? '',
        inserted.error ?? ('id=' + String(inserted.id ?? '')),
      )
      if (!inserted.ok || inserted.id === undefined) return inserted
      changed(1, 0)
      const dispatched = await dispatchMessageListRecord(dirs().decrypted, inserted.id, dispatchDeps())
      if (dispatched.ok) changed(0, 1)
      return dispatched
    },

    getMessageListWebhookInfo(): MessageListWebhookInfo {
      return rc.webhookInfo()
    },

    dispatchPending(): Promise<MessageListDispatchBatchResult> {
      return dispatchPendingMessageListRecords(dirs().decrypted, dispatchDeps())
    },
  }
}
