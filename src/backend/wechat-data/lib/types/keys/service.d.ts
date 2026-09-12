import type { DbKeyResult, ImageKeyResult } from './types.ts';
/**
 * Find the running WeChat main-process pid via tasklist.
 * @returns the first matching pid, or null.
 */
export declare function findWechatPid(): number | null;
/**
 * Scan Weixin.dll for the internal DB key used to unmask V4 candidates.
 * @param wechatInstallDir - optional explicit install dir (may be the version
 * folder or its parent; version subdirectories are probed too).
 * @returns the first 32-byte internal key, or null.
 */
export declare function scanDllInternalKey(wechatInstallDir?: string): Buffer | null;
/**
 * Recover the V4 database key for the running WeChat process.
 * @param opts - optional db probe path and install dir.
 * @returns the recovered key result.
 */
export declare function fetchDbKey(opts?: {
    dbPath?: string;
    wechatInstallDir?: string;
}): Promise<DbKeyResult>;
/**
 * Coerce the account dir to the wxid_* account root: a db_dir pointing at
 * `db_storage` is lifted to its parent, because the V2 template cache lives
 * under `<root>/msg/attach` (not under db_storage).
 * @param accountDir - as passed by callers (db_dir or account root).
 * @returns the account root, '' when nothing usable.
 */
export declare function normalizeAccountDir(accountDir: string): string;
/**
 * WeChat 4.x kvcomm cache dir. The image key is derived from the kvcomm code
 * (`md5(code + clean_wxid)[:16]`, XOR = `code & 0xFF`), and the codes are the
 * decimal prefixes of `*_input.statistic` file names under this dir.
 * @returns the kvcomm cache dir, '' when unavailable.
 */
export declare function kvcommCacheDir(): string;
/**
 * Recover the image key: kvcomm-cache derivation first (WeChat 4.x on-disk
 * cache, no injection), then the V2-verified process memory scan.
 * @param opts - account dir (wxid folder) and optional pid.
 * @returns the verified image key result.
 */
export declare function fetchImageKey(opts?: {
    accountDir?: string;
    pid?: number;
}): Promise<ImageKeyResult>;
/**
 * Get stored key info (db key presence + image key presence).
 * @returns a summary of the default slot's stored keys.
 */
export declare function getKeysInfoSummary(): {
    hasDbKey: boolean;
    hasImageKey: boolean;
    updatedAt?: string;
};
//# sourceMappingURL=service.d.ts.map