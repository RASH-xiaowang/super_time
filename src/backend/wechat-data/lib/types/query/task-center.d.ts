import type { DatabaseSync } from './db-open.ts';
import { storeExists, taskDbPath } from './task-db.ts';
import type { TaskBatchMutationResult, TaskInfo, TaskInfoInput, TaskInfoMutationResult, TaskInfoSnapshot, TaskInfoStatus, TaskTriggerQuery, TaskTriggerRecord, TaskTriggerSnapshot } from '../types.ts';
export { cleanTaskBatchIds, clampTaskInt, taskCellNum, taskCellStr, taskErrorText, TASK_BATCH_DELETE_MAX, } from './task-center-utils.ts';
export { scanTaskTriggers } from './task-center-scan.ts';
export type { ScanTaskTriggersOptions } from './task-center-scan.ts';
export { dispatchPendingTaskCallbacks, dispatchTaskCallback } from './task-center-callback.ts';
export type { PendingDispatchResult, TaskDispatchDeps, TaskDispatchOptions } from './task-center-callback.ts';
export { storeExists, taskDbPath };
export { parseTriggerImages, parseTriggerTexts } from './task-center-trigger-parse.ts';
/** 建表语句（两张表一次建齐；`IF NOT EXISTS` ⇒ 可在每个写连接里重复执行）。 */
export declare function ensureTaskSchema(db: DatabaseSync): void;
/** `task_triggers` 行 → 契约里的 `TaskTriggerRecord`。 */
export declare function rowToTrigger(r: Record<string, unknown>, decryptedDir?: string): TaskTriggerRecord;
/** `task_info` 行 → 契约里的 `TaskInfo`（`last_scan_seq` 是扫描内部状态，不进契约）。 */
export declare function rowToTask(r: Record<string, unknown>, decryptedDir?: string): TaskInfo;
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
 * 删除任务，并在同一事务里删掉它的全部触发记录。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @returns 写结果（失败带中文 error）。
 */
export declare function deleteTaskInfo(decryptedDir: string, id: number): TaskInfoMutationResult;
/**
 * 批量删除任务，并在同一事务里删掉这些任务的全部触发记录。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 任务 id 列表（运行时未受类型保护）。
 * @returns 实际删除的任务行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export declare function deleteTaskInfos(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult;
/**
 * 批量删除触发记录，并在**同一事务**里重算受影响任务的统计缓存。
 *
 * 删掉记录后，把还在的任务的 `trigger_count` / `last_triggered_at` 重新算成记录表事实；
 * 否则左栏仍显示旧的触发次数。
 * 任一步失败都回滚，不能留下「记录删了、统计没更新」的半完成状态。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 触发记录 id 列表（运行时未受类型保护）。
 * @returns 实际删除行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export declare function deleteTaskTriggers(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult;
