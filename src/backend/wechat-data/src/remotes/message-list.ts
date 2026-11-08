/**
 * 「消息列表」Remote 处理器。
 *
 * 纯读留给手机端；写规则、手动插入、重发与入站 Webhook 信息均为桌面端本机能力。
 * 投递依赖由网关注入，query 层不反向 import gateway。
 *
 * @module remotes/message-list
 */
import {
  deleteMessageListRecords,
  deleteMessageListRule,
  ingestMessageListWebhook,
  insertAiReplyMessageListRecord,
  insertMessageListRecord,
  getMessageListRule,
  getMessageListRecord,
  listMessageListRecords,
  listMessageListRules,
  recoverInterruptedMessageListDispatches,
  saveMessageListRule,
} from '../query/message-list-store.ts'
import {
  batchResendMessageListRecords,
  dispatchCreatedMessageListRecord,
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
  probeMessageListWebhook,
  queryMessageListWebhookJob,
  redactWebhookEndpoint,
} from '../query/message-list-dispatch.ts'
import type { MessageListRecordDispatchResult } from '../query/message-list-dispatch.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type {
  AiReplyMessageListInput,
  MessageListBatchDeleteResult,
  MessageListBatchResendResult,
  MessageListDispatchBatchResult,
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
  OperationCategory,
  OperationStatus,
} from '../types.ts'
import { createMessageListDispatchDeps } from './message-list-dispatch-deps.ts'

// 只保留历史台账前缀识别；该功能已退役，但旧记录仍不能被通用 Webhook 重发。
const RETIRED_DEDICATED_SOURCE_REF_PREFIX = 'clawbot:'

/** 历史专用台账记录必须继续 fail-closed，不能回落到通用 Webhook。 */
function isRetiredDedicatedSourceRef(sourceRef: string | undefined): boolean {
  return sourceRef?.trim().startsWith(RETIRED_DEDICATED_SOURCE_REF_PREFIX) === true
}

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

