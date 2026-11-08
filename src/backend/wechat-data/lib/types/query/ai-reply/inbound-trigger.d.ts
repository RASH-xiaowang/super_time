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
}
export interface InboundMessageLike {
    type?: number;
    renderType?: string;
    displayText?: string;
    strContent?: string;
    msgContent?: string;
    isSender?: number;
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
/** 对方发来的、可自动回复的消息。自己的消息永远不作为触发锚点。 */
export declare function isInboundReplyTrigger(message: InboundMessageLike): boolean;
/** 图片与自定义表情都会作为视觉内容进入模型。 */
export declare function visualKindOf(message: InboundMessageLike): 'image' | 'sticker' | null;
