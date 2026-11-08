import type { MessageListRecordDispatchResult } from '../query/message-list-dispatch.ts';
import type { RetryFetch } from '../net/fetch-retry.ts';
import type { AiReplyMessageListInput, MessageListBatchDeleteResult, MessageListBatchResendResult, MessageListDispatchBatchResult, MessageListMutationResult, MessageListQuery, MessageListRecordInput, MessageListRecordResult, MessageListRuleInput, MessageListRuleSnapshot, MessageListSnapshot, MessageListWebhookInfo, MessageListWebhookJob, MessageListWebhookPayload, MessageListWebhookProbe, OperationCategory, OperationStatus } from '../types.ts';
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
    probeMessageListWebhook(options: {
        recordId?: number;
        ruleId?: number;
    }): Promise<MessageListWebhookProbe>;
    queryMessageListWebhookJob(options: {
        recordId: number;
        jobId?: string;
    }): Promise<MessageListWebhookJob>;
    saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult;
    deleteMessageListRule(options: {
        id: number;
    }): MessageListMutationResult;
    insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult>;
    /**
     * AI runner 的内部唯一写入口：先落消息列表，只有新建记录才投递。
     * 该处理器不作为 Remote 暴露，避免绕过上下文/隐私闸直接出网。
     */
    insertAiReplyRecord(options: AiReplyMessageListInput): Promise<MessageListRecordResult>;
    resendMessageListRecord(options: {
        id: number;
    }): Promise<MessageListRecordResult>;
    batchResendMessageListRecords(options: {
        ids: number[];
    }): Promise<MessageListBatchResendResult>;
    batchDeleteMessageListRecords(options: {
        ids: number[];
    }): Promise<MessageListBatchDeleteResult>;
    /** 同域内部投递入口，供 AI runner 在记录落库后调用；不注册为 Remote。 */
    dispatchRecord(id: number): Promise<MessageListRecordDispatchResult>;
    ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult>;
    getMessageListWebhookInfo(): MessageListWebhookInfo;
    dispatchPending(): Promise<MessageListDispatchBatchResult>;
};
