/** Batch decrypt result. */
export interface BatchDecryptResult {
    total: number;
    okCount: number;
    failed: number;
    skipped: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
    /** 跳过项的原因（已存在缓存 / HEVC 暂不支持 / 格式不支持…），供界面说明「为什么少了几张」。 */
    skippedDetails?: Array<{
        file: string;
        reason: string;
    }>;
}
/**
 * Decrypt every md5-prefixed .dat under `<rawRoot>/msg/attach` into the
 * decoded-images cache with a bounded concurrent pool.
 * @param rawRoot - raw WeChat account root (parent of db_storage).
 * @param decodedDir - decoded-images cache root.
 * @param aesKey - V2 AES key (16-char ASCII) or null.
 * @param xorKey - XOR key byte.
 * @param concurrency - worker count (clamped 1..32).
 * @param onProgress - per-file progress callback (processed/total/failed/message).
 * @returns total/ok/failed/skipped counts + per-file errors.
 */
export declare function decryptAllImageDats(rawRoot: string, decodedDir: string, aesKey: string | undefined, xorKey: number, concurrency?: number, onProgress?: (processed: number, total: number, failed: number, message: string) => void): Promise<BatchDecryptResult>;
