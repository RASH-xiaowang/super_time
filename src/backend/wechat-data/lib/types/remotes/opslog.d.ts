import { OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PrivacyAuditClearResult, PrivacyAuditRow, PrivacySnapshot, PrivacyStateSnapshot } from '../types.ts';
export interface createOpsLogRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
}
export declare function createOpsLogRemotes(rc: createOpsLogRemotesInputs): {
    getOperationLog(options?: OperationLogQuery): OperationLogSnapshot;
    clearOperationLog(): OperationLogClearResult;
    getPrivacyAuditRows(): PrivacyAuditRow[];
    clearPrivacyAudit(): PrivacyAuditClearResult;
    getPrivacyState(): PrivacyStateSnapshot;
    setPrivacyState(options: {
        redactSensitive?: boolean;
        blockOutbound?: boolean;
    }): PrivacyStateSnapshot;
    getPrivacyScan(): PrivacySnapshot;
};
