import { redactWebhookEndpoint, redactWebhookSecrets, trimText } from '../net/webhook-endpoint.ts';
import type { RetryFetch } from '../net/fetch-retry.ts';
import type { MessageListWebhookJob, MessageListWebhookProbe } from '../types.ts';
export interface MessageListWebhookDeps {
    fetchImpl?: RetryFetch;
}
export declare function errorText(e: unknown): string;
export { redactWebhookEndpoint, redactWebhookSecrets, trimText };
export declare function safeErrorText(value: string, webhookUrl: string): string;
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
