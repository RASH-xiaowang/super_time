import type { DbHealthSnapshot } from '../types.ts';
/**
 * Compute the data-health snapshot (cached ~5s so repeated open/close does
 * not rescan the whole decrypted tree).
 * @param decryptedDir - decrypted data root.
 * @returns the health snapshot.
 */
export declare function queryDbHealth(decryptedDir: string): DbHealthSnapshot;
//# sourceMappingURL=db-health.d.ts.map