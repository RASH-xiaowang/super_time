import type { RetryFetch } from '../net/fetch-retry.ts';
import type { MessageListWebhookJob, MessageListWebhookProbe } from '../types.ts';
export interface MessageListWebhookDeps {
    fetchImpl?: RetryFetch;
}
export declare function errorText(e: unknown): string;
export declare function trimText(value: unknown, max: number): string;
export declare function redactWebhookSecrets(text: string, webhookUrl: string): string;
export declare function safeErrorText(value: string, webhookUrl: string): string;
/** Return only the origin, path skeleton, and a masked token. */
export declare function redactWebhookEndpoint(webhookUrl: string): string;
/** Remote job ids must remain conservative ASCII identifiers. */
export declare function safeWebhookJobId(value: unknown): string;
/** GET health check against an address already stored on a record or rule. */
export declare function probeMessageListWebhook(decryptedDir: string, input: {
    recordId?: number;
    ruleId?: number;
}, deps?: MessageListWebhookDeps): Promise<MessageListWebhookProbe>;
/**
 * Query an asynchronous job using the stored job id or the same strictly
 * validated id supplied by the caller.
 */
export declare function queryMessageListWebhookJob(decryptedDir: string, input: {
    recordId: number;
    jobId?: string;
}, deps?: MessageListWebhookDeps): Promise<MessageListWebhookJob>;
