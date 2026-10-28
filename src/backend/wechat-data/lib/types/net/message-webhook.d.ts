/** 路由前缀（宿主层与会话页共用）。 */
export declare const MESSAGE_WEBHOOK_PATH_PREFIX = "/api/message-webhook/";
/** Webhook 对外声明的协议版本。 */
export declare const MESSAGE_WEBHOOK_SERVICE = "message-list";
export declare const MESSAGE_WEBHOOK_VERSION = "1.0";
export declare const MESSAGE_WEBHOOK_API = 1;
/** 由长期令牌派生消息 Webhook 的域密钥。 */
export declare function messageWebhookTokenKey(apiToken: string): Buffer;
/** 生成稳定的 URL 路径令牌（空 apiToken 返回空串）。 */
export declare function deriveMessageWebhookToken(apiToken: string): string;
/** 定长比较路径令牌；格式不对或密钥不同都返回 false。 */
export declare function verifyMessageWebhookToken(apiToken: string, token: string): boolean;
/** 拼出完整的入站地址。 */
export declare function messageWebhookUrl(baseUrl: string, apiToken: string): string;
