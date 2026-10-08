import type { OperationLogClearResult, OperationLogEntry, OperationLogQuery, OperationLogSnapshot } from '../types.ts';
/**
 * 慢操作阈值：只有 ≥ 这个耗时（毫秒）才把 `duration_ms` 写进库。
 *
 * 与宿主 `wechat-host.js` 里那条 `if (cost > 1000)` same threshold —— 两处口径一致，
 * 于是「宿主日志里的慢」与「审计表里的慢」指的是同一批调用，可以互相印证。
 * 不记快操作的理由见 `OperationLogEntry.durationMs`。
 */
export declare const SLOW_OPERATION_MS = 1000;
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
