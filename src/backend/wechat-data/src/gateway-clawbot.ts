/**
 * WechatDataGateway 方法面 · **微信 ClawBot 集成**的转发（2026-10-12）。
 *
 * 单独成环的理由与 laya（#20 第四刀）同款：数据/运维方法面已经按域切成
 * media / export / voice / config / laya 多层壳，ClawBot 一族放不进其中一层；
 * 本文件插在 `GatewayDbHealth` 与叶子之间
 * （W3-11.7 起中间还隔着 `gateway-db-health.ts` 那一环），
 * 对外方法面逐名不变（`gateway-remote-surface.spec.ts` 守）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；处理器体在 `remotes/clawbot.ts`。
 * 另外实现 core 的启动钩子（{@link bootClawbotChannel}）：绑定过的通道随网关拉起 ——
 * 收消息是宿主职责，不该等用户打开面板。
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { ClawbotBindQr, ClawbotBindStateSnapshot, ClawbotBindingSnapshot, ClawbotEnvSnapshot, ClawbotInstanceConfig, ClawbotInstanceCreated, ClawbotInstanceDeleted, ClawbotInstancesSnapshot, ClawbotMediaResult, ClawbotMessageQuery, ClawbotMessageSnapshot, ClawbotSendResult } from './types.ts'
import { createClawbotRemotes } from './remotes/clawbot.ts'
import { DEFAULT_CLAWBOT_SYSTEM_PROMPT } from './query/clawbot/clawbot-prompt.ts'
import { addClawbotTokenUsage } from './query/clawbot/clawbot-token.ts'
import { GatewayDbHealth } from './gateway-db-health.ts'

/** 方法面的一层：继承链上的一环，不单独实例化。 */
export abstract class GatewayClawbot extends GatewayDbHealth {
  /**
   * 实例列表（多实例：一个微信号 = 一个实例；每个实例有自己的自动回复与知识库开关）。
   * @returns 实例列表快照（读失败时带 readError —— 与「一个实例都没有」不是一回事）。
   */
  @Remote('listClawbotInstances')
  listClawbotInstances(): ClawbotInstancesSnapshot {
    return this.clawbotRemotes().listClawbotInstances()
  }

  /**
   * 新建一个实例（初始未绑定；随后用 `createClawbotBindQr` 为它取码）。
   * @returns 新实例编号 + 最新实例列表。
   */
  @Remote('createClawbotInstance')
  createClawbotInstance(): ClawbotInstanceCreated {
    return this.clawbotRemotes().createClawbotInstance()
  }

  /**
   * 删除一个实例（绑定行 + 配置 + **该实例的接入会话**一起删；条数如实回报）。
   * @param options.slot - 实例编号。
   * @returns 连带删除的会话条数 + 最新实例列表。
   */
  @Remote('deleteClawbotInstance')
  deleteClawbotInstance(options: { slot: number }): ClawbotInstanceDeleted {
    return this.clawbotRemotes().deleteClawbotInstance(options)
  }

  /**
   * 改某实例的**行为配置**（AI 自动回复 / 知识库增强；部分更新）。
   *
   * 模型不在这里选：自动回复走与「微信问答」同一条 ask 管道 ⇒
   * 统一由设置里的「对话模型」决定（见 `remotes/clawbot.ts` 的 `ask` 注入点）。
   * @param options - 实例编号 + 要改的字段。
   * @returns 落库后的完整配置。
   */
  @Remote('setClawbotInstanceConfig')
  setClawbotInstanceConfig(options: { slot: number, autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }): ClawbotInstanceConfig {
    return this.clawbotRemotes().setClawbotInstanceConfig(options)
  }

  /**
   * 给实例起别名（「工作号」「客服号」；2026-10-16）。
   *
   * 与绑定状态机无关（只动 `label` 一列）⇒ 别名活过重新绑定与解绑。
   * 空串 = 清除别名（界面回落到昵称，再回落到「实例 N」）。
   * @param options.slot - 实例编号。
   * @param options.label - 新别名（空串 = 清除）。
   * @returns 落库后的绑定卡片快照。
   */
  @Remote('renameClawbotInstance')
  renameClawbotInstance(options: { slot: number, label: string }): ClawbotBindingSnapshot {
    return this.clawbotRemotes().renameClawbotInstance(options)
  }

  /**
   * 当前绑定行（设置卡片首屏）。
   * @param options.slot - 实例编号（缺省 = 第一个实例）。
   * @returns 绑定卡片快照（含会话计数与通道状态）。
   */
  @Remote('getClawbotBinding')
  getClawbotBinding(options?: { slot?: number }): ClawbotBindingSnapshot {
    return this.clawbotRemotes().getClawbotBinding(options)
  }

