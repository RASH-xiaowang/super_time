/**
 * 微信 ClawBot 的 **AI 自动回复**（2026-10-13，多实例）。
 *
 * ## 它回答的问题
 *
 * 「收到微信消息时，要不要自动回一条、回什么」。三件事在这里定死：
 *   · **回不回** —— 只看该实例的开关（`autoReply`，默认关）；
 *   · **带不带知识库** —— `kbEnabled && kbId !== null` 才把该库纳入检索（没有「所有库」这种模式）；
 *   · **谁来答** —— 走注入的 `ask` 能力，也就是与「微信问答」**同一条 ask 管道**
 *     （模型统一由设置里的「对话模型」决定、同过隐私闸与审计）。
 *     本模块**不碰模型、不碰网络、不碰数据库**：它只做「决策 + 编排」，
 *     出网与落库都发生在注入进来的 `send` 里。
 *
 * ## 三条容易被忽略的边界（都写成了守卫）
 *
 * ① **无人值守出网**：这是本仓第一处「不是你点一下才发生」的模型调用。因此默认关、
 *    开关就在实例卡上（用户看得见），且每次回复都写一行审计（`clawbot_auto_reply`）。
 * ② **一批只回一条**：服务端不给我们消息时间（`WeixinMessage` 没有时间戳字段），
 *    所以「刚绑定就拉到一堆历史」无法按时间过滤 —— 上界只能靠「每批最多回最后一条」
 *    压到 1 条。这条边界同时写进了 PRIVACY 的 G2。
 * ③ **错误不许抛**：调用方是常驻长轮询循环，自动回复失败若抛出去会把收消息一起弄挂。
 *    这里所有失败路径都记账返回，一条都不外抛。
 *
 * @module query/clawbot/clawbot-auto-reply
 */
