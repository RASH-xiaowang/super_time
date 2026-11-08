export declare const CHAT_AI_REPLY_SEGMENT_MAX_UTF16 = 25;
export declare const CHAT_AI_REPLY_TEXT_MAX = 4000;
export declare const CHAT_AI_REPLY_MAX_SEGMENTS = 50;
export interface ChatAiReplySourceRefParts {
    accountKey: string;
    chatUsername: string;
    createTime: number;
    localId: number;
    /** 第一条为 1；后续分段从 2 开始。 */
    segmentIndex: number;
    /** 去掉可选 `:segment:<n>` 后的基础幂等键。 */
    baseSourceRef: string;
}
export declare function parseChatAiReplySourceRef(value: string | undefined): ChatAiReplySourceRefParts | null;
export declare function chatAiReplySegmentSourceRef(baseSourceRef: string, segmentIndex: number): string;
/**
 * 优先按空行分段，再按句末标点、次级标点和 UTF-16 安全硬切逐级降级。
 * 每段长度不超过 cap，且不会把 emoji 的代理对拆开。
 */
export declare function splitChatAiReplyText(text: string, limit?: number): string[];
