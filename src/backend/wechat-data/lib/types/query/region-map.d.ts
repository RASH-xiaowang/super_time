import type { RegionMapSnapshot } from '../types.ts';
/**
 * Query the friend-region map.
 * @param decryptedDir - decrypted data root.
 * @returns the region map snapshot (world → countries → provinces → cities).
 */
export declare function queryRegionMap(decryptedDir: string): RegionMapSnapshot;
