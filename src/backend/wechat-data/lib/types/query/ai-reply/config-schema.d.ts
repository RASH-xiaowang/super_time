/**
 * 会话级 AI 回复的表结构与列迁移。
 *
 * 从 `config-store.ts` 拆出（M21 单文件 1000 行棘轮）：本模块只关心
 * 「这个库长什么样、缺哪列补哪列」，不涉及读写语义。读写仍全部在
 * `config-store.ts`，两边通过 `ensureChatAiReplySchema` 单点衔接。
 *
 * @module query/ai-reply/config-schema
 */
import type { DatabaseSync } from '../db-open.ts';
/**
 * pending 锚点的 revision 可信标记。
 *
 * 旧行没有标记 —— 宁可让 runner fail-closed，也不能把它们当成「revision 合法」，
 * 否则一次错误恢复就可能补发过期答案。
 */
export declare const PENDING_REVISION_VALID = "valid";
export declare const PENDING_REVISION_LEGACY = "legacy";
/**
 * 建表 + 补列；与消息列表同库，可重复调用。
 * @param db - 已打开的写连接。
 */
export declare function ensureChatAiReplySchema(db: DatabaseSync): void;
