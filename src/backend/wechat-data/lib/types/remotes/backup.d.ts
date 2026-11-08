import { type ManagedStreamControl } from '../gateway-jobs.ts';
import { BackupMutationResult, BackupPreviewSnapshot, BackupRestoreResult, BackupSnapshot, OperationCategory, OperationStatus } from '../types.ts';
export interface createBackupRemotesInputs {
    normalizeJobId: (jobId?: unknown) => string;
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    streamControl: (jobId?: string) => ManagedStreamControl;
    finishStreamJob: (jobId: string, error?: string, token?: symbol, canceled?: boolean) => void;
}
export declare function createBackupRemotes(rc: createBackupRemotesInputs): {
    listBackups(): BackupSnapshot;
    previewBackup(options: {
        name: string;
    }): BackupPreviewSnapshot;
    createBackup(options?: {
        jobId?: string;
    }): Promise<BackupMutationResult>;
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
