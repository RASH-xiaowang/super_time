import type { DatabaseSync } from './db-open.ts';
import type { TaskBatchMutationResult, TaskInfo, TaskInfoInput, TaskInfoMutationResult, TaskInfoSnapshot, TaskInfoStatus, TaskTriggerQuery, TaskTriggerRecord, TaskTriggerSnapshot } from '../types.ts';
export { scanTaskTriggers } from './task-center-scan.ts';
export type { ScanTaskTriggersOptions } from './task-center-scan.ts';
export { dispatchPendingTaskCallbacks, dispatchTaskCallback } from './task-center-callback.ts';
export type { PendingDispatchResult, TaskDispatchDeps } from './task-center-callback.ts';
/** 一次批量删除最多处理多少条；超过时整单拒绝，避免静默只删一部分。 */
export declare const TASK_BATCH_DELETE_MAX = 500;
/** 任务库路径（`decryptedDir` 的父目录下）。 */
export declare function taskDbPath(decryptedDir: string): string;
/** 任务库是否存在（读路径据此区分「确实还没有数据」与「库打不开」）。 */
export declare function storeExists(decryptedDir: string): boolean;
/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
export declare function taskErrorText(e: unknown): string;
export declare function taskCellStr(v: unknown): string;
export declare function taskCellNum(v: unknown): number;
/** 整数夹取（非数字按 fallback，其余夹到 [min, max]）。 */
export declare function clampTaskInt(v: unknown, fallback: number, min: number, max: number): number;
/**
 * 清洗批量删除 id：只保留唯一正整数，并拒绝空选择和过大批次。
 *
 * Remote 入参来自序列化 JSON，不能只靠 TypeScript 类型；重复 id 去重后返回，
 * 超过上限时整单拒绝而不是截断 —— 用户勾了 501 条却只删 500 条更难排查。
 * @param raw - 入参里的 ids（运行时可能不是数组）。
 * @param max - 允许的最大条数。
 * @returns 清洗后的 id 或中文错误。
 */
export declare function cleanTaskBatchIds(raw: unknown, max?: number): {
    ids: number[];
    error?: string;
};
/** 建表语句（两张表一次建齐；`IF NOT EXISTS` ⇒ 可在每个写连接里重复执行）。 */
export declare function ensureTaskSchema(db: DatabaseSync): void;
/** `task_info` 行 → 契约里的 `TaskInfo`（`last_scan_seq` 是扫描内部状态，不进契约）。 */
export declare function rowToTask(r: Record<string, unknown>): TaskInfo;
/** `task_triggers` 行 → 契约里的 `TaskTriggerRecord`。 */
export declare function rowToTrigger(r: Record<string, unknown>): TaskTriggerRecord;
/**
 * 任务列表（id DESC，最新在前）。
 *
 * 读也走 `withWritableDb`：这是**我们自己的写库**，异常退出后可能残留 `-wal/-shm`，
 * 只读连接会因此报错、让面板显示 `readError`（而数据其实可读）。`withDb` 留给微信
 * 解密库那种只读快照（与 `chat-collect.ts` 的口径一致）。
 * @param decryptedDir - 解密数据根。
 * @returns 任务快照；读库失败时带 `readError`（与「确实没有任务」区分）。
 */
export declare function listTaskInfos(decryptedDir: string): TaskInfoSnapshot;
/**
 * 触发记录列表（triggered_at DESC, id DESC，最新在前）。
 *
 * 翻页用 `(triggered_at, id)` 复合游标：先取同一时间戳下 id 更小的记录，再用剩余额度
 * 取严格更早的记录。顺序不能反过来 —— 更早记录如果先占满本页，同一时间戳的剩余记录
 * 会被游标永久越过。
 * @param decryptedDir - 解密数据根。
 * @param query - 可选的 `taskId` / `search` 过滤、`limit`（夹 1..200，默认 100）与复合游标。
 * @returns 记录快照（含真实总数与下一页游标）；读库失败时带 `readError`。
 */
export declare function listTaskTriggers(decryptedDir: string, query?: TaskTriggerQuery): TaskTriggerSnapshot;
/**
 * 新建 / 更新一个任务（`input.id` 缺省 = 新建）。
 *
 * 校验是"整单失败"而非"部分修正"：任务配置决定会不会触发与往哪发，静默改掉用户填的
 * 东西（比如把非法 URL 清空）比直接拒绝更难排查。
 * 更新语义见 {@link resolveTaskFields}：缺省字段沿用旧值（含 `status` 与 `photoLimit`）。
 * @param decryptedDir - 解密数据根。
 * @param input - 任务配置。
 * @param selfUsername - 登录账号 wxid（水位初始化读消息用，可缺省）。
 * @returns 写结果（失败带中文 error，不抛异常）。
 */
export declare function saveTaskInfo(decryptedDir: string, input: TaskInfoInput, selfUsername?: string): TaskInfoMutationResult;
/**
 * 标记「待完善 / 已完善」。
 *
 * 从「待完善」变「已完善」时重置水位 —— 这是本域唯一会改变"从哪条消息开始看"的写操作。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @param status - 目标状态。
 * @param selfUsername - 登录账号 wxid（水位初始化读消息用，可缺省）。
 * @returns 写结果（失败带中文 error）。
 */
export declare function setTaskInfoStatus(decryptedDir: string, id: number, status: TaskInfoStatus, selfUsername?: string): TaskInfoMutationResult;
/**
 * 删除任务。**触发记录刻意保留**：任务删了，记录仍是已经发生过的事实，
 * 前端也能凭记录里的快照字段继续展示（见 `types-taskcenter.ts` 的 `task_name` 注释）。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @returns 写结果（失败带中文 error）。
 */
export declare function deleteTaskInfo(decryptedDir: string, id: number): TaskInfoMutationResult;
/**
 * 批量删除任务配置。与单条删除同一语义：**触发记录刻意保留**，它们是已经发生过的事实。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 任务 id 列表（运行时未受类型保护）。
 * @returns 实际删除行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export declare function deleteTaskInfos(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult;
/**
 * 批量删除触发记录，并在**同一事务**里重算受影响任务的统计缓存。
 *
 * `deleteTaskInfos` 刻意保留触发记录，所以这里要让任务行的 `trigger_count` /
 * `last_triggered_at` 重新等于记录表事实；否则删了记录，左栏仍显示旧的触发次数。
 * 任一步失败都回滚，不能留下「记录删了、统计没更新」的半完成状态。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 触发记录 id 列表（运行时未受类型保护）。
 * @returns 实际删除行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export declare function deleteTaskTriggers(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult;
