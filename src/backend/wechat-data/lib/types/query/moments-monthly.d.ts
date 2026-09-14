import type { MomentsMonthlyRow } from '../types.ts';
/**
 * Compute the full monthly distribution of moments, optionally for one author.
 * @param decryptedDir - decrypted data root.
 * @param author - optional author username filter (all authors when omitted).
 * @param authorName - optional author display-name filter, matching the author
 *   chips (all authors when omitted). Takes precedence over `author` when set.
 * @returns monthly rows sorted ascending by month.
 */
export declare function queryMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): MomentsMonthlyRow[];
