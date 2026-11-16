import type { AiReplyMessageListCompleteInput, AiReplyMessageListInput, AiReplyMessageListReserveInput, MessageListRecordResult } from '../types.ts';
import type { ChatAiReplySegmentSnapshot, ChatAiReplySegmentsResult } from './ai-reply/types.ts';
/**
 * 写入一条 AI 回复。来源固定为 ai_reply，幂等键由调用方提供。
 * 该函数只负责落库；投递必须由消息列表 dispatch 完成。
 */
export declare function insertAiReplyMessageListRecord(decryptedDir: string, input: AiReplyMessageListInput): MessageListRecordResult;
/**
 * 为一次 AI 回复先建立 pending 预约记录。
 *
 * 预约正文为空且不保存 Webhook 地址，因此不会被 `pendingMessageListRecordIds`
 * 自动领取。生成成功后必须再调用 `completeAiReplyMessageListRecord`。
 */
export declare function reserveAiReplyMessageListRecord(decryptedDir: string, input: AiReplyMessageListReserveInput): MessageListRecordResult;
/**
 * 生成成功后补全预约记录。只有空正文的 pending AI 预约可以被完成，
 * 防止迟到任务覆盖已经生成或已经投递的记录。Webhook 地址仍由投递入口在
 * 原子认领时写入，避免 pending 记录提前被后台批次选中。
 */
export declare function completeAiReplyMessageListRecord(decryptedDir: string, id: number, input: AiReplyMessageListCompleteInput): MessageListRecordResult;
/**
 * 原子补全一个 AI 回复分组。
 *
 * 第一段复用预约记录，后续段在同一事务中插入；任一段写入失败都会回滚，
 * 不会留下“后半段凭空多出来”的半成品。重复调用按 sourceRef/段序号幂等。
 */
export declare function completeAiReplyMessageListRecordSegments(decryptedDir: string, id: number, input: {
    segments: string[];
    note?: string;
}): ChatAiReplySegmentsResult;
/** 按基础 sourceRef 读取完整分段组；普通单条记录返回一段。 */
export declare function listAiReplyMessageListSegments(decryptedDir: string, sourceRef: string): ChatAiReplySegmentSnapshot[];
/**
 * 某段投递失败后，把后续尚未发送的 pending 段标成失败。
 * 已成功/已受理的段保持不变，后续不会因为前序失败而乱序补发。
 */
export declare function failAiReplyMessageListSegmentsAfter(decryptedDir: string, sourceRef: string, afterSegmentIndex: number, error: string): {
    ok: boolean;
    error?: string;
};
/**
 * 将尚未完成的 AI 预约标记为失败，保留在消息列表里供用户排查。
 * 已完成或已进入投递态的记录不会被失败回写覆盖。
 */
export declare function failAiReplyMessageListRecord(decryptedDir: string, id: number, error: string): MessageListRecordResult;
/**
 * 删除一组**从未发送**的 AI 回复预约。
 *
 * 被同一轮更新消息取代的预约没有任何发送价值；把它标成失败只会在「任务信息」
 * 里堆出一条条无意义的失败记录（真机实测：4 分钟 40+ 条「会话已有更新的消息」）。
 * 只有整组都还是 pending（没有任何分段进过 dispatching/queued/running/success）
 * 才允许删除；一旦有分段进过投递，事实必须保留给人工核对。
 *
 * 幂等：记录已经不存在时返回 ok=true、removed=0。
 */
export declare function dropAiReplyMessageListRecord(decryptedDir: string, id: number, sourceRef?: string): {
    ok: boolean;
    removed: number;
    error?: string;
};
/** AI 回复恢复器的只读孤儿预约快照；不暴露完整消息正文给扫描器。 */
export interface PendingAiReplyMessageListRecord {
    id: number;
    sourceRef: string;
    chatUsername: string;
    targetUsername: string;
}
/**
 * 列出所有仍处于 pending 的 AI 回复预约。
 *
 * 设置行可能已被删除、关闭或迁移失败；调用方必须用 sourceRef 中的账号/会话
 * 身份判断是否真的没有 enabled 设置，再决定是否安全收口。这里不按是否有
 * Webhook 地址过滤，因为预约阶段地址故意为空。
 */
export declare function listPendingAiReplyMessageListRecords(decryptedDir: string, limit?: number): PendingAiReplyMessageListRecord[];