  /**
   * 申请绑定二维码（真实调用腾讯 iLink 服务；失败抛可读中文，渲染层按 message 展示）。
   * @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
   * @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。
   */
  @Remote('createClawbotBindQr')
  async createClawbotBindQr(options?: { slot?: number }): Promise<ClawbotBindQr> {
    return this.clawbotRemotes().createClawbotBindQr(options)
  }

  /**
   * 中继一次绑定状态轮询（弹窗打开期间反复调用；单次最长约 40 秒，见 remote-policy.js）。
   * @param options.slot - 哪个实例的这场扫码会话（缺省 = 第一个实例）。
   * @returns 状态与绑定卡片快照。
   */
  @Remote('getClawbotBindState')
  async getClawbotBindState(options?: { slot?: number }): Promise<ClawbotBindStateSnapshot> {
    return this.clawbotRemotes().getClawbotBindState(options)
  }

  /**
   * 解绑（断开该实例的通道；**接入会话保留**，见 PRIVACY.md 第三节）。
   * @param options.slot - 实例编号（缺省 = 第一个实例）。
   * @returns 解绑后的绑定卡片快照。
   */
  @Remote('unbindClawbot')
  unbindClawbot(options?: { slot?: number }): ClawbotBindingSnapshot {
    return this.clawbotRemotes().unbindClawbot(options)
  }

  /**
   * 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）。
   * @param options - 检索条件（关键词在服务端过滤；带 `slot` 即按实例分）。
   * @returns 会话页快照。
   */
  @Remote('listClawbotMessages')
  listClawbotMessages(options?: ClawbotMessageQuery): ClawbotMessageSnapshot {
    return this.clawbotRemotes().listClawbotMessages(options)
  }

  /**
   * 清空某实例的**接入会话**（2026-10-17）：只删消息，不动绑定与配置。
   * @param options.slot - 实例编号（缺省 = 第一个实例）。
   * @returns 删掉的条数 + 最新会话页快照（界面据此立刻刷新）。
   */
  @Remote('clearClawbotMessages')
  clearClawbotMessages(options?: { slot?: number }): { removed: number, messages: ClawbotMessageSnapshot } {
    return this.clawbotRemotes().clearClawbotMessages(options)
  }

  /**
   * 取**内置的拟人化默认系统提示词**（2026-10-17）。
   *
   * 为什么要有它：设置视图的输入框此前是空的（「留空 = 用默认值」），用户**看不到**
   * 默认值长什么样 —— 想改也不知道从哪改起。把它暴露给界面，输入框就能预填，
   * 用户可以直接在默认值上改（而不是从零写）。
   * @returns 默认提示词全文。
   */
  @Remote('getClawbotDefaultPrompt')
  getClawbotDefaultPrompt(): { prompt: string } {
    return { prompt: DEFAULT_CLAWBOT_SYSTEM_PROMPT }
  }

  /**
   * 环境自检（精简 3 项：应用运行 / 绑定通道 / 集成状态）—— 第 ② 项读的是该实例的通道。
   * @param options.slot - 实例编号（缺省 = 第一个实例）。
   * @returns 自检快照。
   */
  @Remote('checkClawbotEnv')
  checkClawbotEnv(options?: { slot?: number }): ClawbotEnvSnapshot {
    return this.clawbotRemotes().checkClawbotEnv(options)
  }

  /**
   * 发送一条消息到微信（用户主动触发；正文经腾讯服务中转，**唯一由内容驱动的出网路径**）。
   * @param options.text - 正文原文（不打码、不改写）。
   * @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
   * @returns 发送结果（失败不落库，error 为可读中文）。
   */
  @Remote('sendClawbotMessage')
  async sendClawbotMessage(options: { text: string, slot?: number }): Promise<ClawbotSendResult> {
    return this.clawbotRemotes().sendClawbotMessage(options)
  }

  /**
   * 取某条消息的附件（按需下载 + 解密 + 缓存；只在用户点开时发生）。
   * @param options.id - 会话行 id。
   * @returns 取数结果（图片给小图 dataUrl；其余给本机路径）。
   */
  @Remote('getClawbotMedia')
  async getClawbotMedia(options: { id: number }): Promise<ClawbotMediaResult> {
    return this.clawbotRemotes().getClawbotMedia(options)
  }

