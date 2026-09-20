import type { PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot } from '../types.ts';
/**
 * Read the current privacy settings. Defaults: redaction off, outbound allowed.
 *
 * 读失败**不在这里兜底**：这是个权限判断，把「读不到」翻译成「默认放行」等于
 * 用户开了「出站拦截」而库损坏时静默出网。调用方各自的失败方向见
 * `gateway.ts` 的 `privacyBlocked` / `outboundBlocked` / `privacyGate`（一律拦下）。
 * 全新库（无行）仍走默认值，不抛。
 */
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
