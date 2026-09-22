import { StreamControl } from '../query/zip.ts';
import { BackupMutationResult, BackupPreviewSnapshot, BackupRestoreResult, BackupSnapshot, OperationCategory, OperationStatus } from '../types.ts';
export interface createBackupRemotesInputs {
    normalizeJobId: (jobId?: unknown) => string;
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    streamControl: (jobId?: string) => StreamControl;
    finishStreamJob: (jobId: string, error?: string) => void;
}
export declare function createBackupRemotes(rc: createBackupRemotesInputs): {
    listBackups(): BackupSnapshot;
    previewBackup(options: {
        name: string;
    }): BackupPreviewSnapshot;
    createBackup(): BackupMutationResult;
    deleteBackup(options: {
        name: string;
    }): BackupMutationResult;
    restoreBackup(options: {
        name: string;
        password: string;
    }): BackupRestoreResult;
    createEncryptedBackup(options: {
        password: string;
        jobId?: string;
    }): Promise<BackupMutationResult>;
};
