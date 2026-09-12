import type { TasksSnapshot, TaskMutationResult } from '../types.ts';
/** List tasks (newest first). */
export declare function listTasks(decryptedDir: string): TasksSnapshot;
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
//# sourceMappingURL=wechat-tasks.d.ts.map