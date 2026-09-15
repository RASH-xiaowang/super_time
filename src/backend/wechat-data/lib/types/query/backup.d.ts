import type { StreamControl } from './zip.ts';
import type { BackupEntry, BackupPreviewSnapshot, BackupRestoreResult } from '../types.ts';
/**
 * Preview a backup's contents (bounded file/db list) before restore.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name.
 * @returns the preview snapshot (bounded items) or an empty result.
 */
export declare function previewBackup(decryptedDir: string, name: string): BackupPreviewSnapshot;
/**
 * List existing backups (name, size, modified, kind).
 * @param decryptedDir - decrypted data root.
 * @returns backup items plus total count.
 */
export declare function listBackups(decryptedDir: string): {
    items: BackupEntry[];
    total: number;
};
/**
 * Create a timestamped directory backup of the decrypted DBs.
 *
 * 先在同级目录复制到临时名、全部成功后再改名 —— 直接往最终名字里复制时，某个子目录
 * 复制失败会留下一个**看起来成功、实际缺库**的备份（旧实现甚至 `catch {}` 吞掉失败后
 * 照常返回成功条目，用户以为备份好了）；这里把「部分失败」显式报出去并清掉半成品。
 * @param decryptedDir - decrypted data root.
 * @returns the created backup entry.
 */
export declare function createBackup(decryptedDir: string): BackupEntry;
/**
 * Create an encrypted `.wcb` backup bundle.
 *
 * 写盘走 temp + rename：旧实现直接往最终名字里流式写，中途失败（磁盘满、取消、进程被掐）
 * 会留下一个长度不对却带着合法 MAGIC 的 `.wcb` —— 用户以为备份好了，恢复时才发现截断。
 * 另外旧实现用 `out.write()` 但不看返回值（大备份未落盘的数据在内存里堆积），
 * 且错误监听是在写完之后才挂上（循环里出错会变成未捕获异常）。
 * @param decryptedDir - decrypted data root.
 * @param password - encryption password.
 * @param ctrl - 可选的进度/取消（逐个文件上报；取消后不留半成品）。
 * @returns the created backup entry.
 */
export declare function createEncryptedBackup(decryptedDir: string, password: string, ctrl?: StreamControl): Promise<BackupEntry>;
/**
 * Restore an encrypted `.wcb` backup into `<backups>/<name>.restored`.
 * @param decryptedDir - decrypted data root.
 * @param name - backup file name (must end .wcb).
 * @param password - encryption password.
 * @returns restore result with the extracted path.
 */
export declare function restoreEncryptedBackup(decryptedDir: string, name: string, password: string): BackupRestoreResult;
/**
 * Delete one backup by name.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name to delete.
 * @returns ok, or an error description when the backup cannot be removed.
 */
export declare function deleteBackup(decryptedDir: string, name: string): {
    ok: boolean;
    error?: string;
};
