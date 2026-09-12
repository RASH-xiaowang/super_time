import type { SearchHit } from '../types.ts';
/**
 * Index DB path: sibling of the decrypted dir.
 * @param decryptedDir - decrypted data root.
 * @returns the absolute path of the search index DB.
 */
export declare function searchIndexPath(decryptedDir: string): string;
/**
 * Search index status.
 * @param decryptedDir - decrypted data root.
 * @returns whether the index exists plus row count and built_at timestamp.
 */
export declare function getSearchIndexStatus(decryptedDir: string): {
    exists: boolean;
    rows: number;
    built_at: string | null;
};
/**
 * Build (or rebuild) the FTS5 search index over text messages.
 * @param decryptedDir - decrypted data root.
 * @param force - drop and rebuild even when an index exists.
 * @returns build result with status and row count.
 */
export declare function buildSearchIndex(decryptedDir: string, force?: boolean): {
    status: string;
    rows?: number;
    built_at?: string;
    elapsed_ms?: number;
    message?: string;
};
/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export declare function searchIndexMessages(decryptedDir: string, query: string, limit?: number, username?: string): {
    hits: SearchHit[];
    total: number;
    indexed: boolean;
};
//# sourceMappingURL=search.d.ts.map