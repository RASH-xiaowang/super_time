import type { OperationLogClearResult, OperationLogEntry, OperationLogQuery, OperationLogSnapshot } from '../types.ts';
/** Append one operation row. Best-effort: a logging failure never breaks the operation it records. */
export declare function recordOperation(decryptedDir: string, entry: Omit<OperationLogEntry, 'id' | 'ts'> & {
    ts?: number;
}): void;
/**
 * Read matching operation rows, newest first. `total` counts every match,
 * ignoring `limit`.
 * @param decryptedDir - decrypted WeChat data root.
 * @param query - optional time-range / category / status / limit filters.
 * @returns OperationLogSnapshot: matching items + full match count.
 */
export declare function listOperations(decryptedDir: string, query?: OperationLogQuery): OperationLogSnapshot;
/**
 * Delete all operation-log rows.
 * @param decryptedDir - decrypted WeChat data root.
 * @returns OperationLogClearResult: ok + removed row count.
 */
export declare function clearOperationLog(decryptedDir: string): OperationLogClearResult;
//# sourceMappingURL=operation-log.d.ts.map