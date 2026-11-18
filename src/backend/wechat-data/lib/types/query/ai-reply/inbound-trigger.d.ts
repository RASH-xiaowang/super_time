/**
 * AI 回复的入站消息判定与稳定占位文本。
 *
 * 触发扫描、启用时的水位计算和上下文收集必须共用这一份规则，否则很容易出现
 * 「扫描能看到消息、上下文却把它丢掉」或相反的分叉。实际会话消息都可触发，
 * 只有系统、撤回、空消息、未知/不支持类型和拍一拍等非对话事件被排除。
 */
import { type RenderKind } from '../parse.ts';
export interface InboundMessageRich {
    type?: string;
    title?: string;
    nickname?: string;
    desc?: string;
    md5?: string;
    emojiUrl?: string;
    /** 转账金额（`￥100.00`）或红包金额（已去掉货币符号）。 */
    amount?: string;
    /** 视频 / 通话时长（秒）。 */
    durationSec?: number;
    /** 语音时长（毫秒）。 */
    durationMs?: number;
    /** 通话结局原文，例如「已拒绝」「通话时长 00:21」。 */
    status?: string;
    /** 通话类型：语音 / 视频。 */
    voipType?: string;
    /** 引用消息的原发言人显示名。 */
    referName?: string;
    /** 通话是否接通（其它设备接听也算接通）。 */
    connected?: boolean;
}
export interface InboundMessageLike {
    type?: number;
    renderType?: string;
    displayText?: string;
    strContent?: string;
    msgContent?: string;
    isSender?: number;
    /**
     * **群聊专用**：这条消息是否 @ 了登录账号。
     *
     * 由消息读取边界（`remotes/chat-ai-reply.ts`）按 `source` 列的解构化
     * `atuserlist` 计算后注入，不在这里猜正文里的 `@昵称`（昵称可改、重名、
     * 正文普通 @ 都会误判）。单聊消息不带这个字段 ⇒ 不施加任何限制。
     */
    mentionSelf?: boolean;
    rich?: InboundMessageRich;
}
/** 将新快照的 renderType、rich.type 和旧快照的 local_type 归一成同一分类。 */
export declare function renderKindOf(message: InboundMessageLike): RenderKind | undefined;
/**
 * 返回适合交给模型的稳定文本。
 *
 * 文本类直接使用正文；媒体与卡片消息在旧快照缺少 displayText 时按 rich/type
 * 合成 `[图片]`、`[语音]`、`[文件 合同.pdf]` 等占位，不能因为展示字段为空就
 * 让整条消息失去触发资格。
 */
export declare function messageDisplayText(message: InboundMessageLike): string;
/** 可放进会话上下文的文本；系统/撤回等事件返回空串。 */
export declare function contextualMessageText(message: InboundMessageLike): string;
/**
 * 对方发来的、可自动回复的消息。
 *
 * 自己的消息永远不是锚点。群聊额外要求 **@我**：`mentionSelf` 由读取边界注入，
 * 未注入（单聊）时不做限制 —— 这样纯函数不需要知道登录账号是谁。
 * @param message - 待判定的消息。
 * @returns 是否可作为自动回复的锚点。
 */
export declare function isInboundReplyTrigger(message: InboundMessageLike): boolean;
/** 图片与自定义表情都会作为视觉内容进入模型。 */
export declare function visualKindOf(message: InboundMessageLike): 'image' | 'sticker' | null;
/**
 * 是否语音消息。语音要先用本地 whisper 转成文字再进上下文，
 * 否则模型只看到 `[语音]` 这个占位符，等于少了一整条对话。
 */
export declare function isVoiceMessage(message: InboundMessageLike): boolean;
