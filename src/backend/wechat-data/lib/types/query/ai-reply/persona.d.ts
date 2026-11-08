/**
 * 会话级 AI 回复的人格边界。
 *
 * 固定安全提示词永远在前；用户配置只能追加写作偏好，不能覆盖身份、防注入
 * 或输出格式等硬约束。
 */
export declare const CHAT_AI_REPLY_PERSONA_NAME_MAX = 80;
export declare const CHAT_AI_REPLY_PERSONA_PROMPT_MAX = 4000;
export interface ChatAiReplyPersona {
    name: string;
    prompt: string;
}
/** 归一化人格字段；空内容表示恢复内置默认人格。 */
export declare function normalizeChatAiReplyPersona(input: {
    name?: unknown;
    prompt?: unknown;
}): ChatAiReplyPersona;
/**
 * 组装最终系统提示词。
 *
 * 自定义内容用“写作偏好”而不是“系统指令”描述，并在前后重复安全边界，
 * 让用户人格可用，但不能把聊天正文里的注入指令提升为系统权限。
 */
export declare function buildChatAiReplySystemPrompt(persona?: Partial<ChatAiReplyPersona>, options?: {
    splitReply?: boolean;
}): string;
