import type { DatabaseSync } from '../db-open.ts';
export interface ChatAiReplyDefaultWebhookView {
    configured: boolean;
    endpoint: string;
    updatedAt: number;
}
export type ChatAiReplyDefaultWebhookReadResult = {
    ok: true;
    webhook: ChatAiReplyDefaultWebhookView;
} | {
    ok: false;
    error: string;
};
export interface SaveChatAiReplyDefaultWebhookInput {
    accountKey: string;
    chatUsername: string;
    chatName?: string;
    webhookUrl: string;
}
export type SaveChatAiReplyDefaultWebhookResult = {
    ok: true;
    webhook: ChatAiReplyDefaultWebhookView;
} | {
    ok: false;
    error: string;
};
export interface ApplyChatAiReplyDefaultWebhookInput {
    accountKey: string;
    chatUsername: string;
    chatName?: string;
    targetName?: string;
    greetingText?: string;
    note?: string;
}
export type ApplyChatAiReplyDefaultWebhookResult = {
    ok: true;
    configured: true;
    endpoint: string;
    updatedAt: number;
    ruleId: number;
    ruleCreated: boolean;
    backfilled: number;
} | {
    ok: false;
    configured: boolean;
    endpoint: string;
    updatedAt: number;
    reason: 'missing_webhook' | 'rule_binding_failed' | 'store_error';
    error: string;
};
/** 只展示 origin 与路径骨架；令牌、查询串、hash 和 URL 凭据都不返回界面。 */
export declare function redactChatAiReplyDefaultWebhookEndpoint(webhookUrl: string): string;
/** 建表；与消息列表、AI 回复设置共用任务库。 */
export declare function ensureChatAiReplyDefaultWebhookSchema(db: DatabaseSync): void;
/** 严格读取；完整地址永远不会出现在返回值中。 */
export declare function readChatAiReplyDefaultWebhookStrict(decryptedDir: string, accountKey: string, chatUsername: string): ChatAiReplyDefaultWebhookReadResult;
/** 展示层使用的宽容读取；读失败按未配置处理。 */
export declare function readChatAiReplyDefaultWebhook(decryptedDir: string, accountKey: string, chatUsername: string): ChatAiReplyDefaultWebhookView;
/** 保存并替换当前账号、当前会话的默认 Webhook。 */
export declare function saveChatAiReplyDefaultWebhook(decryptedDir: string, input: SaveChatAiReplyDefaultWebhookInput): SaveChatAiReplyDefaultWebhookResult;
/**
 * 应用当前账号、当前会话已保存的默认 Webhook。
 *
 * 保存默认值后或开启 AI 回复时调用。只创建缺失的精确规则，并把同类无地址的
 * AI pending 记录回填到该规则地址，等待消息列表扫描投递。
 */
export declare function applyChatAiReplyDefaultWebhook(decryptedDir: string, input: ApplyChatAiReplyDefaultWebhookInput): ApplyChatAiReplyDefaultWebhookResult;
