import { readReplyToolsConfig } from './config/wechat-config.ts'
/**
 * 会话级 AI 回复的 Remote 方法面。
 *
 * 开关是无人值守出网配置：读状态可远程，写开关与立即扫描仅桌面端。
 * 后台触发与任务扫描共用同一个实时同步回调；不依赖聊天界面是否打开。
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ChatAiReplyDefaultWebhookMutationResult,
  ChatAiReplyDefaultWebhookState,
  ChatAiReplyEnabledChatsResult,
  ChatAiReplyMutationResult,
  ChatAiReplyScanResult,
  ChatAiReplyState,
} from './query/ai-reply/types.ts'
import {
  createChatAiReplyRemotes,
  type CreateChatAiReplyRemotesInputs,
} from './remotes/chat-ai-reply.ts'
import type { ChatAiReplyRegenerateResult } from './query/ai-reply/runner-regenerate.ts'
import type { ChatAiReplyTraceReadResult } from './query/ai-reply/trace-store.ts'
import type { AiReplyReservationCleanupResult } from './query/message-list-store.ts'
import { createDefaultChatAiReplyGenerator } from './query/ai-reply/generator.ts'
import { AI_REPLY_VOICE_BUDGET_MS, decodeChatAiReplyImages } from './query/ai-reply/context.ts'
import { cachedTranscript, TRANSCRIBE_CONCURRENCY, transcribeOneVoiceAsync } from './query/voice-transcribe.ts'
import { svrIdByChatLocal } from './query/voice.ts'
import { getConfig } from './query/config.ts'
import { WHISPER_DEFAULT_MODEL, resolveWhisperModelsDir, whisperEnginePath } from './query/whisper.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { collectReplyKbSnippetsHybrid } from './query/reply-kb.ts'
import { rawWechatBase } from './gateway-support.ts'
import { GatewayMessageList } from './gateway-message-list.ts'

export abstract class GatewayChatAiReply extends GatewayMessageList {
  constructor(ctx: Context) {
    super(ctx)
    // 启动后的低优先级恢复：只处理上一进程遗留的 pending/generating/saving/
    // dispatching，不在窗口启动路径上等待模型或网络。
    setImmediate(() => {
      void this.chatAiReplyRemotes().recoverOnce()
        .then((result) => {
          if ((result.recovered ?? 0) > 0 || (result.errors?.length ?? 0) > 0) {
            console.log('[chat-ai-reply] 启动恢复：'
              + String(result.recovered ?? 0) + ' 个任务'
              + ((result.errors?.length ?? 0) > 0 ? '，错误：' + result.errors?.join('；') : ''))
          }
        })
        .catch((e: unknown) => {
          console.warn('[chat-ai-reply] 启动恢复失败：'
            + (e instanceof Error ? e.message : String(e)))
        })
    })
    ctx.effect(() => () => {
      this._chatAiReplyRemotes?.dispose()
      this._chatAiReplyRemotes = undefined
    }, 'wechat-data: chat ai reply recovery')
  }

  /**
   * 读取某个单聊的会话级 AI 回复状态。
   * 默认关闭；状态只包含开关、执行阶段、游标和最近一次记录，不含凭据。
   */
  @Remote('getChatAiReplyState')
  getChatAiReplyState(options: { chatUsername: string; chatName?: string }): ChatAiReplyState {
    return this.chatAiReplyRemotes().getState(options)
  }

  /** 读取当前账号、当前会话的默认 Webhook；只返回脱敏端点。 */
  @Remote('getChatAiReplyDefaultWebhook')
  getChatAiReplyDefaultWebhook(options: {
    chatUsername: string
    chatName?: string
  }): ChatAiReplyDefaultWebhookState {
    return this.chatAiReplyRemotes().getDefaultWebhook(options)
  }

  /** 保存默认 Webhook，并立即绑定缺失的精确规则、回填 AI pending 记录。 */
  @Remote('saveChatAiReplyDefaultWebhook')
  saveChatAiReplyDefaultWebhook(options: {
    chatUsername: string
    chatName?: string
    webhookUrl: string
    /** 地址来自哪个托管实例（内部透传，界面不填）；用于实例换端口后同步规则。 */
    appInstanceId?: string
  }): ChatAiReplyDefaultWebhookMutationResult {
    const result = this.chatAiReplyRemotes().saveDefaultWebhook(options)
    // 回填只补地址快照；再调度一拍投递，避免记录停在「待执行」等人工重发。
    if (result.ok && (result.backfilled ?? 0) > 0) {
      void this.scheduleMessageListDispatch()
    }
    return result
  }

  /**
   * 批量读取当前账号已开启 AI 回复的单聊。
   * 只返回列表筛选所需的轻量摘要，不含游标、Webhook 或模型凭据。
   */
  @Remote('listEnabledChatAiReplyStates')
  listEnabledChatAiReplyStates(): ChatAiReplyEnabledChatsResult {
    return this.chatAiReplyRemotes().listEnabled()
  }

  /**
   * 开启或关闭某个会话的 AI 回复。
   * 仅桌面端可写；单聊与群聊都支持（群聊只有 @我 的消息会触发），缺少账号或
   * 旧 revision 写入会被拒绝。开启时尽量预置当前水位，
   * 避免回放历史消息；关闭后不再生成或投递该会话的新回复。
   */
  @Remote('setChatAiReplyEnabled')
  setChatAiReplyEnabled(options: {
    chatUsername: string
    chatName?: string
    enabled: boolean
    provider?: 'dsh-wechat-bridge' | 'custom-webhook'
    expectedRevision?: number
  }): ChatAiReplyMutationResult {
    const result = this.chatAiReplyRemotes().setEnabled(options)
    // 开启时绑定默认规则会回填已有 pending 记录；顺手投递一拍，
    // 让「开启开关」到「真正发出」之间不再依赖下一次任务扫描。
    if (result.ok && options.enabled === true) {
      void this.scheduleMessageListDispatch()
    }
    return result
  }

  /**
   * 保存某个单聊的 AI 回复人格与知识库参与设置。
   * 人格只影响模型语气与措辞，不能覆盖后端固定的防注入和安全规则；勾选知识库后，
   * 每轮生成会先按最近上下文检索该库并把命中的片段作为**不可信材料**交给模型。
   * 写入会推进 revision，并取消该会话尚未完成的旧回复任务。
   */
  @Remote('setChatAiReplyPersona')
  setChatAiReplyPersona(options: {
    chatUsername: string
    chatName?: string
    personaName: string
    personaPrompt: string
    splitReply?: boolean
    kbEnabled?: boolean
    kbId?: number
    /** 上下文时间窗（小时）；0 = 不限。上限 720（30 天），超出按上限夹紧。 */
    contextWindowHours?: number
    /** 查无资料时的转人工话术；空串使用内置句。 */
    safetyHandoff?: string
    /** 额外禁说词，逗号分隔。 */
    safetyBlocked?: string
    expectedRevision?: number
  }): ChatAiReplyMutationResult {
    return this.chatAiReplyRemotes().setPersona(options)
  }

  /**
   * 立即扫描一次已开启的会话。
   * 正常由实时同步事件和 10 秒兜底触发；此方法主要供桌面端诊断使用。
   */
  @Remote('scanChatAiReplyNow')
  scanChatAiReplyNow(): Promise<ChatAiReplyScanResult> {
    return this.chatAiReplyRemotes().scanOnce()
  }

  /**
   * 桌面端专用：重新生成一条空白失败的 AI 回复记录。
   *
   * 只允许 24 小时内、整组无正文/图片/投递事实，且失败分类为 superseded、
   * generation_failed 或 config_changed 的记录。**会再调用一次付费模型并可能出网，
   * 成功后不可撤销**；expectedSourceRef 用于防止点击后目标记录被替换。
   */
  @Remote('regenerateChatAiReplyRecord')
  regenerateChatAiReplyRecord(options: {
    recordId: number
    expectedSourceRef: string
  }): Promise<ChatAiReplyRegenerateResult> {
    // schema 覆盖层只是影子账；这里对绕过界面的调用仍给出稳定错误。
    if (options === null || typeof options !== 'object') {
      return Promise.resolve({ ok: false, error: '重新生成参数无效' })
    }
    return this.chatAiReplyRemotes().regenerateRecord(options)
  }

  /**
   * 桌面端专用：删除 AI 回复记录。
   *
   * 按 sourceRef/segment_group_ref 整组删除，**不可撤销**。默认只删空白且从未投递的
   * 预约/失败记录；传 `includeTerminal: true` 时允许删除已收口的记录（成功 / 已发出
   * 未确认 / 失败），用于清理台账里已经结束的行。在途状态（生成中 / 投递中 / 下游
   * 排队或执行）一律拒绝 —— 删除行不等于取消在途模型调用或投递。记录不存在算
   * skipped，重复调用幂等。
   */
  @Remote('deleteAiReplyReservations')
  deleteAiReplyReservations(options: {
    ids: number[]
    /** 是否允许删除已收口的终态记录（默认 false，只删空白预约）。 */
    includeTerminal?: boolean
  }): AiReplyReservationCleanupResult {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.ids)) {
      return { ok: false, removed: 0, skipped: 0, items: [], error: 'ids 必须是数组' }
    }
    return this.chatAiReplyRemotes().deleteReservations(options.ids, options.includeTerminal === true)
  }

  /**
   * 读取一条 AI 回复记录的过程留痕（只读）。
   *
   * 返回本轮实际送进模型的上下文、知识库命中、system/user 提示词、模型输出与
   * 各阶段时间戳，供消息列表详情「回复过程」展示。只有本机自建表，不含 Webhook
   * 地址或模型凭据；旧记录没有留痕时 `ok:false`，界面据此显示「无留痕」。
   */
  @Remote('getChatAiReplyTrace')
  getChatAiReplyTrace(options: { recordId: number }): ChatAiReplyTraceReadResult {
    const recordId = Number(options?.recordId)
    if (!Number.isSafeInteger(recordId) || recordId <= 0) {
      return { ok: false, error: '记录 id 无效' }
    }
    return this.chatAiReplyRemotes().getTrace(recordId)
  }

  protected _chatAiReplyRemotes?: ReturnType<typeof createChatAiReplyRemotes>

  protected chatAiReplyRemotes(): ReturnType<typeof createChatAiReplyRemotes> {
    return (this._chatAiReplyRemotes ??= createChatAiReplyRemotes(this.chatAiReplyDeps()))
  }

  protected chatAiReplyDeps(): CreateChatAiReplyRemotesInputs {
    return {
      dirs: () => this._dirs,
      selfUsername: () => this.selfUsername(),
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      gate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      generate: createDefaultChatAiReplyGenerator({ ctx: () => this._ctx, toolConfig: () => readReplyToolsConfig(this._dirs.decrypted) }),
      decodeImages: ({ decryptedDir, talker, candidates }) => {
        const image = resolveImageKeyPair(this._dirs.decrypted)
        return decodeChatAiReplyImages(
          decryptedDir,
          this._dirs.decoded,
          talker,
          candidates,
          {
            wechatBaseDir: rawWechatBase(this._dirs.decrypted) || undefined,
            aesKey: image.aesKey,
            xorKey: image.xorKey,
          },
        )
      },
      // 语音先转文字：模型拿到的是「对方说了什么」，而不是一个 [语音] 占位。
      // 引擎/模型没装好时返回空 Map（调用方保留占位），绝不阻断整次回复。
      //
      // 延迟：large-v3 在本机实测每条 26–31 秒，但转写结果按 svr_id 缓存在
      // `<decoded>/voices/<svr_id>.txt`，同一条语音只有第一次要等。这里按
      // TRANSCRIBE_CONCURRENCY 并发，把首次命中几条语音的等待压到一半左右。
      transcribeVoices: async ({ decryptedDir, talker, localIds }) => {
        const out = new Map<number, string>()
        const cfg = getConfig(this._dirs.decrypted)
        const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
        const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
        const engine = whisperEnginePath(configBin, modelsDir)
        if (engine === null) {
          this.op('task', 'chat_ai_reply', 'fail', talker, '未检测到 whisper.cpp 引擎，语音按占位进入上下文')
          return out
        }
        const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : WHISPER_DEFAULT_MODEL
        // 最新优先：回复针对的是最后一条，先转它；预算耗尽就留占位。
        const queue = [...localIds].reverse()
        const deadline = Date.now() + AI_REPLY_VOICE_BUDGET_MS
        const worker = async (): Promise<void> => {
          for (;;) {
            if (Date.now() >= deadline) return
            const localId = queue.shift()
            if (localId === undefined) return
            // 已转写过的直接读缓存，不重复起 whisper 子进程。
            const svrId = svrIdByChatLocal(decryptedDir, talker, localId, '')
            if (svrId !== '') {
              const cached = cachedTranscript(this._dirs.decoded, svrId)
              if (cached !== '') {
                out.set(localId, cached)
                continue
              }
            }
            const r = await transcribeOneVoiceAsync(
              decryptedDir, this._dirs.decoded, modelsDir, modelId, engine, talker, localId, '',
            )
            if (r.ok && (r.text ?? '') !== '') out.set(localId, r.text ?? '')
          }
        }
        const lanes = Math.min(TRANSCRIBE_CONCURRENCY, Math.max(1, queue.length))
        await Promise.all(Array.from({ length: lanes }, () => worker()))
        if (out.size < localIds.length) {
          this.op('task', 'chat_ai_reply', 'ok', talker,
            '语音转写 ' + String(out.size) + '/' + String(localIds.length)
              + '（超出 ' + String(Math.round(AI_REPLY_VOICE_BUDGET_MS / 1000)) + ' 秒预算的留占位，下次命中缓存）')
        }
        return out
      },
      collectKbSnippets: ({ kbId, lines, latestPeer }) => collectReplyKbSnippetsHybrid({
        decryptedDir: this._dirs.decrypted,
        kbId,
        lines,
        ...(latestPeer === undefined ? {} : { latestPeer }),
        topK: 3,
        makeEmbedFn: (model, feature) => this.makeEmbedFn(model, feature),
        kbModel: (id, role) => this.kbModel(id, role),
      }),
      dispatch: async (recordId) => {
        const result = await this.messageListRemotes().dispatchRecord(recordId)
        return {
          ok: result.ok,
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        }
      },
      onRecordSaved: ({ created }) => {
        if (created) this.emitMessageListUpdated(1, 0)
      },
      onRecordUpdated: () => {
        this.emitMessageListUpdated(0, 0)
      },
      onDispatchFinished: ({ ok }) => {
        this.emitMessageListUpdated(0, ok ? 1 : 0)
      },
      changed: () => this.emitMessageListUpdated(0, 0),
    }
  }

  /** 后台扫描：由同步事件与 10s 兜底调用；失败不影响微信同步主流程。 */
  protected override scanChatAiRepliesBackground(): void {
    void this.scheduleChatAiReplyScan()
  }

  protected _chatAiReplyScan: Promise<ChatAiReplyScanResult> | null = null
  protected _chatAiReplyScanQueued = false

  protected scheduleChatAiReplyScan(): Promise<ChatAiReplyScanResult> {
    if (this._chatAiReplyScan !== null) {
      this._chatAiReplyScanQueued = true
      return this._chatAiReplyScan
    }
    this._chatAiReplyScan = this.chatAiReplyRemotes().scanOnce()
      .then((result) => {
        // created/dispatched 由异步回调逐条广播；扫描返回值只描述已排队的会话。
        return result
      })
      .catch((e: unknown): ChatAiReplyScanResult => {
        console.warn('[chat-ai-reply] 扫描失败：' + (e instanceof Error ? e.message : String(e)))
        return { scanned: 0, queued: 0, created: 0, dispatched: 0, errors: [e instanceof Error ? e.message : String(e)] }
      })
      .finally(() => {
        this._chatAiReplyScan = null
        if (this._chatAiReplyScanQueued) {
          this._chatAiReplyScanQueued = false
          void this.scheduleChatAiReplyScan()
        }
      })
    return this._chatAiReplyScan
  }
}
