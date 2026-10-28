import type { RetryFetch } from '../net/fetch-retry.ts';
import type { MessageListDispatchBatchResult, MessageListMutationResult, MessageListQuery, MessageListRecordInput, MessageListRecordResult, MessageListRuleInput, MessageListRuleSnapshot, MessageListSnapshot, MessageListWebhookInfo, MessageListWebhookPayload, OperationCategory, OperationStatus } from '../types.ts';
export interface MessageListImageContext {
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey: number;
}
export interface CreateMessageListRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    imageContext: () => MessageListImageContext;
    webhookInfo: () => MessageListWebhookInfo;
    changed?: (created: number, dispatched: number) => void;
    fetchImpl?: RetryFetch;
}
export declare function createMessageListRemotes(rc: CreateMessageListRemotesInputs): {
    listMessageListRecords(query?: MessageListQuery): MessageListSnapshot;
    listMessageListRules(): MessageListRuleSnapshot;
    saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult;
    deleteMessageListRule(options: {
        id: number;
    }): MessageListMutationResult;
    insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult>;
    resendMessageListRecord(options: {
        id: number;
    }): Promise<MessageListRecordResult>;
    ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult>;
    getMessageListWebhookInfo(): MessageListWebhookInfo;
    dispatchPending(): Promise<MessageListDispatchBatchResult>;
};
