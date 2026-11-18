import type { DatabaseSync } from '../db-open.ts';
import type { ChatAiReplyTrace, ChatAiReplyTracePatch } from './types.ts';
/** 建表；所有读写连接都调用，因此必须可重复执行。 */
export declare function ensureChatAiReplyTraceSchema(db: DatabaseSync): void;
/**
 * 写入一条留痕补丁（不存在则建行，存在则只覆盖给出的字段）。
 * @param decryptedDir - 解密数据根。
 * @param patch - 增量字段；`recordId` 非法时直接忽略。
 */
export declare function writeChatAiReplyTrace(decryptedDir: string, patch: ChatAiReplyTracePatch): void;
/**
 * 删除单条记录的留痕（重新生成前清掉上一次的上下文/输出）。
 * @param db - 调用方已经持有的写连接。
 * @param recordId - 消息列表记录 id。
 * @returns 删除条数；表不存在或 id 非法时为 0。
 */
export declare function deleteChatAiReplyTraceOnDb(db: DatabaseSync, recordId: number): number;
/**
 * 清理孤儿留痕：记录被删除后，其过程留痕不能继续留在库里。
 *
 * 用「不在 records 里」的集合条件，而不是让调用方逐个收集 id ——
 * 整组删除时一个 id 可能带走多个分段，逐 id 收集容易漏。
 * @param db - 调用方已经持有的写连接（通常已在事务内）。
 * @returns 本次删除的留痕条数；表不存在时静默返回 0。
 */
export declare function pruneOrphanChatAiReplyTraces(db: DatabaseSync): number;
export type ChatAiReplyTraceReadResult = {
    ok: true;
    trace: ChatAiReplyTrace;
} | {
    ok: false;
    error: string;
};
/**
 * 读取一条记录的过程留痕。
 * @param decryptedDir - 解密数据根。
 * @param recordId - 消息列表记录 id。
 * @returns 找不到时 `ok:false`（旧记录本来就没有留痕）。
 */
export declare function readChatAiReplyTrace(decryptedDir: string, recordId: number): ChatAiReplyTraceReadResult;
