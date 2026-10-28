import type { DatabaseSync } from './db-open.ts';
import type { MessageListImage, MessageListMutationResult, MessageListQuery, MessageListRecord, MessageListRecordInput, MessageListRecordResult, MessageListRule, MessageListRuleInput, MessageListRuleSnapshot, MessageListSnapshot, MessageListStatus, MessageListWebhookPayload } from '../types.ts';
import type { TaskTriggerImage } from '../types-taskcenter.ts';
/** 建表；所有写连接都调用，因此可重复执行。 */
export declare function ensureMessageListSchema(db: DatabaseSync): void;
/**
 * 清洗图片列表。坏项丢弃，不把任意本机路径带进库或下游。
 * @param raw - 入参图片/附件（运行时不可信）。
 * @returns 最多 9 项且总 data URL 字符数受限的安全图片引用。
 */
export declare function sanitizeMessageListImages(raw: unknown): MessageListImage[];
/** `message_list_records` 行 → 契约对象。 */
export declare function rowToMessageListRecord(row: Record<string, unknown>): MessageListRecord;
/** `message_list_rules` 行 → 契约对象。 */
export declare function rowToMessageListRule(row: Record<string, unknown>): MessageListRule;
/** 规则匹配：精确对 > 同会话通配对象 > 任意会话指定对象 > 全局通配。 */
export declare function matchMessageListRuleAt(db: DatabaseSync, chatName: string, targetName: string): MessageListRule | undefined;
/** 按当前规则表匹配一条规则；库不存在/读失败时返回 undefined。 */
export declare function matchMessageListRule(decryptedDir: string, chatName: string, targetName: string): MessageListRule | undefined;
/** 消息记录快照（默认 200 条，最新在前）。 */
export declare function listMessageListRecords(decryptedDir: string, query?: MessageListQuery): MessageListSnapshot;
/** 规则列表（最新更新在前）。 */
export declare function listMessageListRules(decryptedDir: string): MessageListRuleSnapshot;
/** 按 id 读一条记录。 */
export declare function getMessageListRecord(decryptedDir: string, id: number): MessageListRecord | undefined;
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
    images: TaskTriggerImage[];
    triggeredAt: number;
}
/**
 * 任务触发成功后，在同一个任务库连接里插入一条问候。
 * `sourceRef` 保证同一任务触发记录最多一条问候。
 */
export declare function insertTaskTriggerGreeting(db: DatabaseSync, input: TaskGreetingInput): MessageListRecordResult;
/** 删除一条规则；已有记录的地址快照不受影响。 */
export declare function deleteMessageListRule(decryptedDir: string, id: number): MessageListMutationResult;
/**
 * 新建 / 更新规则，并为尚无地址快照的同类 pending 记录补上地址。
 * @param decryptedDir - 解密数据根。
 * @param input - 规则入参；`id` 缺省 = 新建。
 */
export declare function saveMessageListRule(decryptedDir: string, input: MessageListRuleInput): MessageListMutationResult;
/** 投递结果回写（状态、错误、尝试次数、下游返回的回复 id）。 */
export declare function saveMessageListDispatchResult(decryptedDir: string, id: number, outcome: {
    status: MessageListStatus;
    error: string;
    responseSummary: string;
    replyId?: string;
    webhookUrl?: string;
    /** 只有真正发出 HTTP 请求时才累加尝试次数。 */
    countAttempt?: boolean;
}): MessageListRecord | undefined;
/** 取一批有地址快照的待投递记录 id。 */
export declare function pendingMessageListRecordIds(decryptedDir: string, limit: number): number[];
