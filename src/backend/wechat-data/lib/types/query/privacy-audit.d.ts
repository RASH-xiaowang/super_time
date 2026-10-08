import type { PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot } from '../types.ts';
/**
 * Read the current privacy settings. Defaults: redaction off.
 *
 * 这里已不是权限判断（出网拦截已删除）：调用方是脱敏与审计，读失败按默认值继续，
 * 见 `gateway-privacy.ts#privacyGateAt`。全新库（无行）走默认值，不抛。
 */
export declare function readPrivacySettings(decryptedDir: string): {
    redactSensitive: boolean;
};
/** Persist privacy settings (partial update). */
export declare function writePrivacySettings(decryptedDir: string, patch: {
    redactSensitive?: boolean;
}): {
    redactSensitive: boolean;
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
