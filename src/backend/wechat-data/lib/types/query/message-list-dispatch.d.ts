import type { MessageListDispatchIntent } from './message-list-store.ts';
import type { RetryFetch } from '../net/fetch-retry.ts';
import type { ChatAiReplyDispatchReason } from './ai-reply/types.ts';
import type { MessageListBatchResendResult, MessageListDispatchBatchResult, MessageListRecord, MessageListRecordResult } from '../types.ts';
export { probeMessageListWebhook, queryMessageListWebhookJob, redactWebhookEndpoint, safeWebhookJobId } from './message-list-webhook-probe.ts';
/** 消息列表投递结果，带 AI 回复运行器可分支处理的稳定原因。 */
export type MessageListRecordDispatchResult = MessageListRecordResult & {
    reason?: ChatAiReplyDispatchReason;
};
export interface MessageListDispatchDeps {
    decodeImage: (username: string, localId: number, options?: {
        fileOnly?: boolean;
    }) => Promise<{
        url?: string;
        file?: string;
    }>;
    gate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    fetchImpl?: RetryFetch;
}
/**
 * 投递一条记录。地址优先使用记录里的快照；没有快照时按当前规则重新匹配。
 * @param decryptedDir - 解密数据根。
 * @param id - 消息记录 id。
 * @param deps - 图片解码、隐私闸与 fetch 注入。
 * @param intent - automatic 只认领 pending；人工单条才可重试终态记录。
 * @returns 最新记录与成功/失败原因；无匹配规则时保持 pending。
 */
export declare function dispatchMessageListRecord(decryptedDir: string, id: number, deps: MessageListDispatchDeps, intent?: MessageListDispatchIntent): Promise<MessageListRecordDispatchResult>;
/** 仅投递本次新建的 AI 回复记录；sourceRef 已存在时禁止重复出网。 */
export declare function dispatchCreatedMessageListRecord(decryptedDir: string, result: MessageListRecordResult, deps: MessageListDispatchDeps): Promise<MessageListRecordDispatchResult>;
/** 批量重发前的安全门槛；返回空串表示可处理。 */
export declare function batchResendSkipReason(record: MessageListRecord): string;
/**
 * 按显式勾选的记录 id 顺序重发。
 *
 * 只处理消息列表中已经落库的记录，重复 id 会先去重，单次最多 100 条。逐条复用
 * {@link dispatchMessageListRecord}，因此附件解析、隐私闸、记录锁与状态回写都走同一条链路。
 */
export declare function batchResendMessageListRecords(decryptedDir: string, ids: readonly number[], deps: MessageListDispatchDeps): Promise<MessageListBatchResendResult>;
/**
 * 投递一批有地址快照的 pending 记录。
 * 没有地址的记录不会进入自动批次，避免永久占用队头；用户配好规则后可点「重发」。
 * @param decryptedDir - 解密数据根。
 * @param deps - 投递依赖。
 * @param limit - 本拍最多投几条。
 * @returns 成功/失败计数与前 10 条失败原因。
 */
export declare function dispatchPendingMessageListRecords(decryptedDir: string, deps: MessageListDispatchDeps, limit?: number): Promise<MessageListDispatchBatchResult>;
