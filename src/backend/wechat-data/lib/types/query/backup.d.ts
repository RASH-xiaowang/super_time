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
 * @param decryptedDir - decrypted data root.
 * @returns the created backup entry.
 */
export declare function createBackup(decryptedDir: string): BackupEntry;
/**
 * Create an encrypted `.wcb` backup bundle.
 * @param decryptedDir - decrypted data root.
 * @param password - encryption password.
 * @returns the created backup entry.
 */
export declare function createEncryptedBackup(decryptedDir: string, password: string): Promise<BackupEntry>;
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
