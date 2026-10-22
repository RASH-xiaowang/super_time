import type { UnifiedSearchSnapshot } from '../types.ts';
/**
 * Run the unified local search.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @returns the unified snapshot.
 */
export declare function searchUnified(decryptedDir: string, query: string, limit?: number, options?: {
    from?: string;
    to?: string;
    username?: string;
}): UnifiedSearchSnapshot;
