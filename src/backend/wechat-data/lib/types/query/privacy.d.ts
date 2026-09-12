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
/**
 * Scan message shards for sensitive patterns.
 * @param decryptedDir - decrypted data root.
 * @param rowBudget - max scanned rows (default 600000, source budget).
 * @returns categories with samples + rankings.
 */
export declare function queryPrivacyScan(decryptedDir: string, rowBudget?: number): {
    categories: PrivacyCategory[];
    total_hits: number;
    involved_sessions: number;
    top_contacts: PrivacyRank[];
    top_groups: PrivacyRank[];
};
export {};
//# sourceMappingURL=privacy.d.ts.map