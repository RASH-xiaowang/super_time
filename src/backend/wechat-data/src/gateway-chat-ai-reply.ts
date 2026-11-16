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
import type { AiReplyReservationCleanupResult } from './query/message-list-store.ts'
import { createDefaultChatAiReplyGenerator } from './query/ai-reply/generator.ts'
import { decodeChatAiReplyImages } from './query/ai-reply/context.ts'
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

  /** 读取当前账号、当前会话的默认大肥鱼 Webhook；只返回脱敏端点。 */
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
  }): ChatAiReplyDefaultWebhookMutationResult {
    return this.chatAiReplyRemotes().saveDefaultWebhook(options)
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
   * 开启或关闭某个单聊的 AI 回复。
   * 仅桌面端可写；群聊、缺少账号或旧 revision 写入都会被拒绝。开启时尽量预置当前水位，
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
    return this.chatAiReplyRemotes().setEnabled(options)
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
   * 桌面端专用：清理空白且从未发送的 AI 回复预约/失败记录。
   *
   * 按 sourceRef/segment_group_ref 整组删除，**不可撤销**；有正文、图片、异步任务、
   * 发送尝试或任何投递事实的记录会逐条跳过；运行窗口仍在生成/投递的记录也会被
   * 拒绝（删除行不等于取消在途模型调用）。记录不存在算 skipped，重复调用幂等。
   */
  @Remote('deleteAiReplyReservations')
  deleteAiReplyReservations(options: { ids: number[] }): AiReplyReservationCleanupResult {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.ids)) {
      return { ok: false, removed: 0, skipped: 0, items: [], error: 'ids 必须是数组' }
    }
    return this.chatAiReplyRemotes().deleteReservations(options.ids)
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
      generate: createDefaultChatAiReplyGenerator({ ctx: () => this._ctx }),
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
