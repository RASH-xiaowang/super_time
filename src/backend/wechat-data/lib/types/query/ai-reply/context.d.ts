import type { ChatAiReplyContextStats } from './context-budget.ts';
import type { ReplyImageCandidate } from '../reply-suggest.ts';
export { AI_REPLY_INPUT_TOKEN_BUDGET } from './context-budget.ts';
export declare const AI_REPLY_CONTEXT_LIMIT = 60;
/** 单次回复最多附带几张视觉内容：控制在常见视觉模型的请求上限内。 */
export declare const AI_REPLY_IMAGE_LIMIT = 3;
/** 图片/表情解码后的总字节预算；超出时从最旧的视觉内容开始舍弃。 */
export declare const AI_REPLY_IMAGE_TOTAL_BYTES: number;
export interface ChatAiReplyContext {
    lines: string[];
    /** 只含正文行，不含时间标记/省略行；知识库检索用它，避免日期污染查询。 */
    dialogueLines?: string[];
    /** 只包含预算窗口内的图片/表情消息；窗口外的图片不会被解码或发送。 */
    imageCandidates?: ReplyImageCandidate[];
    latestPeer: string;
    count: number;
    prompt: string;
    /** 本次上下文装配的统计；测试注入的上下文可省略。 */
    stats?: ChatAiReplyContextStats;
}
/** 已解码、可直接放进多模态请求的一张图片。 */
export interface ChatAiReplyContextImage {
    localId: number;
    dataUrl: string;
    mediaType: string;
    bytes: number;
}
export interface ChatAiReplyImageDecodeOptions {
    wechatBaseDir?: string;
    aesKey?: string | Uint8Array;
    xorKey?: number;
    maxImages?: number;
    maxBytes?: number;
}
/**
 * 收集截至指定锚点的当前会话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 `WechatSession.username` 的别名。
 * @param selfUsername - 登录账号 wxid。
 * @param anchorLocalId - 触发消息 local_id；存在时不会把更晚的消息用于本次回复。
 */
export declare function collectChatAiReplyContext(decryptedDir: string, talker: string, selfUsername: string, anchorLocalId?: number): ChatAiReplyContext;
/**
 * 把上下文里的图片/表情定位键解码成模型可接收的 data URL。
 *
 * `talker` 是 `WechatSession.username` 的别名；只读取当前会话的索引，不把本机
 * 路径交给模型。自定义表情先走本地解密缓存，再按消息里的 CDN 地址兜底；解码
 * 失败或超出预算的单张媒体会被跳过，不能让一张坏图阻断整次 AI 回复。
 */
export declare function decodeChatAiReplyImages(decryptedDir: string, decodedDir: string, 
/** `talker` 是 `WechatSession.username` 的别名。 */
talker: string, candidates: readonly ReplyImageCandidate[], options?: ChatAiReplyImageDecodeOptions): Promise<ChatAiReplyContextImage[]>;
/** 生成完整回复的提示词；注入内容只作为资料，不赋任何工具能力。 */
export declare function buildChatAiReplyPrompt(lines: readonly string[], imageCount?: number): string;
/** 模型输出清洗：去围栏/成对引号/前缀，拒绝明显解释段。 */
export declare function normalizeChatAiReplyText(raw: string, maxChars?: number): string;
