import type { MomentsInsightsSnapshot } from '../types.ts';
/**
 * Compute moments insights for an author.
 * @param decryptedDir - decrypted data root.
 * @param author - author username (default: all).
 * @returns the insights snapshot.
 */
export declare function queryMomentsInsights(decryptedDir: string, author?: string): MomentsInsightsSnapshot;
