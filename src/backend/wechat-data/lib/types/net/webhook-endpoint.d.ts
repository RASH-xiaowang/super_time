/**
 * Webhook 端点的**共用**判定与脱敏。
 *
 * 为什么要单独一格：Feather 的 `/webhook/<token>` 地址被三处用到 ——
 * 消息列表投递、消息列表健康探测、以及 2026-11-18 新增的定时总结推送。
 * 「这个地址算不算合法的发送端点」「日志里怎么把 token 抹掉」必须是**同一把尺子**：
 * 三处各写一遍正则，改一处忘一处就会出现「这里能存、那里拒绝」或者「某条路径把 token
 * 原样写进日志」。这些函数是纯函数、无 I/O。
 *
 * @module net/webhook-endpoint
 */
/** Webhook 响应体截断上限（够排障，不把整个 HTML 错误页存进库）。 */
export declare const WEBHOOK_TEXT_MAX = 500;
/** 截断到上限（不改变空串语义）。 */
export declare function trimText(value: unknown, max: number): string;
/**
 * 把一段下游错误文本里可能出现的 webhook 凭据抹掉。
 * @param text - 下游返回的错误或响应体。
 * @param webhookUrl - 本次请求用的地址（用于精确抹掉路径 token 与 query 值）。
 * @returns 可安全落库/展示的文本。
 */
export declare function redactWebhookSecrets(text: string, webhookUrl: string): string;
/**
 * 只回显 origin + 路径骨架（token 变 `***`），给界面与日志用。
 * @param webhookUrl - 已保存或待保存的地址。
 * @returns 脱敏地址；解析失败返回空串。
 */
export declare function redactWebhookEndpoint(webhookUrl: string): string;
/**
 * 是不是 Feather 的**发送**端点 `/webhook/<token>`。
 *
 * 刻意排除 `/webhook/<token>/resources`：那是附件上传子路径，拿来发正文会失败，
 * 而失败发生在真正发送时 —— 不如在保存时就说清楚。
 * @param url - 待判定的地址。
 * @returns 形状是否吻合。
 */
export declare function isTokenizedWebhookEndpoint(url: string): boolean;
