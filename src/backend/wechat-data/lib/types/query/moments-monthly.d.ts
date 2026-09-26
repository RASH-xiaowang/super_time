import type { MomentsMonthlySnapshot } from '../types.ts';
/**
 * Compute the full monthly distribution of moments, optionally for one author.
 * @param decryptedDir - decrypted data root.
 * @param author - optional author username filter (all authors when omitted).
 * @param authorName - optional author display-name filter, matching the author
 *   chips (all authors when omitted). Takes precedence over `author` when set.
 * @returns 月度快照：只有**确认读到过**才回空的 `months`；读失败时 `readError` 非空。
 */
export declare function queryMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): MomentsMonthlySnapshot;
