/**
 * 会话级 AI 回复的安全红线。
 *
 * 合规、防注入、不泄密是固定护栏，人格和聊天正文都不能关掉。
 * 业务上可配置的只有两件事：查无资料时的转人工话术，以及额外禁说词。
 */
export declare const CHAT_AI_REPLY_HANDOFF_DEFAULT = "\u62B1\u6B49\u6211\u4E0D\u592A\u6E05\u695A\uFF0C\u5EFA\u8BAE\u4E3A\u60A8\u8F6C\u63A5\u4EBA\u5DE5";
export declare const CHAT_AI_REPLY_REFUSAL = "\u62B1\u6B49\uFF0C\u8FD9\u4E2A\u6211\u6CA1\u6CD5\u56DE\u7B54\u3002";
export declare const CHAT_AI_REPLY_HANDOFF_MAX = 80;
export declare const CHAT_AI_REPLY_BLOCKED_MAX = 400;
/** 空话术回落到内置转人工句。 */
export declare function normalizeSafetyHandoff(value: unknown): string;
/** 禁说词：逗号或顿号分隔，最多 20 个。 */
export declare function normalizeSafetyBlocked(value: unknown): string;
export declare function safetyBlockedTerms(value: string): string[];
/** 写进系统提示词的固定红线。人格段必须排在它后面。 */
export declare function safetyPromptLines(handoff: string, blocked: string): string[];
/**
 * 决定这轮回复要不要被护栏替换。
 *
 * 没有 `reply` 时只看输入和知识库是否为空，用来在调用模型之前收口。
 * @returns 替换后的正文与原因；`null` 表示可以继续。
 */
export declare function decideChatAiReplySafety(input: {
    latestPeer: string;
    reply?: string;
    kbEnabled: boolean;
    kbSnippets?: readonly string[];
    allowedText: string;
    handoff: string;
    blocked: string;
}): {
    text: string;
    reason: string;
} | null;
