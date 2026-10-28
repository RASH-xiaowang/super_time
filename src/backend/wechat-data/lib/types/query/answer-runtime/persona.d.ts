/**
 * 问答与自动回复共用的角色、人称和称呼策略。
 *
 * 三套入口虽然走同一条运行时，但说话身份不同：
 *   · 微信问答 / 会话内 AI 问答：回答者用「我」，当前提问者用「你」；
 *   · ClawBot 自动回复：回复正文里的「我」必须指当前微信账号本人，「你」指当前聊天联系人。
 *
 * 这些规则不能混成一份。手动问答若套用「主人代理」，模型会把自己当成用户；
 * 自动回复若套用普通问答规则，又会出现「我替你问下账号本人」这种角色错位。
 *
 * @module query/answer-runtime/persona
 */
/** 手动问答规则块的幂等标记。 */
export declare const MANUAL_QA_PERSONA_MARKER = "\u3010\u4EBA\u79F0\u4E0E\u89D2\u8272\u89C4\u5219\uFF5C\u5FAE\u4FE1\u95EE\u7B54\u4E0E AI \u95EE\u7B54\u3011";
/** ClawBot 规则块的幂等标记。 */
export declare const CLAWBOT_PERSONA_MARKER = "\u3010\u4EBA\u79F0\u4E0E\u89D2\u8272\u89C4\u5219\uFF5CClawBot \u81EA\u52A8\u56DE\u590D\u3011";
/**
 * 微信问答 / 会话内 AI 问答的固定人称规则。
 *
 * 规则同时约束第一、第二、第三人称和多轮沿用，避免模型在同一回复里把
 * 「我」「你」「他」的含义换来换去。
 */
export declare const MANUAL_QA_PERSONA_RULES: string;
/**
 * ClawBot 自动回复的固定人称规则。
 *
 * 这不是普通问答角色：模型输出的每句话都会以当前微信账号本人的身份发给聊天联系人。
 */
export declare const CLAWBOT_PERSONA_RULES: string;
/** 手动问答的用户消息末尾自检，防止长材料把系统规则淹没。 */
export declare const MANUAL_QA_OUTPUT_PRONOUN_REMINDER = "\u4EBA\u79F0\u81EA\u68C0\uFF1A\u56DE\u590D\u91CC\u7684\u300C\u6211\u300D\u53EA\u6307 AI \u56DE\u7B54\u8005\uFF0C\u4E0D\u8981\u7528\u8EAB\u4EFD\u8BCD\u81EA\u79F0\uFF1B\u300C\u6211\u4EEC\u300D\u300C\u54B1\u4EEC\u300D\u4E0D\u5F97\u628A AI \u548C\u63D0\u95EE\u8005\u8BF4\u6210\u540C\u4E00\u65B9\uFF1B\u7B2C\u4E8C\u4EBA\u79F0\u7EDF\u4E00\u7528\u300C\u4F60\u300D\u6307\u5F53\u524D\u63D0\u95EE\u8005\uFF1B\u7B2C\u4E09\u65B9\u5148\u5199\u59D3\u540D\u6216\u6635\u79F0\uFF0C\u8EAB\u4EFD\u6216\u6307\u4EE3\u4E0D\u660E\u5148\u6F84\u6E05\uFF1B\u5F15\u7528\u539F\u6587\u4FDD\u7559\u539F\u4EBA\u79F0\u3002";
/** ClawBot 自动回复的用户消息末尾自检。 */
export declare const CLAWBOT_OUTPUT_PRONOUN_REMINDER = "\u4EBA\u79F0\u81EA\u68C0\uFF1A\u56DE\u590D\u91CC\u7684\u300C\u6211\u300D\u53EA\u6307\u5F53\u524D\u5FAE\u4FE1\u8D26\u53F7\u672C\u4EBA\uFF0C\u4E0D\u5199\u300C\u672C\u4EBA\u300D\u81EA\u79F0\uFF1B\u300C\u4F60\u300D\u53EA\u6307\u5F53\u524D\u804A\u5929\u8054\u7CFB\u4EBA\uFF1B\u7B2C\u4E09\u65B9\u5148\u5199\u59D3\u540D\u6216\u6635\u79F0\uFF0C\u6307\u4EE3\u4E0D\u660E\u5148\u95EE\u6E05\uFF1B\u5F15\u7528\u6750\u6599\u4FDD\u7559\u539F\u4EBA\u79F0\uFF1B\u4E0D\u8981\u7528\u300C\u6211\u4EEC\u300D\u300C\u54B1\u4EEC\u300D\u6CDB\u6307\u3002";
/** ClawBot 遇到无法核对的关键数值时，以账号本人身份使用的安全回复。 */
export declare const CLAWBOT_UNVERIFIED_VALUE_REPLY = "\u8FD9\u4E2A\u6570\u5B57\u6211\u8FD9\u8FB9\u6CA1\u6CD5\u786E\u8BA4\uFF0C\u6211\u5148\u6838\u5B9E\u4E00\u4E0B\u518D\u56DE\u4F60\u3002";
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
/** 对话角色在提示词里的显示名。 */
export type PersonaConversationKind = 'qa' | 'clawbot';
/**
 * 历史消息的角色标签。
 *
 * 只用于模型输入，不面向最终用户；统一成「提问者 / AI 回答者」或
 * 「聊天联系人 / 账号本人」，避免模型把内部角色名误写进回复。
 *
 * @param role - 历史消息角色。
 * @param kind - 手动问答或 ClawBot 对话。
 * @returns 明确的中文角色标签。
 */
export declare function conversationRoleLabel(role: 'user' | 'assistant', kind: PersonaConversationKind): string;
/**
 * 把多轮历史格式化成带明确角色的文本。
 *
 * @param history - 历史消息。
 * @param kind - 手动问答或 ClawBot 对话。
 * @returns 每行一条的对话记录。
 */
export declare function formatConversationHistory(history: ReadonlyArray<{
    role: 'user' | 'assistant';
    content: string;
}>, kind: PersonaConversationKind): string;
/**
 * 给自定义问答提示词追加固定人称规则（幂等）。
 *
 * @param prompt - 用户或调用方提供的提示词。
 * @returns 已包含固定规则的提示词。
 */
export declare function withManualQaPersonaRules(prompt: string): string;
/**
 * 给自定义 ClawBot 提示词追加固定人称规则（幂等）。
 *
 * 用户仍可自定义人设、语气和领域规则，但不能把「我」改成 AI 自称，也不能
 * 把聊天联系人叫成「用户」。
 *
 * @param prompt - 用户提供的 ClawBot 提示词。
 * @returns 已包含固定角色约束的提示词。
 */
export declare function withClawbotPersonaRules(prompt: string): string;
