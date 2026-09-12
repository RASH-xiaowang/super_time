/**
 * Decrypt every .db under the raw db_storage tree into the decrypted root.
 * Yields between databases so a progress-polling RPC stays served.
 * @param rawDbDir - raw WeChat db_storage dir (from config db_dir).
 * @param decryptedDir - decrypted snapshot root (target mirrors db_storage).
 * @param onProgress - per-database progress callback (done/total/failed/message).
 * @returns ok + success/failure counts (per-db failures never abort the run).
 */
export declare function decryptAllDbs(rawDbDir: string, decryptedDir: string, onProgress?: (done: number, total: number, failed: number, message: string) => void): Promise<{
    ok: boolean;
    total: number;
    okCount: number;
    failed: Array<{
        db: string;
        error: string;
    }>;
    error?: string;
}>;
//# sourceMappingURL=decrypt-all.d.ts.map