import type { DatabaseSync } from './db-open.ts';
import type { MessageListBatchDeleteResult, MessageListImage, MessageListQuery, MessageListRecord, MessageListRecordInput, MessageListRecordResult, MessageListSnapshot, MessageListSource, MessageListWebhookPayload } from '../types.ts';
export interface MessageListRecordCursor {
    triggeredAt: number;
    id: number;
}
/** 复合游标使用不透明字符串，前端只原样回传，不拼时间/id。 */
export declare function encodeMessageListCursor(cursor: MessageListRecordCursor): string;
/** 解析续页游标；非法游标必须返回错误，不能静默退回第一页造成重复。 */
export declare function decodeMessageListCursor(raw: unknown): MessageListRecordCursor | undefined;
/** 消息记录快照（默认 200 条，最新在前；超出单页上限时显式标记 truncated）。 */
export declare function listMessageListRecords(decryptedDir: string, query?: MessageListQuery): MessageListSnapshot;
/** 按 id 读一条记录。 */
export declare function getMessageListRecord(decryptedDir: string, id: number): MessageListRecord | undefined;
/** 当前消息记录仍引用的本机暂存附件 id，用于安全清理 spool。 */
export declare function referencedStagedAttachmentIds(decryptedDir: string): Set<string> | undefined;
/**
 * 清理本机附件 spool。默认调用必须由本机桌面端触发；不带记录引用的
 * 40 位文件名超过 7 天后才会被删除。
 */
export declare function cleanupMessageListAttachmentSpool(decryptedDir: string, now?: number): Promise<{
    removed: number;
    failed: number;
}>;
export interface InsertRecordFields {
    replyId: string;
    chatName: string;
    targetName: string;
    text: string;
    images: MessageListImage[];
    triggeredAt: number;
    source: MessageListSource;
    note: string;
    chatUsername: string;
    targetUsername: string;
    webhookUrl: string;
    taskId?: number;
    triggerId?: number;
    sourceRef?: string;
    segmentGroupRef?: string;
    segmentIndex?: number;
    segmentCount?: number;
}
export declare function insertRecordAt(decryptedDir: string, db: DatabaseSync, fields: InsertRecordFields, now?: number): MessageListRecordResult;
/**
 * 插入一条手动消息（写入时按当前规则保存 Webhook 快照）。
 * @param decryptedDir - 解密数据根。
 * @param input - 用户输入。
 * @returns 新记录；无匹配规则时仍成功落库，状态 pending。
 */
export declare function insertMessageListRecord(decryptedDir: string, input: MessageListRecordInput): MessageListRecordResult;
/**
 * 清洗并插入局域网 Webhook 入站记录；来源由服务端强制为 `webhook`。
 * @param decryptedDir - 解密数据根。
 * @param payload - 入站 JSON（兼容 target/message/attachments 别名）。
 * @returns 新记录或可读校验错误。
 */
export declare function ingestMessageListWebhook(decryptedDir: string, payload: MessageListWebhookPayload): MessageListRecordResult;
export interface TaskGreetingInput {
    taskId: number;
    triggerId: number;
    taskName: string;
    chatName: string;
    chatUsername: string;
    targetName: string;
    targetUsername: string;
    images: MessageListImage[];
    triggeredAt: number;
}
/**
 * 任务触发成功后，在同一个任务库连接里插入一条问候。
 * `sourceRef` 保证同一任务触发记录最多一条问候。
 */
export declare function insertTaskTriggerGreeting(decryptedDir: string, db: DatabaseSync, input: TaskGreetingInput): MessageListRecordResult;
/**
 * 按 id 批量删除消息记录。
 *
 * 整个批次在同一事务内完成；`dispatching` 记录会被跳过，避免删除后投递线程
 * 仍继续出网。ID 会先去重，返回结果保持调用方给出的顺序。
 */
export declare function deleteMessageListRecords(decryptedDir: string, rawIds: readonly number[]): MessageListBatchDeleteResult;
/** 取一批有地址快照的待投递记录 id。 */
export declare function pendingMessageListRecordIds(decryptedDir: string, limit: number): number[];
