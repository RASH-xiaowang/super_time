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
 * @module query/clawbot-auto-reply
 */
import type { ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../types.ts';
/** 自动回复正文的长度上限（超出截断并注明）—— 模型可以输出很长，微信会话不该被一条回复刷屏。 */
export declare const MAX_REPLY_CHARS = 2000;
/** 每实例的待回复上限（超出丢弃并记账）：一批几百条消息不该把模型调用打爆。 */
export declare const MAX_PENDING = 5;
/**
 * 自动回复用的 ask 能力（由装配层注入）。
 *
 * 形状刻意保持很窄（一个问题 + 可选知识库 ⇒ 一段答案）：调用方不许知道模型是谁、
 * 也不许自己拼提示词 —— 那些都在 ask 管道里，与手动问答共用一份实现。
 * `kbId` 非 null 时把该知识库纳入检索（知识库增强回复）。
 */
export type ClawbotAskFn = (slot: number, text: string, kbId: number | null) => Promise<{
    ok: boolean;
    answer: string;
    error?: string;
}>;
/** 决策结果（`should` 为假时 `reason` 说明为什么，供审计与用例断言）。 */
export interface AutoReplyDecision {
    should: boolean;
    reason: string;
    /** 要带进 ask 的知识库；null = 不检索（**不是**「所有库」）。 */
    kbId: number | null;
}
/**
 * 该实例现在该不该自动回复。
 *
 * 只认开关，不看消息内容：**「开了就回」是用户的显式选择**，自动回复不该再自作主张
 * 判断「这句话值不值得回」（那类启发式一旦误判，用户看到的是「有时候回有时候不回」）。
 * @param cfg - 该实例的行为配置（每次现读，用户改完立即生效）。
 * @returns 决策（含实际要用的 kbId）。
 */
export declare function decideAutoReply(cfg: ClawbotInstanceConfig): AutoReplyDecision;
/** 一条候选消息里，本模块关心的那几列。 */
export interface ReplyableMessage {
    direction: 'in' | 'out';
    msgType: string | null;
    content: string;
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
export declare function isReplyable(msg: ReplyableMessage): boolean;
/**
 * 从一批候选里挑出**唯一**要回的那条：最后一条可回复的入站文本。
 *
 * 为什么一批只回一条（而不是逐条回）：服务端不下发消息时间，所以「刚绑定、首次长轮询
 * 拉回一堆历史」与「用户连发几条」在数据上长得一样。逐条回会在前者场景里刷屏，
 * 只回最后一条把上界压到 1 条，且对后者也是最自然的反应（人也不会逐条回）。
 * @param candidates - 本批新落库的消息。
 * @returns 目标（无则 null）与被跳过的条数（供审计说清「这一批跳了多少」）。
 */
export declare function pickReplyTarget(candidates: readonly ReplyableMessage[]): {
    target: ReplyableMessage | null;
    dropped: number;
};
/** 超长回复截断（带上「已截断」字样，不假装完整）。 */
export declare function truncateReply(text: string): string;
export interface AutoReplyRunnerDeps {
    /** 取该实例的配置（**每次现读**：用户关掉开关后，队列里的下一条就不再回）。 */
    readConfig: (slot: number) => ClawbotInstanceConfig;
    /** 统一问答管道（缺省 = 未注入 ⇒ 自动回复不可用，只记账不发送）。 */
    ask?: ClawbotAskFn;
    /** 发送（生产 = `sendClawbotText`：**成功才落库**，失败不写假记录）。 */
    send: (slot: number, text: string) => Promise<ClawbotSendResult>;
    /** 审计一行（`category='clawbot'`）。 */
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    /** 回复成功后通知外层（发 `clawbot/message` 事件，前端实时可见）。 */
    onReplied: (info: {
        slot: number;
        id: number;
    }) => void;
}
/**
 * 自动回复执行器：**全局单飞 + 每实例队列**。
 *
 * 单飞是全局的（同一时刻只有一轮 ask 在跑）：模型调用本来就慢，并发起来只会
 * 让几个号一起变慢，还不好排查；而会话内部的顺序本来就必须串行。
 * @param deps - 注入依赖（见 {@link AutoReplyRunnerDeps}）。
 * @returns `consider(slot, candidates)` 与测试用的 `pending()`。
 */
export declare function createAutoReplyRunner(deps: AutoReplyRunnerDeps): {
    consider: (slot: number, candidates: readonly ReplyableMessage[]) => void;
    pending: () => number;
};
