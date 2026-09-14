import type { RecordItem } from '../types.ts';
/**
 * Query one records kind.
 * @param decryptedDir - decrypted data root.
 * @param kind - records kind key.
 * @param limit - max rows.
 * @param offset - page offset.
 * @param q - optional session/user/id keyword (applied server-side per kind).
 * @returns the records snapshot.
 */
export declare function queryRecords(decryptedDir: string, kind: string, limit?: number, offset?: number, q?: string, opts?: {
    from?: number;
    to?: number;
    direction?: 'asc' | 'desc';
}): {
    items: RecordItem[];
    total: number;
};
/**
 * Query revoked messages from the anti-revoke cache (source shape:
 * sender / type_label / content / create_time, time-descending).
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows (default 200, capped 500).
 * @returns the revoked snapshot.
 */
export declare function queryRevoked(decryptedDir: string, limit?: number, offset?: number): {
    items: Array<{
        sender: string;
        type_label: string;
        content: string;
        create_time: number;
    }>;
    total: number;
};
