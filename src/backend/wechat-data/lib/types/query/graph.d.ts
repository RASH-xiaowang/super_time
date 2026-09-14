import type { GraphSnapshot } from '../types.ts';
/**
 * Build a graph snapshot: contact/group nodes enriched for both display modes.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (excluded from persons).
 * @returns nodes + summary (edges derived client-side from group_codes).
 */
export declare function queryGraph(decryptedDir: string, selfUsername?: string): GraphSnapshot;
