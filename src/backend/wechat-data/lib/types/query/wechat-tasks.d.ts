import type { TasksSnapshot, TaskMutationResult } from '../types.ts';
/**
 * Read result: still a `TasksSnapshot` (既有调用方按 items/total 用不受影响），
 * 额外带一个**只在读失败时出现**的 `readError`。
 *
 * 改前 `catch { return { items: [], total: 0 } }` ——「库打不开」与「确无待办」在界面上
 * 长得一模一样，用户按「暂无待办」去排查会查错方向（N19 的 `res.error` 是同一课）。
 */
export interface TasksSnapshotRead extends TasksSnapshot {
    /** 读不到库时非空（此时 items 恒为 []）；确无待办时为 undefined。 */
    readError?: string;
}
/** List tasks (newest first). */
export declare function listTasks(decryptedDir: string): TasksSnapshotRead;
/** Insert one task (extracted or manual). Skips open duplicates by title. */
export declare function insertTask(decryptedDir: string, task: {
    title: string;
    dueAt?: number;
    sourceUsername?: string;
    sourceLocalId?: number;
    messageTime?: number;
}): TaskMutationResult;
/** Set task status ('open' | 'done'). */
export declare function setTaskStatus(decryptedDir: string, id: number, status: 'open' | 'done'): TaskMutationResult;
/** Delete a task. */
export declare function deleteTask(decryptedDir: string, id: number): TaskMutationResult;
