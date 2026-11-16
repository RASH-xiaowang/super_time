/**
 * 会话级 AI 回复处理器。
 *
 * 只有会话设置与只读状态可远程；启用/关闭会改变无人值守出网语义，
 * 由 HTTP 远程策略列为仅桌面端。运行器不在此文件直接出网。
 */
import {
  queryMessages,
  queryMessagesAtOrBefore,
  queryNewMessages,
} from '../query/messages.ts'
import {
  readEnabledChatAiReplyStates,
  readChatAiReplyState,
  saveChatAiReplyPersona,
  saveChatAiReplySetting,
} from '../query/ai-reply/config-store.ts'
import {
  applyChatAiReplyDefaultWebhook,
  readChatAiReplyDefaultWebhook,
  readChatAiReplyDefaultWebhookStrict,
  saveChatAiReplyDefaultWebhook,
} from '../query/ai-reply/default-webhook-store.ts'
import { createChatAiReplyRunner } from '../query/ai-reply/runner.ts'
import type { ChatAiReplyRegenerateResult } from '../query/ai-reply/runner-regenerate.ts'
import { errorText, latestMessageCursor } from '../query/ai-reply/runner-recovery.ts'
import type { ChatAiReplyGenerateFn } from '../query/ai-reply/generator.ts'
import type {
  ChatAiReplyDefaultWebhookMutationResult,
  ChatAiReplyDefaultWebhookState,
  ChatAiReplyDispatchResult,
  ChatAiReplyEnabledChatsResult,
  ChatAiReplyMutationResult,
  ChatAiReplyScanResult,
  ChatAiReplyScanDeps,
  ChatAiReplyState,
} from '../query/ai-reply/types.ts'
import {
  completeAiReplyMessageListRecord,
  completeAiReplyMessageListRecordSegments,
  deleteAiReplyMessageListRecordsForCleanup,
  dropAiReplyMessageListRecord,
  failAiReplyMessageListSegmentsAfter,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  listAiReplyMessageListSegments,
  recoverInterruptedMessageListDispatches,
  reopenAiReplyMessageListRecord,
  reserveAiReplyMessageListRecord,
  saveMessageListDispatchResult,
} from '../query/message-list-store.ts'
import type {
  AiReplyReservationCleanupResult,
} from '../query/message-list-store.ts'
import type { OperationCategory, OperationStatus } from '../types.ts'

export interface CreateChatAiReplyRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  selfUsername: () => string
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  generate: ChatAiReplyGenerateFn
  decodeImages?: NonNullable<ChatAiReplyScanDeps['decodeImages']>
  /** 知识库片段检索；由网关接到与问答相同的混合检索通道。 */
  collectKbSnippets?: NonNullable<ChatAiReplyScanDeps['collectKbSnippets']>
  dispatch: (recordId: number) => Promise<ChatAiReplyDispatchResult>
  onRecordSaved?: ChatAiReplyScanDeps['onRecordSaved']
  onRecordUpdated?: ChatAiReplyScanDeps['onRecordUpdated']
  onDispatchFinished?: ChatAiReplyScanDeps['onDispatchFinished']
  changed: () => void
}

/**
 * 将运行器依赖从 Remote 编排中拆出。
 *
 * 这些适配器只负责把消息列表/模型/事件能力接到 runner 的稳定接口上；单独成组
 * 放置后，Remote 工厂只保留状态读写、默认 Webhook 和开关编排，避免一个函数同时
 * 承担协议适配与业务状态机。
 */
