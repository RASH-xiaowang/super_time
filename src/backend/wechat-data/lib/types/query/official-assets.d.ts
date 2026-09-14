import type { OfficialAssetsSnapshot } from '../types.ts';
/**
 * Compute official account content assets.
 * @param decryptedDir - decrypted data root.
 * @returns the official-assets snapshot.
 */
export declare function queryOfficialAssets(decryptedDir: string): OfficialAssetsSnapshot;
