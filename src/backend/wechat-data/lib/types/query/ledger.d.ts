import type { LedgerSnapshot } from '../types.ts';
/**
 * Compute the funds ledger snapshot.
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @returns the ledger snapshot.
 */
export declare function queryLedger(decryptedDir: string, month?: string, selfUsername?: string): LedgerSnapshot;
