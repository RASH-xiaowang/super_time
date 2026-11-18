import type { ChatAiReplyContextStats } from './context-budget.ts';
import type { ReplyImageCandidate } from '../reply-suggest.ts';
export { AI_REPLY_INPUT_TOKEN_BUDGET } from './context-budget.ts';
export declare const AI_REPLY_CONTEXT_LIMIT = 60;
/** 单次回复最多附带几张视觉内容：控制在常见视觉模型的请求上限内。 */
export declare const AI_REPLY_IMAGE_LIMIT = 3;
/** 图片/表情解码后的总字节预算；超出时从最旧的视觉内容开始舍弃。 */
export declare const AI_REPLY_IMAGE_TOTAL_BYTES: number;
/**
 * 单次上下文最多转写几条语音。
 *
 * whisper 是 CPU 密集型子进程，一次回复里排十几条会让「等回复」变成几十秒；
 * 保留最近的几条既覆盖了对话主体，又把延迟压在可接受范围。
 */
export declare const AI_REPLY_VOICE_TRANSCRIBE_LIMIT = 5;
/**
 * 一轮回复里语音转写的**总时长预算**（毫秒）。
 *
 * large-v3 在本机实测单条约 26–31 秒，5 条串行要两分半；无人值守的自动回复
 * 等不起。超预算后不再起新的转写，已完成的那几条照常用，其余保留 `[语音]` 占位。
 * 转写结果按 svr_id 落盘，所以「超预算的那几条」下次会命中缓存，只慢一次。
 */
export declare const AI_REPLY_VOICE_BUDGET_MS = 45000;
export interface ChatAiReplyContext {
    lines: string[];
    /** 只含正文行，不含时间标记/省略行；知识库检索用它，避免日期污染查询。 */
    dialogueLines?: string[];
    /** 只包含预算窗口内的图片/表情消息；窗口外的图片不会被解码或发送。 */
    imageCandidates?: ReplyImageCandidate[];
    /** 预算窗口内、还没有转写文本的语音消息 localId（时间正序、最多 5 条）。 */
    voiceCandidates?: number[];
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
 * @param voiceTexts - 已转写的语音文本（localId → 文本）；缺省时语音保留 `[语音]` 占位。
 * @param sinceCreateTime - 只保留这个时间点（秒）之后的消息；0/缺省表示不限
 *   （沿用「最近 60 条」）。会话级「上下文时间窗」由调用方换算后传入。
 */
export declare function collectChatAiReplyContext(decryptedDir: string, 
/** `talker` 是 `WechatSession.username` 的别名。 */
talker: string, selfUsername: string, anchorLocalId?: number, voiceTexts?: ReadonlyMap<number, string>, sinceCreateTime?: number): ChatAiReplyContext;
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
export declare function buildChatAiReplyPrompt(lines: readonly string[], imageCount?: number, 
/** `group` 时说明触发条件：只有 @ 我 的消息才会被回复。 */
scope?: 'private' | 'group'): string;
/** 模型输出清洗：去围栏/成对引号/前缀，拒绝明显解释段。 */
export declare function normalizeChatAiReplyText(raw: string, maxChars?: number): string;