import type { ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../../types.ts'
import { splitReplyText } from './clawbot-prompt.ts'

/**
 * 自动回复正文的**总长**上限（超出截断并注明）。
 *
 * 取 **300**（2026-10-17 用户要求「每次回复不能超过 30 字」）：单条上限 30 字，
 * 300 字 = 最多 10 条 —— 再多就不是「回一条消息」而是「刷屏」了。
 * 模型可以输出很长，微信会话不该被一条回复刷屏。
 */
export const MAX_REPLY_CHARS = 300

/** 每实例的待回复上限（超出丢弃并记账）：一批几百条消息不该把模型调用打爆。 */
export const MAX_PENDING = 5

/**
 * 一条对话上下文消息（自动回复把最近几轮一起送进 ask 管道）。
 *
 * 为什么要带上下文（2026-10-18 用户报「不能关联上下文」）：只把最后一条文本当问题，
 * 模型会把「分析一下图中右边那辆车」当成一句孤立的话，于是回「我这边没看到图呀」。
 * 上下文里保留 `[图片]` / `[语音]` 占位，模型至少知道对方发过什么。
 */
export interface ClawbotHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 一张随消息送进模型的图片（canonical base64 + MIME）。
 *
 * 图片由调用方从 ClawBot 媒体缓存读出；是否真的能送给模型由 ask 管道按模型能力决定，
 * 本模块不判断（也不联网）。
 */
export interface ClawbotImageInput {
  data: string
  mediaType: string
  name?: string
}

/** 自动回复附带的上下文（最近对话 + 最近图片）。 */
export interface ClawbotAskContext {
  history?: ClawbotHistoryMessage[]
  images?: ClawbotImageInput[]
}

/**
 * 自动回复用的 ask 能力（由装配层注入）。
 *
 * 形状刻意保持很窄（一个问题 + 可选知识库 + 可选系统提示词 + 可选上下文 ⇒ 一段答案）：
 * 调用方不许知道模型是谁、也不许自己拼提示词 —— 那些都在 ask 管道里，
 * 与手动问答共用一份实现。
 * @param slot - 实例编号。
 * @param text - 入站消息正文（作为问题）。
 * @param kbId - 非 null 时把该知识库纳入检索（知识库增强回复）。
 * @param systemPrompt - 该实例的系统提示词（空串 = 用内置拟人化默认值）。
 * @param context - 最近对话与图片（2026-10-18 起；旧注入方可忽略）。
 */
export type ClawbotAskFn = (
  slot: number,
  text: string,
  kbId: number | null,
  systemPrompt: string,
  context?: ClawbotAskContext,
) => Promise<{ ok: boolean, answer: string, error?: string }>

/** 决策结果（`should` 为假时 `reason` 说明为什么，供审计与用例断言）。 */
export interface AutoReplyDecision {
  should: boolean
  reason: string
  /** 要带进 ask 的知识库；null = 不检索（**不是**「所有库」）。 */
  kbId: number | null
}

/**
 * 该实例现在该不该自动回复。
 *
 * 只认开关，不看消息内容：**「开了就回」是用户的显式选择**，自动回复不该再自作主张
 * 判断「这句话值不值得回」（那类启发式一旦误判，用户看到的是「有时候回有时候不回」）。
 * @param cfg - 该实例的行为配置（每次现读，用户改完立即生效）。
 * @returns 决策（含实际要用的 kbId）。
 */
export function decideAutoReply(cfg: ClawbotInstanceConfig): AutoReplyDecision {
  if (!cfg.autoReply) return { should: false, reason: '实例未开启自动回复', kbId: null }
  if (cfg.kbEnabled && cfg.kbId !== null) {
    return { should: true, reason: '自动回复 + 知识库增强', kbId: cfg.kbId }
  }
  if (cfg.kbEnabled) {
    // 开了增强却没选库：**照常回复**，但按「不检索」处理 —— 沉默比少检索更让人困惑。
    return { should: true, reason: '自动回复（开了知识库增强但没选库 ⇒ 不检索）', kbId: null }
  }
  return { should: true, reason: '自动回复（不检索知识库）', kbId: null }
}

/** 一条候选消息里，本模块关心的那几列。 */
export interface ReplyableMessage {
  direction: 'in' | 'out'
  msgType: string | null
  content: string
  /** 落库行 id（用于从库里取「这条之前的对话」与媒体缓存；旧调用方可不带）。 */
  id?: number
}

/**
 * 这条消息值不值得回。
 *
 * `direction === 'out'` 的是**本机发出去的**（含 bot 回显）——回它就成了自己跟自己说话；
 * 非文本（图片/语音/文件/视频）不做自动回复：媒体的语义要么靠转写（未接入）、
 * 要么本来就是「转存给人看」而不是「问问题」。
 * @param msg - 候选消息。
 * @returns 可回复为 true。
 */
export function isReplyable(msg: ReplyableMessage): boolean {
  return msg.direction === 'in' && msg.msgType === 'text' && msg.content.trim() !== ''
}

/**
 * 从一批候选里挑出**唯一**要回的那条：最后一条可回复的入站文本。
 *
 * 为什么一批只回一条（而不是逐条回）：服务端不下发消息时间，所以「刚绑定、首次长轮询
 * 拉回一堆历史」与「用户连发几条」在数据上长得一样。逐条回会在前者场景里刷屏，
 * 只回最后一条把上界压到 1 条，且对后者也是最自然的反应（人也不会逐条回）。
 * @param candidates - 本批新落库的消息。
 * @returns 目标（无则 null）与被跳过的条数（供审计说清「这一批跳了多少」）。
 */
export function pickReplyTarget(candidates: readonly ReplyableMessage[]): { target: ReplyableMessage | null, dropped: number } {
  const ok = candidates.filter(isReplyable)
  const target = ok.at(-1)
  if (target === undefined) return { target: null, dropped: 0 }
  return { target, dropped: ok.length - 1 }
}

/** 超长回复截断（带上「已截断」字样，不假装完整）。 */
export function truncateReply(text: string): string {
  const t = text.trim()
  if (t.length <= MAX_REPLY_CHARS) return t
  return t.slice(0, MAX_REPLY_CHARS) + '…（内容较长，已截断）'
}

export interface AutoReplyRunnerDeps {
  /** 取该实例的配置（**每次现读**：用户关掉开关后，队列里的下一条就不再回）。 */
  readConfig: (slot: number) => ClawbotInstanceConfig
  /** 统一问答管道（缺省 = 未注入 ⇒ 自动回复不可用，只记账不发送）。 */
  ask?: ClawbotAskFn
  /** 发送（生产 = `sendClawbotText`：**成功才落库**，失败不写假记录）。 */
  send: (slot: number, text: string) => Promise<ClawbotSendResult>
  /** 审计一行（`category='clawbot'`）。 */
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  /** 回复成功后通知外层（发 `clawbot/message` 事件，前端实时可见）。 */
  onReplied: (info: { slot: number, id: number }) => void
  /** 取目标消息之前的最近对话（缺省 = 不带上下文，退回旧行为）。 */
  history?: (slot: number, target: ReplyableMessage) => ClawbotHistoryMessage[]
  /** 取目标消息之前最近的入站图片（缺省 = 不送图；读取失败按空处理）。 */
  images?: (slot: number, target: ReplyableMessage) => Promise<ClawbotImageInput[]>
}

/**
 * 自动回复执行器：**全局单飞 + 每实例队列**。
 *
 * 单飞是全局的（同一时刻只有一轮 ask 在跑）：模型调用本来就慢，并发起来只会
 * 让几个号一起变慢，还不好排查；而会话内部的顺序本来就必须串行。
 * @param deps - 注入依赖（见 {@link AutoReplyRunnerDeps}）。
 * @returns `consider(slot, candidates)` 与测试用的 `pending()`。
 */
export function createAutoReplyRunner(deps: AutoReplyRunnerDeps): {
  consider: (slot: number, candidates: readonly ReplyableMessage[]) => void
  pending: () => number
} {
  /** 每实例的待回复队列（只存目标消息本身）。 */
  const queues = new Map<number, ReplyableMessage[]>()
  let draining = false

  function takeNext(): { slot: number, msg: ReplyableMessage } | null {
    for (const [slot, q] of queues) {
      const msg = q.shift()
      if (msg === undefined) continue
      if (q.length === 0) queues.delete(slot)
      return { slot, msg }
    }
    return null
  }

  async function handle(slot: number, msg: ReplyableMessage, cfg: ClawbotInstanceConfig): Promise<void> {
    const tag = `slot=${slot}`
    const ask = deps.ask
    if (ask === undefined) {
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, 'ask 能力未注入（自动回复不可用）')
      return
    }
    const kbId = cfg.kbEnabled && cfg.kbId !== null ? cfg.kbId : null
    /*
     * 上下文（2026-10-18）：把目标消息**之前**的最近对话与图片一起送进 ask 管道。
     * 读失败一律按「没有上下文」处理 —— 自动回复不许因为库读不出来而完全不回。
     */
    const context: ClawbotAskContext = {}
    try {
      const history = deps.history?.(slot, msg)
      if (history !== undefined && history.length > 0) context.history = history
    } catch { /* 上下文尽力而为 */ }
    try {
      const images = deps.images === undefined ? undefined : await deps.images(slot, msg)
      if (images !== undefined && images.length > 0) context.images = images
    } catch { /* 图片尽力而为：读不到就当这次没有图 */ }
    let r: Awaited<ReturnType<ClawbotAskFn>>
    try {
      // 系统提示词：空串 = 用内置拟人化默认值（在装配层解析，这里只传用户写的那份）。
      r = await ask(slot, msg.content, kbId, cfg.systemPrompt, context)
    } catch (e) {
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '自动回复失败：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    if (!r.ok) {
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '自动回复失败：' + (r.error ?? '未知原因'))
      return
    }
    const text = truncateReply(r.answer)
    if (text === '') {
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '模型返回空答案，未发送')
      return
    }
    /*
     * 分段发送（2026-10-17）：微信里一条几千字读起来很累，且容易被折叠。
     * 开启时按语义切段逐条发出（像人连发几条）；关闭时整条发出。
     * ⚠️ 分段是**多条消息**：任一段失败就停（后面的不再发）—— 半截回复比不回复更让人困惑。
     */
    const parts = cfg.splitReply ? splitReplyText(text) : [text]
    let sentCount = 0
    let lastId: number | null = null
    for (const part of parts) {
      let sent: ClawbotSendResult
      try {
        sent = await deps.send(slot, part)
      } catch (e) {
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag,
          `回复发送失败（第 ${String(sentCount + 1)}/${String(parts.length)} 段）：` + (e instanceof Error ? e.message : String(e)))
        return
      }
      if (!sent.ok || sent.id === null) {
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag,
          `回复未发出（第 ${String(sentCount + 1)}/${String(parts.length)} 段）：` + (sent.error ?? '未知原因'))
        return
      }
      sentCount += 1
      lastId = sent.id
      try {
        deps.onReplied({ slot, id: sent.id })
      } catch { /* 事件尽力而为（与其余事件同一策略） */ }
    }
    deps.op('clawbot', 'clawbot_auto_reply', 'ok', tag,
      `已自动回复 ${String(text.length)} 字` +
      (parts.length > 1 ? `（分 ${String(parts.length)} 段发送）` : '') +
      (kbId === null ? '（未检索知识库）' : `（知识库 ${String(kbId)}）`) +
      (context.history === undefined ? '' : `（上下文 ${String(context.history.length)} 条）`) +
      (context.images === undefined ? '' : `（图片 ${String(context.images.length)} 张）`))
    /* v8 ignore next -- 循环至少跑一次（parts 非空），lastId 必被赋值。 */
    if (lastId === null) return
  }

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      for (;;) {
        const next = takeNext()
        if (next === null) break
        // 配置**逐条现读**：用户在队列消化期间关掉开关，剩下的就不再回。
        const cfg = deps.readConfig(next.slot)
        if (!decideAutoReply(cfg).should) continue
        await handle(next.slot, next.msg, cfg)
      }
    } catch (e) {
      // 兜底：本模块**一条都不许外抛**（调用方是常驻长轮询）。
      deps.op('clawbot', 'clawbot_auto_reply', 'fail', '', '自动回复循环异常：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      draining = false
    }
  }

  return {
    consider(slot: number, candidates: readonly ReplyableMessage[]): void {
      const decision = decideAutoReply(deps.readConfig(slot))
      if (!decision.should) return
      const { target, dropped } = pickReplyTarget(candidates)
      if (target === null) return
      const q = queues.get(slot) ?? []
      if (q.length >= MAX_PENDING) {
        deps.op('clawbot', 'clawbot_auto_reply', 'fail', `slot=${slot}`, `待回复已积压 ${String(MAX_PENDING)} 条，本批丢弃`)
        return
      }
      if (dropped > 0) {
        deps.op('clawbot', 'clawbot_auto_reply', 'ok', `slot=${slot}`,
          `本批 ${String(candidates.length)} 条，只回最后一条（跳过 ${String(dropped)} 条）`)
      }
      q.push(target)
      queues.set(slot, q)
      void drain()
    },

    pending(): number {
      let n = 0
      for (const q of queues.values()) n += q.length
      return n
    },
  }
}
