/** One summary task. */
export interface SummaryTask {
    id: number;
    groupUsername: string;
    groupName: string;
    targetUsers: string[];
    format: string;
    customPrompt: string;
    scheduleTime: string;
    enabled: boolean;
    lastRunAt?: number;
    lastStatus: string;
    lastError: string;
    createdAt: number;
    updatedAt: number;
}
/** One generated summary record. */
export interface SummaryRecord {
    id: number;
    taskId: number;
    groupUsername: string;
    groupName?: string;
    summaryDate: string;
    summary: string;
    messageCount: number;
    status: string;
    error: string;
    createdAt: number;
}
/**
 * List summary tasks.
 * @param decryptedDir - decrypted data root.
 * @returns summary task items plus total count.
 */
export declare function listSummaryTasks(decryptedDir: string): {
    items: SummaryTask[];
    total: number;
};
/**
 * Save a task (insert when id=0, else update).
 * @param decryptedDir - decrypted data root.
 * @param task - task payload (id 0 inserts, otherwise updates).
 * @returns ok plus the saved task id, or an error description.
 */
export declare function saveSummaryTask(decryptedDir: string, task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: number;
}): {
    ok: boolean;
    id?: number;
    error?: string;
};
/**
 * Delete a task by id.
 * @param decryptedDir - decrypted data root.
 * @param id - task id to delete.
 * @returns ok, or an error description.
 */
/** Record a task's last run state (timestamp/status/error) so the scheduler does not re-run the same minute. */
export declare function updateSummaryTaskRunState(decryptedDir: string, id: number, lastRunAt: number, lastStatus: string, lastError: string): {
    ok: boolean;
    error?: string;
};
export declare function deleteSummaryTask(decryptedDir: string, id: number): {
    ok: boolean;
    error?: string;
};
/**
 * Toggle a task enabled state.
 * @param decryptedDir - decrypted data root.
 * @param id - task id to toggle.
 * @param enabled - new enabled state.
 * @returns ok, or an error description.
 */
export declare function toggleSummaryTask(decryptedDir: string, id: number, enabled: boolean): {
    ok: boolean;
    error?: string;
};
/**
 * Record a generated summary.
 * @param decryptedDir - decrypted data root.
 * @param rec - summary record payload (id/createdAt are generated).
 * @returns ok plus the new record id, or an error description.
 */
export declare function saveSummaryRecord(decryptedDir: string, rec: Omit<SummaryRecord, 'id' | 'createdAt'>): {
    ok: boolean;
    id?: number;
    error?: string;
};
/**
 * Delete a generated record by id.
 * @param decryptedDir - decrypted data root.
 * @param id - record id to delete.
 * @returns ok, or an error description.
 */
export declare function deleteSummaryRecord(decryptedDir: string, id: number): {
    ok: boolean;
    error?: string;
};
/**
 * List generated records (optionally for one task).
 * @param decryptedDir - decrypted data root.
 * @param taskId - optional task id to filter by.
 * @returns summary record items plus total count.
 */
export declare function listSummaryRecords(decryptedDir: string, taskId?: number): {
    items: SummaryRecord[];
    total: number;
};
//# sourceMappingURL=summary-tasks.d.ts.map