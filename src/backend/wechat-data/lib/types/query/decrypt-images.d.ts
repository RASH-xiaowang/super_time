/**
 * 收集 `msg/attach` 下全部 md5 前缀的 `.dat`（递归，深度上限 10）。
 *
 * 抽出来是为了**只有一个遍历实现**：「升级解码缓存」（`image-upgrade.ts`）要按 md5 反查
 * 「本机最好的一档」，走的必须是同一个目录口径 —— 两份各写一遍，迟早出现「批量解密看得到、
 * 升级看不见」那种只有用户能发现的偏差。
 * @param rawRoot - 微信账号原始根目录（`msg/attach` 的父目录）。
 * @returns `.dat` 绝对路径列表（未排序）。
 */
export declare function collectImageDatFiles(rawRoot: string): string[];
/**
 * 把 `.dat` 列表按 md5 归并，组内**按档位排序**（`_h` 原图在前，不认识的最后）。
 *
 * 分组不是省事，是正确性要求：同一个 md5 的多档必须由**同一个 worker** 顺序处理。
 * 并发 >1 时它们会被不同 worker 同时取走，「谁先写主槽」就变成竞态 —— 实测并发 2 时
 * `.dat`（聊天版）会盖掉 `_h`（原图），症状正是「明明点开过大图，缓存里还是糊的」。
 * @param files - {@link collectImageDatFiles} 的结果（本函数不改动入参）。
 * @returns md5 → 该 md5 的 `.dat` 路径（组内按档位从优到劣）。
 */
export declare function groupImageDatsByMd5(files: readonly string[]): Map<string, string[]>;
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