export function createMessageListRemotes(rc: CreateMessageListRemotesInputs) {
  const dirs = (): { decrypted: string; decoded: string } => rc.dirs()
  const recoveredDispatches = recoverInterruptedMessageListDispatches(dirs().decrypted)
  if (recoveredDispatches > 0) {
    rc.op(
      'task',
      'message_list_recover_dispatch',
      'skip',
      String(recoveredDispatches) + ' 条',
      '上次进程中断，记录已转 sent_unconfirmed，等待人工核对',
    )
  }

  const dispatchDeps = () => createMessageListDispatchDeps({
    dirs,
    imageContext: rc.imageContext,
    privacyGate: rc.privacyGate,
    ...(rc.fetchImpl === undefined ? {} : { fetchImpl: rc.fetchImpl }),
  })

  const changed = (created: number, dispatched: number): void => {
    try {
      rc.changed?.(created, dispatched)
    } catch {
      // 事件是尽力而为，不影响已经完成的写操作。
    }
  }

  return {
    listMessageListRecords(query?: MessageListQuery): MessageListSnapshot {
      const snapshot = listMessageListRecords(dirs().decrypted, query)
      // 远程读与桌面新编辑弹窗都只能拿到脱敏地址；保存时由服务端从规则 id 回填原文。
      return {
        ...snapshot,
        items: snapshot.items.map((record) => ({
          ...record,
          webhookUrl: redactWebhookEndpoint(record.webhookUrl),
        })),
      }
    },

    listMessageListRules(): MessageListRuleSnapshot {
      const snapshot = listMessageListRules(dirs().decrypted)
      return {
        ...snapshot,
        items: snapshot.items.map((rule) => ({
          ...rule,
          webhookUrl: redactWebhookEndpoint(rule.webhookUrl),
        })),
      }
    },

    probeMessageListWebhook(options: {
      recordId?: number
      ruleId?: number
    }): Promise<MessageListWebhookProbe> {
      return probeMessageListWebhook(dirs().decrypted, options, dispatchDeps())
    },

    queryMessageListWebhookJob(options: {
      recordId: number
      jobId?: string
    }): Promise<MessageListWebhookJob> {
      return queryMessageListWebhookJob(dirs().decrypted, options, dispatchDeps())
    },

    saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult {
      const current = options.id === undefined
        ? undefined
        : getMessageListRule(dirs().decrypted, options.id)
      const supplied = options.webhookUrl.trim()
      const preserveCurrent = options.id !== undefined
        && current !== undefined
        && (supplied === '' || supplied === redactWebhookEndpoint(current.webhookUrl))
      const effective = preserveCurrent ? { ...options, webhookUrl: current.webhookUrl } : options
      const result = saveMessageListRule(dirs().decrypted, effective)
      rc.op(
        'task',
        'message_list_save_rule',
        result.ok ? 'ok' : 'fail',
        effective?.chatName || effective?.targetName || ('id=' + String(options?.id ?? '')),
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
      if (inserted.created !== false) changed(1, 0)
      const dispatched = await dispatchCreatedMessageListRecord(dirs().decrypted, inserted, dispatchDeps())
      if (dispatched.ok && inserted.created !== false) changed(0, 1)
      return dispatched
    },

    /**
     * AI runner 的内部唯一写入口：先落消息列表，只有新建记录才投递。
     * 该处理器不作为 Remote 暴露，避免绕过上下文/隐私闸直接出网。
     */
    async insertAiReplyRecord(options: AiReplyMessageListInput): Promise<MessageListRecordResult> {
      const inserted = insertAiReplyMessageListRecord(dirs().decrypted, options)
      rc.op(
        'task',
        'message_list_ai_reply_insert',
        inserted.ok ? 'ok' : 'fail',
        inserted.record?.targetName ?? options?.targetName ?? '',
        inserted.error ?? ('id=' + String(inserted.id ?? '')),
      )
      if (!inserted.ok || inserted.id === undefined) return inserted
      if (inserted.created !== false) changed(1, 0)
      const dispatched = await dispatchCreatedMessageListRecord(dirs().decrypted, inserted, dispatchDeps())
      if (dispatched.ok && inserted.created !== false) changed(0, 1)
      return dispatched
    },

    async resendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
      const id = options?.id
      const record = getMessageListRecord(dirs().decrypted, id)
      let result: MessageListRecordResult
      if (isRetiredDedicatedSourceRef(record?.sourceRef)) {
        result = {
          ok: false,
          ...(record === undefined ? { id } : { id: record.id, record }),
          error: '历史专用台账记录已停用，禁止进入通用 Webhook 重发',
        }
      } else {
        result = await dispatchMessageListRecord(
          dirs().decrypted,
          id,
          dispatchDeps(),
          'manual_single',
        )
      }
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

    async batchResendMessageListRecords(
      options: { ids: number[] },
    ): Promise<MessageListBatchResendResult> {
      const result = await batchResendMessageListRecords(
        dirs().decrypted,
        options?.ids,
        dispatchDeps(),
      )
      const detail = result.ok
        ? '成功 ' + String(result.succeeded) + '，失败 ' + String(result.failed)
          + '，跳过 ' + String(result.skipped)
        : result.error ?? ''
      const status = !result.ok || result.failed > 0
        ? 'fail'
        : result.succeeded > 0 ? 'ok' : 'skip'
      rc.op(
        'task',
        'message_list_batch_resend',
        status,
        '请求 ' + String(result.requested) + ' 条',
        detail,
      )
      if (result.succeeded > 0) changed(0, result.succeeded)
      return result
    },

    async batchDeleteMessageListRecords(
      options: { ids: number[] },
    ): Promise<MessageListBatchDeleteResult> {
      const result = deleteMessageListRecords(dirs().decrypted, options?.ids)
      const detail = result.ok
        ? '删除 ' + String(result.removed) + '，跳过 ' + String(result.skipped)
        : result.error ?? ''
      rc.op(
        'task',
        'message_list_batch_delete',
        result.ok ? 'ok' : 'fail',
        '请求 ' + String(result.requested) + ' 条',
        detail,
      )
      if (result.removed > 0) changed(0, 0)
      return result
    },

    /** 同域内部投递入口，供 AI runner 在记录落库后调用；不注册为 Remote。 */
    dispatchRecord(id: number): Promise<MessageListRecordDispatchResult> {
      return dispatchMessageListRecord(dirs().decrypted, id, dispatchDeps())
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
      if (inserted.created !== false) changed(1, 0)
      const dispatched = await dispatchCreatedMessageListRecord(dirs().decrypted, inserted, dispatchDeps())
      if (dispatched.ok && inserted.created !== false) changed(0, 1)
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
