/**
 * 问答入口的角色、人称和称呼策略。
 *
 * 微信问答与会话内 AI 问答的回答者用「我」，当前提问者用「你」。
 *
 * @module query/answer-runtime/persona
 */
/** 手动问答规则块的幂等标记。 */
export declare const MANUAL_QA_PERSONA_MARKER = "\u3010\u4EBA\u79F0\u4E0E\u89D2\u8272\u89C4\u5219\uFF5C\u5FAE\u4FE1\u95EE\u7B54\u4E0E AI \u95EE\u7B54\u3011";
/**
 * 微信问答 / 会话内 AI 问答的固定人称规则。
 *
 * 规则同时约束第一、第二、第三人称和多轮沿用，避免模型在同一回复里把
 * 「我」「你」「他」的含义换来换去。
 */
export declare const MANUAL_QA_PERSONA_RULES: string;
/** 手动问答的用户消息末尾自检，防止长材料把系统规则淹没。 */
export declare const MANUAL_QA_OUTPUT_PRONOUN_REMINDER = "\u4EBA\u79F0\u81EA\u68C0\uFF1A\u56DE\u590D\u91CC\u7684\u300C\u6211\u300D\u53EA\u6307 AI \u56DE\u7B54\u8005\uFF0C\u4E0D\u8981\u7528\u8EAB\u4EFD\u8BCD\u81EA\u79F0\uFF1B\u300C\u6211\u4EEC\u300D\u300C\u54B1\u4EEC\u300D\u4E0D\u5F97\u628A AI \u548C\u63D0\u95EE\u8005\u8BF4\u6210\u540C\u4E00\u65B9\uFF1B\u7B2C\u4E8C\u4EBA\u79F0\u7EDF\u4E00\u7528\u300C\u4F60\u300D\u6307\u5F53\u524D\u63D0\u95EE\u8005\uFF1B\u7B2C\u4E09\u65B9\u5148\u5199\u59D3\u540D\u6216\u6635\u79F0\uFF0C\u8EAB\u4EFD\u6216\u6307\u4EE3\u4E0D\u660E\u5148\u6F84\u6E05\uFF1B\u5F15\u7528\u539F\u6587\u4FDD\u7559\u539F\u4EBA\u79F0\u3002";
/**
 * 微信问答（页签）与会话内 AI 问答共用的默认系统提示词。
 */
export declare const WECHAT_QA_SYSTEM_PROMPT: string;
/**
 * 提问优化器的系统提示词。
 *
 * 优化结果仍由当前提问者发出，所以必须保留提问者原有视角；建议则直接对
 * 提问者说「你」，不能把提问者改写成第三人称「用户」。
 */
export declare const ASK_OPTIMIZE_SYSTEM_PROMPT: string;
/**
 * 历史消息的角色标签。
 *
 * 只用于模型输入，不面向最终用户；统一成「提问者 / AI 回答者」，
 * 避免模型把内部角色名误写进回复。
 *
 * @param role - 历史消息角色。
 * @returns 明确的中文角色标签。
 */
export declare function conversationRoleLabel(role: 'user' | 'assistant'): string;
/**
 * 把多轮历史格式化成带明确角色的文本。
 *
 * @param history - 历史消息。
 * @returns 每行一条的对话记录。
 */
export declare function formatConversationHistory(history: ReadonlyArray<{
    role: 'user' | 'assistant';
    content: string;
}>): string;
/**
 * 给自定义问答提示词追加固定人称规则（幂等）。
 *
 * @param prompt - 用户或调用方提供的提示词。
 * @returns 已包含固定规则的提示词。
 */
export declare function withManualQaPersonaRules(prompt: string): string;
