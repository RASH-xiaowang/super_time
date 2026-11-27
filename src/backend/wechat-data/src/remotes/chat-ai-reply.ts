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
import { readChatAiReplyTrace, writeChatAiReplyTrace } from '../query/ai-reply/trace-store.ts'
import type { ChatAiReplyTraceReadResult } from '../query/ai-reply/trace-store.ts'
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
  holdAiReplyMessageListDraft,
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
import type { MessageListRecordResult } from '../types.ts'

type ReserveReplyInput = Parameters<ChatAiReplyScanDeps['reserveReply']>[0]

/**
 * 预约成功后的留痕（模块级，避免把大工厂函数撑过单函数行数阈值）。
 * 只给新建记录写：恢复时重复预约不追加重复阶段。
 */
function traceReserved(
  dir: string,
  reserved: MessageListRecordResult,
  input: ReserveReplyInput,
  selfUsername: string,
): void {
  if (!reserved.ok || reserved.created === false || reserved.id === undefined) return
  writeChatAiReplyTrace(dir, {
    recordId: reserved.id,
    sourceRef: input.sourceRef,
    accountKey: selfUsername,
    ...(input.chatUsername === undefined ? {} : { chatUsername: input.chatUsername }),
    stage: { name: 'reserved', at: Date.now(), detail: 'target=' + input.targetName },
  })
}

/** 正文写入消息列表后的留痕：详情里据此区分「已生成」与「已落库」。 */
function traceSaved(dir: string, recordId: number, output: string, segments: number): void {
  writeChatAiReplyTrace(dir, {
    recordId,
    output,
    stage: { name: 'saved', at: Date.now(), detail: 'segments=' + String(segments) },
  })
}

