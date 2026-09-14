import type { AssetInsightsSnapshot } from '../types.ts';
/**
 * Compute favorites + emoticon asset insights.
 * @param decryptedDir - decrypted data root.
 * @returns the asset insights snapshot.
 */
export declare function queryAssetInsights(decryptedDir: string): AssetInsightsSnapshot;
