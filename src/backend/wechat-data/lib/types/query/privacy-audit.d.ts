import type { PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot } from '../types.ts';
/** Read the current privacy settings. Defaults: redaction off, outbound allowed. */
export declare function readPrivacySettings(decryptedDir: string): {
    redactSensitive: boolean;
    blockOutbound: boolean;
};
/** Persist privacy settings (partial update). */
export declare function writePrivacySettings(decryptedDir: string, patch: {
    redactSensitive?: boolean;
    blockOutbound?: boolean;
}): {
    redactSensitive: boolean;
    blockOutbound: boolean;
};
/** Record one AI feature call in the audit log. */
export declare function recordPrivacyAudit(decryptedDir: string, feature: string, chars: number, sessions: number, messages: number): void;
/** Read the privacy state snapshot including audit aggregates. */
export declare function getPrivacyStateSnapshot(decryptedDir: string): PrivacyStateSnapshot;
/** List recent raw privacy audit rows. */
export declare function listPrivacyAudit(decryptedDir: string, limit?: number): PrivacyAuditRow[];
/** Clear all privacy audit rows. */
export declare function clearPrivacyAudit(decryptedDir: string): PrivacyAuditClearResult;
/** Redact common sensitive fields (phone/id/bank/email/password) from prompt text. */
export declare function redactSensitiveText(text: string): string;
//# sourceMappingURL=privacy-audit.d.ts.map