import type { CallsSnapshot } from '../types.ts';
/**
 * Compute the call inventory snapshot (cached on shard + contact fingerprints).
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @param topPeers - how many peers to return (default 20).
 * @param recentLimit - how many recent records to return (default 50).
 * @returns the calls snapshot.
 */
export declare function queryCalls(decryptedDir: string, selfUsername?: string, topPeers?: number, recentLimit?: number): CallsSnapshot;
