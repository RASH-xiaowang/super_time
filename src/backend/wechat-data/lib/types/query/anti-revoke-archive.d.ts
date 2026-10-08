/** 归档库路径：数据根下、与 `decoded_images` 同级（不进解密目录，避免被同步覆盖）。 */
export declare function revokeArchivePath(decryptedDir: string): string;
/**
 * 把插件缓存里的撤回记录**幂等归档**到我们自己的库。
 *
 * @param decryptedDir - 解密数据根。
 * @param srcFile - 插件缓存所在的库文件。
 * @param srcTable - 插件缓存表名。
 * @returns 本次新归档的条数（已存在的不会重复计数）。
 */
export declare function archiveRevokeCache(decryptedDir: string, srcFile: string, srcTable: string): number;
/**
 * 从**我们自己的归档库**读撤回记录（形状与插件缓存一致，交给上层同一套解析）。
 *
 * @param decryptedDir - 解密数据根。
 * @param limit - 上限（已由调用方裁剪）。
 * @param offset - 偏移。
 * @param q - 关键词（匹配原文或发送者 id）。
 * @returns 记录与总数；归档库不存在时返回空。
 */
export declare function readArchivedRevoke(decryptedDir: string, limit: number, offset: number, q?: string): {
    rows: Array<{
        lt?: number;
        rid?: number;
        ct?: number;
        mc?: string | Uint8Array | null;
    }>;
    total: number;
};
