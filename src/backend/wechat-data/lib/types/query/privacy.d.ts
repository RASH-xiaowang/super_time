interface PrivacyCategory {
    key: string;
    label: string;
    count: number;
    icon: string;
    samples: PrivacySample[];
}
interface PrivacySample {
    username: string;
    name: string;
    local_id: number;
    ts: number;
    time: string;
    snippet: string;
}
interface PrivacyRank {
    username: string;
    name: string;
    count: number;
}
/** 隐私体检快照（`queryPrivacyScan` 的返回形状）。 */
interface PrivacyScanResult {
    categories: PrivacyCategory[];
    total_hits: number;
    involved_sessions: number;
    top_contacts: PrivacyRank[];
    top_groups: PrivacyRank[];
}
/**
 * Scan message shards for sensitive patterns.
 * @param decryptedDir - decrypted data root.
 * @param rowBudget - max scanned rows (default 600000, source budget).
 * @returns categories with samples + rankings.
 */
export declare function queryPrivacyScan(decryptedDir: string, rowBudget?: number): Promise<PrivacyScanResult>;
/**
 * 隐私扫描每多少行让出一次（P1-2）。
 * 导出给守卫用例**按这个数造数据**：判据量的是「让出次数」，不能依赖墙上时钟。
 */
export declare const PRIVACY_YIELD_EVERY_ROWS = 5000;
export {};