export interface CreateChatAiReplyRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  selfUsername: () => string
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  generate: ChatAiReplyGenerateFn
  decodeImages?: NonNullable<ChatAiReplyScanDeps['decodeImages']>
  /** 语音转写；由网关接到本地 whisper（设置里选的模型）。 */
  transcribeVoices?: NonNullable<ChatAiReplyScanDeps['transcribeVoices']>
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
  /**
   * 群聊消息补一列 `mentionSelf`：扫描据此只把「点名 @我」的消息当作锚点。
   *
   * 为什么在**读取边界**算：登录账号只有这里知道；放进纯函数会让它多一个参数、
   * 并且每一处调用都要记得传。单聊消息原样返回（不带该字段 ⇒ 不施加限制）。
   * @param talker - 会话 `WechatSession.username` 的别名。
   * @param messages - 该会话读到的消息。
   * @returns 带上 `mentionSelf` 的消息（群聊）或原数组（单聊）。
   */
  const withMentionFlags = <T extends { atUsers?: ReadonlyArray<{ username: string }> }>(
    talker: string,
    messages: T[],
  ): T[] => {
    if (!talker.endsWith('@chatroom')) return messages
    const self = rc.selfUsername()
    return messages.map((message) => ({
      ...message,
      // 只认结构化的 atuserlist；`notify@all`（@所有人）不算单独 @我。
      mentionSelf: self !== '' && (message.atUsers ?? []).some((user) => user.username === self),
    }))
  }
  return {
    decryptedDir: dir,
    selfUsername: () => rc.selfUsername(),
    listMessages: async (talker, limit) => {
      const snapshot = queryMessages(dir(), talker, limit, undefined, rc.selfUsername())
      return withMentionFlags(talker, snapshot.messages)
    },
    listMessagesAtOrBefore: async (talker, localId, limit) => {
      const snapshot = queryMessagesAtOrBefore(
        dir(),
        talker,
        localId,
        limit,
        rc.selfUsername(),
      )
      return withMentionFlags(talker, snapshot.messages)
    },
    listMessagesAfter: async (talker, cursor, limit) => {
      const match = /^v2:(\d+):(\d+)$/.exec(cursor)
      if (match === null) {
        const snapshot = queryMessages(dir(), talker, limit, undefined, rc.selfUsername())
        return withMentionFlags(talker, snapshot.messages)
      }
      const sortSeq = Number(match[1])
      const localId = Number(match[2])
      if (!Number.isSafeInteger(sortSeq) || sortSeq < 0
        || !Number.isSafeInteger(localId) || localId <= 0) {
        return withMentionFlags(
          talker,
          queryMessages(dir(), talker, limit, undefined, rc.selfUsername()).messages,
        )
      }
      const afterSortSeq = sortSeq > 0 ? sortSeq - 1 : 0
      const snapshot = queryNewMessages(
        dir(),
        talker,
        afterSortSeq,
        Math.min(1000, Math.max(1, limit + 1)),
        rc.selfUsername(),
      )
      return withMentionFlags(talker, snapshot.messages.filter((message) => {
        const nextSortSeq = Number(message.sortSeq ?? message.localId)
        return nextSortSeq > sortSeq
          || (nextSortSeq === sortSeq && message.localId > localId)
      }).slice(0, limit))
    },
    generate: rc.generate,
    ...(rc.decodeImages === undefined ? {} : { decodeImages: rc.decodeImages }),
    ...(rc.transcribeVoices === undefined ? {} : { transcribeVoices: rc.transcribeVoices }),
    ...(rc.collectKbSnippets === undefined ? {} : { collectKbSnippets: rc.collectKbSnippets }),
    gate: rc.gate,
    holdReply: async (input) => {
      const held = holdAiReplyMessageListDraft(dir(), input.id, input.reason)
      return held.ok
        ? { ok: true }
        : { ok: false, ...(held.error === undefined ? {} : { error: held.error }) }
    },
    reserveReply: async (input) => {
      const reserved = reserveAiReplyMessageListRecord(dir(), input)
      traceReserved(dir(), reserved, input, rc.selfUsername())
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
      if (completed.ok) traceSaved(dir(), input.id, input.text, 1)
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
      const completed = await completeAiReplyMessageListRecordSegments(dir(), input.id, {
        segments: input.segments,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      if (completed.ok) traceSaved(dir(), input.id, input.segments.join('\n\n'), input.segments.length)
      return completed
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
    // 过程留痕：上下文/提示词/输出/阶段耗时写进独立表，供消息列表详情查看。
    writeTrace: (patch) => writeChatAiReplyTrace(dir(), patch),
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
      // 2026-11-18 起群聊也能开启，徽标/筛选同样需要它。
      .filter((state) => state.enabled
        && state.accountKey === accountKey
        && state.chatUsername !== '')
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

/** 保存默认 Webhook 并立即绑定缺失的精确规则（从大工厂里拆出，控制单函数行数）。 */
function saveDefaultWebhookWithRule(
  rc: CreateChatAiReplyRemotesInputs,
  dir: string,
  options: {
    chatUsername: string
    chatName?: string
    webhookUrl: string
    /** 地址来自哪个托管实例；空 = 手填。透传给自动绑定的规则。 */
    appInstanceId?: string
  },
): ChatAiReplyDefaultWebhookMutationResult {
  const saved = saveChatAiReplyDefaultWebhook(dir, {
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
  const applied = applyChatAiReplyDefaultWebhook(dir, {
    accountKey: rc.selfUsername(),
    chatUsername: options.chatUsername,
    ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
    ...(options.appInstanceId ? { appInstanceId: options.appInstanceId } : {}),
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
      appInstanceId?: string
    }): ChatAiReplyDefaultWebhookMutationResult {
      return saveDefaultWebhookWithRule(rc, dir(), options)
    },

    /**
     * 读取当前账号已开启 AI 回复的会话摘要（单聊与群聊）。
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
      contextWindowHours?: number
      safetyHandoff?: string
      safetyBlocked?: string
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
        ...(options.contextWindowHours === undefined
          ? {}
          : { contextWindowHours: options.contextWindowHours }),
        ...(options.safetyHandoff === undefined ? {} : { safetyHandoff: options.safetyHandoff }),
        ...(options.safetyBlocked === undefined ? {} : { safetyBlocked: options.safetyBlocked }),
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
     * 桌面端专用：按 id 整组删除 AI 回复记录。
     * 默认只删空白且从未投递的预约/失败记录；`includeTerminal` 放开已收口的终态
     * 记录（成功 / 已发出未确认 / 失败），在途状态仍拒绝。记录不存在算 skipped，
     * 重复调用幂等；逐条原因放在 items 里。
     */
    deleteReservations(
      ids: readonly number[],
      includeTerminal = false,
    ): AiReplyReservationCleanupResult {
      return deleteAiReplyMessageListRecordsForCleanup(dir(), ids, { includeTerminal })
    },

    /**
     * 读取一条 AI 回复记录的过程留痕（上下文 / 知识库 / 提示词 / 输出 / 阶段耗时）。
     * 只读本机自建表，不含 Webhook 或模型凭据；旧记录没有留痕时返回 `ok:false`。
     */
    getTrace(recordId: number): ChatAiReplyTraceReadResult {
      return readChatAiReplyTrace(dir(), recordId)
    },

    dispose(): void {
      runner.dispose()
    },
  }
}