function createChatAiReplyScanDeps(
  rc: CreateChatAiReplyRemotesInputs,
  dir: () => string,
): ChatAiReplyScanDeps {
  const markDispatchUnconfirmed = (recordId: number, error: string): void => {
    const marked = saveMessageListDispatchResult(dir(), recordId, {
      status: 'sent_unconfirmed',
      error,
      responseSummary: '',
      failureKind: 'unconfirmed',
      countAttempt: false,
    })
    if (marked?.status !== 'sent_unconfirmed') {
      failAiReplyMessageListRecord(dir(), recordId, error, 'unconfirmed')
    }
  }
  return {
    decryptedDir: dir,
    selfUsername: () => rc.selfUsername(),
    listMessages: async (talker, limit) => {
      const snapshot = queryMessages(dir(), talker, limit, undefined, rc.selfUsername())
      return snapshot.messages
    },
    listMessagesAtOrBefore: async (talker, localId, limit) => {
      const snapshot = queryMessagesAtOrBefore(
        dir(),
        talker,
        localId,
        limit,
        rc.selfUsername(),
      )
      return snapshot.messages
    },
    listMessagesAfter: async (talker, cursor, limit) => {
      const match = /^v2:(\d+):(\d+)$/.exec(cursor)
      if (match === null) {
        const snapshot = queryMessages(dir(), talker, limit, undefined, rc.selfUsername())
        return snapshot.messages
      }
      const sortSeq = Number(match[1])
      const localId = Number(match[2])
      if (!Number.isSafeInteger(sortSeq) || sortSeq < 0
        || !Number.isSafeInteger(localId) || localId <= 0) {
        return queryMessages(dir(), talker, limit, undefined, rc.selfUsername()).messages
      }
      const afterSortSeq = sortSeq > 0 ? sortSeq - 1 : 0
      const snapshot = queryNewMessages(
        dir(),
        talker,
        afterSortSeq,
        Math.min(1000, Math.max(1, limit + 1)),
        rc.selfUsername(),
      )
      return snapshot.messages.filter((message) => {
        const nextSortSeq = Number(message.sortSeq ?? message.localId)
        return nextSortSeq > sortSeq
          || (nextSortSeq === sortSeq && message.localId > localId)
      }).slice(0, limit)
    },
    generate: rc.generate,
    ...(rc.decodeImages === undefined ? {} : { decodeImages: rc.decodeImages }),
    ...(rc.collectKbSnippets === undefined ? {} : { collectKbSnippets: rc.collectKbSnippets }),
    gate: rc.gate,
    reserveReply: async (input) => {
      const reserved = reserveAiReplyMessageListRecord(dir(), input)
      return reserved.ok
        ? {
            ok: true,
            ...(reserved.id === undefined ? {} : { id: reserved.id }),
            created: reserved.created !== false,
            ...(reserved.record === undefined
              ? {}
              : { status: reserved.record.status, text: reserved.record.text }),
          }
        : { ok: false, ...(reserved.error === undefined ? {} : { error: reserved.error }) }
    },
    completeReply: async (input) => {
      const completed = completeAiReplyMessageListRecord(dir(), input.id, {
        text: input.text,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      return completed.ok
        ? {
            ok: true,
            ...(completed.id === undefined ? {} : { id: completed.id }),
            ...(completed.record === undefined
              ? {}
              : { status: completed.record.status, text: completed.record.text }),
          }
        : { ok: false, ...(completed.error === undefined ? {} : { error: completed.error }) }
    },
    completeReplySegments: async (input) => {
      return completeAiReplyMessageListRecordSegments(dir(), input.id, {
        segments: input.segments,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
    },
    listReplySegments: async (sourceRef) => listAiReplyMessageListSegments(dir(), sourceRef),
    failReplySegmentsAfter: async (input) => {
      return failAiReplyMessageListSegmentsAfter(
        dir(),
        input.sourceRef,
        input.segmentIndex,
        input.error,
        input.failureKind,
      )
    },
    failReply: async (input) => {
      const failed = failAiReplyMessageListRecord(
        dir(),
        input.id,
        input.error,
        input.failureKind,
      )
      return failed.ok
        ? {
            ok: true,
            ...(failed.id === undefined ? {} : { id: failed.id }),
            ...(failed.record === undefined
              ? {}
              : { status: failed.record.status, text: failed.record.text }),
          }
        : { ok: false, ...(failed.error === undefined ? {} : { error: failed.error }) }
    },
    dropReply: async (input) => {
      const dropped = dropAiReplyMessageListRecord(dir(), input.id, input.sourceRef)
      return dropped.ok
        ? { ok: true }
        : { ok: false, ...(dropped.error === undefined ? {} : { error: dropped.error }) }
    },
    reopenReply: async (input) => {
      const reopened = reopenAiReplyMessageListRecord(dir(), input.id, input.sourceRef)
      return reopened.ok
        ? { ok: true }
        : { ok: false, ...(reopened.error === undefined ? {} : { error: reopened.error }) }
    },
    getReply: async (id) => {
      const record = getMessageListRecord(dir(), id)
      return record === undefined
        ? { found: false }
        : {
            found: true,
            status: record.status,
            text: record.text,
            ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }),
            ...(record.error === '' ? {} : { error: record.error }),
            source: record.source,
            imageCount: record.images.length,
            ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
            attempts: record.attempts,
            ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
            createdAt: record.createdAt,
          }
    },
    dispatchReply: async (recordId) => {
      const result = await rc.dispatch(recordId)
      if (!result.ok) return result
      // 正常 dispatcher 在出网前已原子认领为 dispatching，成功后还会写
      // success/queued。若仍读到 pending，说明返回成功与台账终态之间有缺口；
      // 此时绝不能按成功推进，否则后台批次会把同一条记录再次领走。
      let current: ReturnType<typeof getMessageListRecord>
      try {
        current = getMessageListRecord(dir(), recordId)
      } catch (e) {
        const error = '投递已返回成功，但无法确认消息台账终态；已停止自动重发：' + errorText(e)
        markDispatchUnconfirmed(recordId, error)
        return { ok: false, error }
      }
      if (current?.status === 'pending') {
        const error = '投递已返回成功，但消息台账仍为 pending；'
          + '为避免后台再次发送，已标记为待核对'
        markDispatchUnconfirmed(recordId, error)
        return { ok: false, error }
      }
      return result
    },
    ...(rc.onRecordSaved === undefined ? {} : { onRecordSaved: rc.onRecordSaved }),
    ...(rc.onRecordUpdated === undefined ? {} : { onRecordUpdated: rc.onRecordUpdated }),
    ...(rc.onDispatchFinished === undefined ? {} : { onDispatchFinished: rc.onDispatchFinished }),
    closeInterruptedDispatches: () => recoverInterruptedMessageListDispatches(dir()),
    op: (action, ok, detail) => {
      rc.op('task', action, ok ? 'ok' : 'fail', '', detail)
    },
  }
}

function readStateWithDefaultWebhook(
  dir: string,
  selfUsername: string,
  options: { chatUsername: string; chatName?: string },
): ChatAiReplyState {
  const state = readChatAiReplyState(
    dir,
    selfUsername,
    options.chatUsername,
    options.chatName ?? '',
  )
  const fallback = readChatAiReplyDefaultWebhook(dir, selfUsername, state.chatUsername)
  return {
    ...state,
    defaultWebhookConfigured: fallback.configured,
    ...(fallback.endpoint === '' ? {} : { defaultWebhookEndpoint: fallback.endpoint }),
  }
}

function readDefaultWebhook(
  dir: string,
  selfUsername: string,
  options: { chatUsername: string; chatName?: string },
): ChatAiReplyDefaultWebhookState {
  const result = readChatAiReplyDefaultWebhookStrict(dir, selfUsername, options.chatUsername)
  return result.ok
    ? result.webhook
    : { configured: false, endpoint: '', updatedAt: 0, error: result.error }
}

function listEnabledChats(
  dir: string,
  selfUsername: string,
): ChatAiReplyEnabledChatsResult {
  const accountKey = selfUsername.trim()
  if (accountKey === '') return { ok: false, error: '无法解析当前账号 wxid' }
  const result = readEnabledChatAiReplyStates(dir)
  if (!result.ok) return result
  return {
    ok: true,
    chats: result.states
      .filter((state) => state.enabled
        && state.accountKey === accountKey
        && state.chatUsername !== ''
        && !state.chatUsername.endsWith('@chatroom'))
      .map((state) => ({
        chatUsername: state.chatUsername,
        chatName: state.chatName,
        updatedAt: state.updatedAt,
      })),
  }
}

function recordResultOf(
  dir: string,
  id: number,
): { found: boolean; status?: string; error?: string } {
  const record = getMessageListRecord(dir, id)
  return record === undefined
    ? { found: false }
    : { found: true, status: record.status, ...(record.error === '' ? {} : { error: record.error }) }
}

export function createChatAiReplyRemotes(rc: CreateChatAiReplyRemotesInputs) {
  const dir = (): string => rc.dirs().decrypted
  // AI 恢复器可能先于消息列表其它入口初始化；这里只做一次启动收口，绝不在
  // 周期扫描里把本进程正在投递的 dispatching 误判为中断。
  const recoveredDispatches = recoverInterruptedMessageListDispatches(dir())
  if (recoveredDispatches > 0) {
    rc.op(
      'task',
      'chat_ai_reply_recover_dispatch',
      'skip',
      String(recoveredDispatches) + ' 条',
      '上次进程中断，AI 回复记录已转 sent_unconfirmed，等待人工核对',
    )
  }
  const latestCursor = (chatUsername: string): string => {
    const snapshot = queryMessages(dir(), chatUsername, 80, undefined, rc.selfUsername())
    return latestMessageCursor(snapshot.messages) ?? ''
  }
  const scanDeps = createChatAiReplyScanDeps(rc, dir)
  const runner = createChatAiReplyRunner(scanDeps)

  return {
    getState(options: {
      chatUsername: string
      chatName?: string
    }): ChatAiReplyState {
      return readStateWithDefaultWebhook(dir(), rc.selfUsername(), options)
    },

    getDefaultWebhook(options: {
      chatUsername: string
      chatName?: string
    }): ChatAiReplyDefaultWebhookState {
      return readDefaultWebhook(dir(), rc.selfUsername(), options)
    },

    saveDefaultWebhook(options: {
      chatUsername: string
      chatName?: string
      webhookUrl: string
    }): ChatAiReplyDefaultWebhookMutationResult {
      const saved = saveChatAiReplyDefaultWebhook(dir(), {
        accountKey: rc.selfUsername(),
        chatUsername: options.chatUsername,
        ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
        webhookUrl: options.webhookUrl,
      })
      if (!saved.ok) {
        return {
          ok: false,
          configured: false,
          endpoint: '',
          updatedAt: 0,
          error: saved.error,
        }
      }
      const applied = applyChatAiReplyDefaultWebhook(dir(), {
        accountKey: rc.selfUsername(),
        chatUsername: options.chatUsername,
        ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
      })
      if (!applied.ok && applied.reason !== 'missing_webhook') {
        rc.op(
          'task',
          'chat_ai_reply_default_webhook_bind',
          'fail',
          options.chatName ?? options.chatUsername,
          applied.error,
        )
        return {
          ok: false,
          configured: saved.webhook.configured,
          endpoint: saved.webhook.endpoint,
          updatedAt: saved.webhook.updatedAt,
          error: '默认 Webhook 已保存，但规则绑定失败：' + applied.error,
        }
      }
      rc.op(
        'task',
        'chat_ai_reply_default_webhook_bind',
        'ok',
        options.chatName ?? options.chatUsername,
        applied.ok
          ? 'rule=' + String(applied.ruleId)
            + '; created=' + String(applied.ruleCreated)
            + '; backfilled=' + String(applied.backfilled)
          : applied.error,
      )
      rc.changed()
      return {
        ok: true,
        configured: saved.webhook.configured,
        endpoint: saved.webhook.endpoint,
        updatedAt: saved.webhook.updatedAt,
        ...(applied.ok
          ? {
              ruleId: applied.ruleId,
              ruleCreated: applied.ruleCreated,
              backfilled: applied.backfilled,
            }
          : {}),
      }
    },

    /**
     * 读取当前账号已开启 AI 回复的单聊摘要。
     *
     * 任务库可能同时保存多个微信账号，因此必须在服务端按当前 selfWxid 过滤；
     * 读取失败原样返回，不能把未知状态当成“没有开启”。
     */
    listEnabled(): ChatAiReplyEnabledChatsResult {
      return listEnabledChats(dir(), rc.selfUsername())
    },

    setEnabled(options: {
      chatUsername: string
      chatName?: string
      enabled: boolean
      provider?: 'dsh-wechat-bridge' | 'custom-webhook'
      expectedRevision?: number
    }): ChatAiReplyMutationResult {
      let cursor = ''
      if (options.enabled === true) {
        try {
          // Even an empty history gets an explicit watermark. If the query
          // itself fails, leave it empty so the runner retries a first scan.
          cursor = latestCursor(options.chatUsername) || '0:0'
        } catch {
          // 水位是优化，不是开关的前置条件：读不到时由首拍补建。
        }
      }
      const state = saveChatAiReplySetting(dir(), {
        accountKey: rc.selfUsername(),
        chatUsername: options.chatUsername,
        chatName: options.chatName ?? '',
        enabled: options.enabled === true,
        provider: options.provider ?? 'dsh-wechat-bridge',
        ...(cursor === '' ? {} : { cursor }),
        ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      })
      if (!state.ok || state.state === undefined) return state
      let next = readStateWithDefaultWebhook(dir(), rc.selfUsername(), options)
      if (options.enabled === true) {
        const applied = applyChatAiReplyDefaultWebhook(dir(), {
          accountKey: rc.selfUsername(),
          chatUsername: options.chatUsername,
          ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
        })
        if (applied.ok) {
          next = { ...next, error: '' }
          rc.op(
            'task',
            'chat_ai_reply_bind_default_webhook',
            'ok',
            options.chatName ?? options.chatUsername,
            'rule=' + String(applied.ruleId)
              + '; created=' + String(applied.ruleCreated)
              + '; backfilled=' + String(applied.backfilled),
          )
        } else if (applied.reason === 'missing_webhook') {
          next = {
            ...next,
            error: '尚未配置默认 Webhook；收到新消息后记录会显示“待配置”，配置后自动继续',
          }
        } else {
          const message = '默认 Webhook 自动绑定失败：' + applied.error
          next = { ...next, error: message }
          rc.op(
            'task',
            'chat_ai_reply_bind_default_webhook',
            'fail',
            options.chatName ?? options.chatUsername,
            applied.error,
          )
        }
      }
      rc.changed()
      return { ...state, state: next }
    },

    setPersona(options: {
      chatUsername: string
      chatName?: string
      personaName: string
      personaPrompt: string
      splitReply?: boolean
      kbEnabled?: boolean
      kbId?: number
      expectedRevision?: number
    }): ChatAiReplyMutationResult {
      const state = saveChatAiReplyPersona(dir(), {
        accountKey: rc.selfUsername(),
        chatUsername: options.chatUsername,
        ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
        personaName: options.personaName,
        personaPrompt: options.personaPrompt,
        ...(options.splitReply === undefined ? {} : { splitReply: options.splitReply }),
        ...(options.kbEnabled === undefined ? {} : { kbEnabled: options.kbEnabled }),
        ...(options.kbId === undefined ? {} : { kbId: options.kbId }),
        ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      })
      if (state.ok) rc.changed()
      return state.ok && state.state !== undefined
        ? { ...state, state: readStateWithDefaultWebhook(dir(), rc.selfUsername(), options) }
        : state
    },

    scanOnce(): Promise<ChatAiReplyScanResult> {
      return runner.scan()
    },

    /** 进程启动时只恢复遗留任务，不扫描/生成新的入站消息。 */
    recoverOnce(): Promise<ChatAiReplyScanResult> {
      return runner.recover()
    },

    recordResult(id: number): { found: boolean; status?: string; error?: string } {
      return recordResultOf(dir(), id)
    },

    /**
     * 桌面端专用：重新生成一条空白失败的 AI 回复。
     * 会再调用一次模型，记录会被原地复用（sourceRef 不变），不新建消息列表行。
     */
    regenerateRecord(options: {
      recordId: number
      expectedSourceRef: string
    }): Promise<ChatAiReplyRegenerateResult> {
      return runner.regenerate(options.recordId, options.expectedSourceRef)
    },

    /**
     * 桌面端专用：按 id 整组清理从未生成正文、从未投递的 AI 预约/失败记录。
     * 记录不存在算 skipped，重复调用幂等；逐条原因放在 items 里。
     * 运行窗口仍在生成/投递的记录会被拒绝（删除行不等于取消在途模型调用）。
     */
    deleteReservations(ids: readonly number[]): AiReplyReservationCleanupResult {
      return deleteAiReplyMessageListRecordsForCleanup(dir(), ids)
    },

    dispose(): void {
      runner.dispose()
    },
  }
}
