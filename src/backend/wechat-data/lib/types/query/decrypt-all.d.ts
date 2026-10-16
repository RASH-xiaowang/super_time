/**
 * Decrypt every .db under the raw db_storage tree into the decrypted root.
 * Yields between databases so a progress-polling RPC stays served.
 * @param rawDbDir - raw WeChat db_storage dir (from config db_dir).
 * @param decryptedDir - decrypted snapshot root (target mirrors db_storage).
 * @param onProgress - per-database progress callback (done/total/failed/message).
 * @param onlyRel - **只解密这些 rel 路径**（`message/message_0.db` 这种键，与
 *   {@link checkDecryptedIntegrity} 出来的 `file` 同构）。修复链路用它实现
 *   「损坏哪个解哪个」：不传 = 全量解密（`立即解密` 原行为，逐字节不变）；
 *   传了 = 别的库连读都不读，`total` 计数也随过滤后的集合走 —— 修复进度条
 *   说的是「要修的这几个」，不是「全部 22 个库」。
 * @returns ok + success/failure counts (per-db failures never abort the run).
 */
export declare function decryptAllDbs(rawDbDir: string, decryptedDir: string, onProgress?: (done: number, total: number, failed: number, message: string) => void, onlyRel?: readonly string[]): Promise<{
    ok: boolean;
    total: number;
    okCount: number;
    failed: Array<{
        db: string;
        error: string;
    }>;
    error?: string;
}>;
