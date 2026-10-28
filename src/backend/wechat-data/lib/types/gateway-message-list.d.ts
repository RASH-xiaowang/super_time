import type { MessageListDispatchBatchResult, MessageListMutationResult, MessageListQuery, MessageListRecordInput, MessageListRecordResult, MessageListRuleInput, MessageListRuleSnapshot, MessageListSnapshot, MessageListWebhookInfo, MessageListWebhookPayload } from './types.ts';
import { GatewayLayaOps } from './gateway-laya-ops.ts';
import { createMessageListRemotes } from './remotes/message-list.ts';
export declare abstract class GatewayMessageList extends GatewayLayaOps {
    listMessageListRecords(options?: MessageListQuery): MessageListSnapshot;
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
    protected _messageListRemotes?: ReturnType<typeof createMessageListRemotes>;
    protected _messageListDispatch: Promise<MessageListDispatchBatchResult> | null;
    protected _messageListDispatchQueued: boolean;
    /** 单飞投递一批消息列表记录；同一时刻只开一个任务库写连接。 */
    protected scheduleMessageListDispatch(): Promise<MessageListDispatchBatchResult>;
    protected emitMessageListUpdated(created: number, dispatched: number): void;
    protected messageWebhookInfo(): MessageListWebhookInfo;
    protected messageListRemotes(): ReturnType<typeof createMessageListRemotes>;
}
