import type { RetryFetch } from '../net/fetch-retry.ts';
import type { MessageListDispatchBatchResult, MessageListRecordResult } from '../types.ts';
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
 * @returns 最新记录与成功/失败原因；无匹配规则时保持 pending。
 */
export declare function dispatchMessageListRecord(decryptedDir: string, id: number, deps: MessageListDispatchDeps): Promise<MessageListRecordResult>;
/**
 * 投递一批有地址快照的 pending 记录。
 * 没有地址的记录不会进入自动批次，避免永久占用队头；用户配好规则后可点「重发」。
 * @param decryptedDir - 解密数据根。
 * @param deps - 投递依赖。
 * @param limit - 本拍最多投几条。
 * @returns 成功/失败计数与前 10 条失败原因。
 */
export declare function dispatchPendingMessageListRecords(decryptedDir: string, deps: MessageListDispatchDeps, limit?: number): Promise<MessageListDispatchBatchResult>;
