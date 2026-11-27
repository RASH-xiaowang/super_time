export declare const CHAT_AI_REPLY_PERSONA_NAME_MAX = 80;
export declare const CHAT_AI_REPLY_PERSONA_PROMPT_MAX = 4000;
/** 知识库材料进入 system 提示词的字符预算；超出时按检索顺序截断。 */
export declare const CHAT_AI_REPLY_KB_PROMPT_MAX = 3000;
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
    /** 已检索到的知识库片段；与 `kbRequested` 同时出现才表示知识库参与本轮回复。 */
    kbSnippets?: readonly string[];
    /** 用户是否勾选了知识库参与回复（空命中时也要如实告诉模型）。 */
    kbRequested?: boolean;
    /** 查无资料时必须原样使用的转人工话术。 */
    handoff?: string;
    /** 额外禁说词。 */
    blocked?: string;
}): string;
