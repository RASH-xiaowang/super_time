interface StorageCategory {
    label: string;
    count: number;
    size: number;
}
interface MomentsAuthorStat {
    username: string;
    name: string;
    posts: number;
}
/** The one-screen data overview aggregate result. */
export interface OverviewResult {
    sessions: number;
    groups: number;
    contacts: number;
    official: number;
    moments: number;
    favorites: number;
    emoticons: number;
    revoked: number;
    storage: {
        total_size: number;
        total_count: number;
        categories: StorageCategory[];
    };
    moments_authors: MomentsAuthorStat[];
}
/**
 * Aggregate the overview stats.
 * @param decryptedDir - decrypted data root.
 * @returns the overview result.
 */
export declare function queryOverview(decryptedDir: string): OverviewResult;
export {};
