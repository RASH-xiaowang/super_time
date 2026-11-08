/**
 * 消息列表 schema、字段迁移、行映射与展示身份补全。
 */
import type { DatabaseSync } from './db-open.ts';
import type { MessageListAttachmentValidationOptions } from './message-list-attachments.ts';
import type { MessageListImage, MessageListRecord, MessageListRecordResult, MessageListRule } from '../types.ts';
/** 建表；所有写连接都调用，因此可重复执行。 */
export declare function ensureMessageListSchema(db: DatabaseSync): void;
/** 兼容旧的只读调用；落库与入站入口必须直接使用严格校验。 */
export declare function sanitizeMessageListImages(raw: unknown, options?: MessageListAttachmentValidationOptions): MessageListImage[];
export declare function parseImages(raw: unknown): MessageListImage[];
/** 附件解析错误只挂在当前记录对象上，不改变对外记录结构。 */
export declare function messageListImagesError(record: MessageListRecord): string | undefined;
/** `message_list_records` 行 → 契约对象。 */
export declare function rowToMessageListRecord(row: Record<string, unknown>): MessageListRecord;
/**
 * Canonicalize persisted chat/target ids and hide unresolved legacy hashes.
 *
 * This is intentionally applied on reads as well as writes: databases from
 * older builds may already contain a message-table hash. Reads must never keep
 * that physical key in UI state, navigation, or a subsequent cache write.
 * @param decryptedDir - decrypted data root.
 * @param record - mutable record returned from a row mapping.
 */
export declare function canonicalizeMessageListRecord(decryptedDir: string, record: MessageListRecord): void;
/** 给记录补只用于展示的企业名称；规则/投递仍使用原始 chatName/targetName。 */
export declare function enrichMessageListRecords(decryptedDir: string, records: MessageListRecord[]): void;
/** Return an inserted/updated record with the same display-only identity fields as list reads. */
export declare function enrichMessageListResult(decryptedDir: string, result: MessageListRecordResult): MessageListRecordResult;
/** `message_list_rules` 行 → 契约对象。 */
export declare function rowToMessageListRule(row: Record<string, unknown>): MessageListRule;
