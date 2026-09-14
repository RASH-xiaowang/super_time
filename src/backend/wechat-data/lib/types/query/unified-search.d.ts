import type { UnifiedSearchSnapshot } from '../types.ts';
/**
 * Run the unified local search.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @returns the unified snapshot.
 */
export declare function searchUnified(decryptedDir: string, query: string, limit?: number): UnifiedSearchSnapshot;
