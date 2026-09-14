import type { MediaAssetsSnapshot } from '../types.ts';
/**
 * Compute the media assets snapshot.
 * @param decryptedDir - decrypted data root.
 * @returns the media assets snapshot.
 */
export declare function queryMediaAssets(decryptedDir: string): MediaAssetsSnapshot;