  /**
   * 覆写 core 的启动钩子：**每个**绑定过的实例的接收通道随网关拉起（幂等；未绑定/无凭证的
   * 实例不启动，也就不会有任何出网）。收消息是宿主职责 —— 只有用户打开面板时才收等于漏消息。
   */
  protected override bootClawbotChannel(): void {
    this.clawbotRemotes().ensureClawbotChannel()
  }

  protected _clawbotRemotes?: ReturnType<typeof createClawbotRemotes>

  /**
   * 微信 ClawBot 集成（绑定 / 接入会话 / 环境自检） 的处理器（体在 remotes/clawbot.ts）；
   * 这里只组装 ctx 与转发。组装放在本层而不是 core，是为了不让 core 越过 1000 行上限（laya 同款）。
   *
   * 事件出口在这里「对号入座」（判别联合 → 具体的 `ctx.emit` 调用）：
   * `ctx.emit` 的第一参数是 `keyof Events`，只有写死字面量才拿得到类型，
   * 所以名字的映射必须留在装配侧；try/catch 包在闭包里（事件尽力而为）。
   */
  protected clawbotRemotes(): ReturnType<typeof createClawbotRemotes> {
    return (this._clawbotRemotes ??= createClawbotRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      emit: (event) => {
        try {
          if (event.name === 'clawbot/binding-changed') this._ctx.emit('clawbot/binding-changed', event.args)
          else this._ctx.emit('clawbot/message', event.args)
        } catch { /* event best-effort，与 wechat-ask/delta 同策略 */ }
      },
      /**
       * AI 自动回复的能力注入（2026-10-13）：包一层 `askWechat`，于是自动回复与
       * 「微信问答」走**完全同一条管道** ——
       *   · 模型 = 设置里的「对话模型」（`agentDefaultModel.currentSelection()`），
       *     本文件不认第二个模型来源；
       *   · 隐私闸与 AI 审计（`ask_wechat`）在管道内部完成，自动回复一条都不会绕过；
       *   · `kbId` 只在实例开了知识库增强且选了库时非空（不传 = 不检索，不是「所有库」）；
       *   · 历史落一条 `source: 'auto'` —— 问答历史里必须认得出「这条不是我自己问的」。
       *     不带它就会落成缺省的 `'ask'`（= 用户手动问），于是用户看到一条没问过的记录，
       *     排查「为什么自动回了这么一句」时也失去唯一的依据。
       *
       * ⚠️ **数据面限定 `kb-only`（2026-10-17）**：自动回复是**无人值守出网**，
       * 它的数据面只许是「知识库 + 对话上下文 + 模型」—— **不许检索本机微信数据**
       * （消息 / 联系人 / 朋友圈 / 收藏 / 文件 / 账单）。理由：
       *   ① 微信里随便一个人发一句话，就能让本机把**全部聊天记录**检索一遍并送去模型，
       *      这是用户没有逐条同意过的出网；
       *   ② 手动问答有「用户此刻的意图」兜底（他刚选了范围、看着界面），自动回复没有。
       * 关掉后：检索阶段跳过微信侧、不建向量索引（不把消息正文送去 embedding），
       * 只保留知识库通道；依据行会写明「本次仅检索知识库」。
       * 失败一律转成 `{ ok:false }` 让上层的审计记账 —— 自动回复**不许抛**进长轮询循环。
       */
      ask: async (slot, text, kbId, systemPrompt, context) => {
        try {
          const r = await this.askDeepRemotes().askWechat({
            question: text, source: 'auto', dataScope: 'kb-only',
            // 系统提示词：用户写了就用他的，没写就用内置拟人化默认值（**不是「没有提示词」**）。
            systemPromptOverride: systemPrompt.trim() !== '' ? systemPrompt : DEFAULT_CLAWBOT_SYSTEM_PROMPT,
            ...(kbId === null ? {} : { kbId }),
            // 最近对话与图片（2026-10-18）：自动回复的上下文只来自本 ClawBot 会话库，
            // ask 管道内按模型是否支持读图决定发送图片还是显式说明看不到图片。
            ...(context?.history === undefined ? {} : { history: context.history }),
            ...(context?.images === undefined ? {} : { images: context.images }),
          })
          // 按实例记 token 消耗（2026-10-19）：供应商不返回 usage 时 r.usage 为空，
          // addClawbotTokenUsage 不落 0 行 ⇒ 统计显示 0 是「确实没记到」。
          addClawbotTokenUsage(this._dirs.decrypted, slot, r.usage)
          return { ok: true, answer: r.answer }
        } catch (e) {
          return { ok: false, answer: '', error: e instanceof Error ? e.message : String(e) }
        }
      },
    }))
  }
}
