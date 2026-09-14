/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFileSync 到目标路径时，写一半被杀进程/磁盘满会留下**截断的 JSON**；
 * 而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落默认值
 * （用户看到的是「配置莫名丢了」），且下一次保存就把残缺内容覆盖掉。
 * 宿主层 `src/backend/wechat-paths.js` 有一份等价实现（那边是 CJS，无法共享）。
 * @param target - 目标文件绝对路径。
 * @param text - 要写入的文本。
 */
export declare function writeFileAtomic(target: string, text: string): void;
export declare function preserveIfUnparseable(target: string): void;
/**
 * Read the full WeChat config (merged with defaults).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @returns the merged config (defaults + file values + resolved paths).
 */
export declare function getConfig(decryptedDir: string): Record<string, unknown>;
/**
 * Save the WeChat config (merge patch into config.json).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @param patch - config fields to merge in.
 * @returns ok, or an error description on failure.
 */
export declare function saveConfig(decryptedDir: string, patch: Record<string, unknown>): {
    ok: boolean;
    error?: string;
};
/**
 * WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
 * (Windows only; '' elsewhere). The install dir is also a valid data base when
 * the user kept the default data layout.
 */
export declare function weixinInstallPath(): string;
/**
 * WeChat version folder name inside the install dir.
 * @param installDir - install path (defaults to the registry InstallPath).
 * @returns the version, or '' when the install dir is unknown.
 */
export declare function weixinVersion(installDir?: string): string;
/**
 * Collect the `xwechat_files` roots to scan: default data bases, per-user
 * config ini files, and the registry install path, deduped
 * case-insensitively. A configured base may itself already be the
 * `xwechat_files` dir, so both join forms are added; the account loop filters
 * by `db_storage` presence.
 * @returns absolute candidate roots (existence caller-checked).
 */
export declare function collectScanRoots(): string[];
/**
 * Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
 * @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
 * @returns detected accounts with db_dir, last active and db file count.
 */
export declare function detectWechatAccounts(roots?: readonly string[]): Array<{
    wxid: string;
    db_dir: string;
    last_active?: number;
    db_files?: number;
}>;
/**
 * SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
 * @param page1 - first page (4096 bytes) of the encrypted database.
 * @param wxKeyBin - 32-byte raw database key.
 * @returns whether the HMAC and AES checks pass.
 */
export declare function verifyDbKey(page1: Buffer, wxKeyBin: Buffer): {
    hmacOk: boolean;
    aesOk: boolean;
};
/**
 * Verify one database file with a 64-hex key.
 * @param dbPath - path to the encrypted database file.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @returns validity plus per-check flags and any error.
 */
export declare function verifyDatabaseKey(dbPath: string, encKeyHex: string): {
    valid: boolean;
    aesOk?: boolean;
    hmacOk?: boolean;
    error?: string;
};
/** Recursively collect .db files under a dir (depth-limited). */
export declare function scanDbFiles(dir: string, depth?: number): string[];
/**
 * Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
 * @param dbDir - directory containing the encrypted DBs to verify.
 * @param keysFile - output all_keys.json path.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @param keyFormat - key format recorded in the file (default wx_key_v4.1).
 * @returns ok plus verified/total DB counts, or an error description.
 */
export declare function generateKeysFile(dbDir: string, keysFile: string, encKeyHex: string, keyFormat?: string): {
    ok: boolean;
    verified: number;
    total: number;
    error?: string;
};
/**
 * Read all_keys.json info (format + count).
 * @param decryptedDir - decrypted data root.
 * @returns key format, key count and whether the file was loaded.
 */
export declare function getKeysInfo(decryptedDir: string): {
    keyFormat?: string;
    keyCount: number;
    loaded: boolean;
};
/**
 * Normalize a WeChat account dir name to the real wxid (strip instance suffix).
 * Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
 * has no underscore, so everything after the second underscore is the instance
 * id (mirrors st_control config/paths.rs normalize_wxid_dir).
 * @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
 * @returns the real wxid (input unchanged when it is not a wxid_ name).
 */
export declare function normalizeWxidDir(name: string): string;
/**
 * Resolve the logged-in account wxid (self). Mirrors st_control's cfg.wxid()
 * which derives it from the account directory name. Resolution order:
 * env DSH_WECHAT_SELF_WXID -> config.json db_dir -> all_keys.json _db_dir ->
 * machine account scan. Unknown when every source is missing.
 * @param decryptedDir - decrypted data root (configPath locates config.json).
 * @returns the self wxid, or '' when it cannot be determined.
 */
export declare function resolveSelfUsername(decryptedDir: string): string;
/**
 * Resolve the raw WeChat `db_storage` directory the realtime sync watches.
 * Resolution order: config.json `db_dir`, then all_keys.json `_db_dir` (the
 * st_control layout records it even when no config.json exists), then the
 * `DSH_WECHAT_BASE_DIR` account pin with `db_storage` appended. Empty when
 * every source is missing — callers must fail loud, not skip silently.
 * @param decryptedDir - decrypted data root (locates config.json/all_keys.json).
 * @param env - environment mapping (defaults to process.env).
 * @returns the raw db_storage path, or '' when it cannot be resolved.
 */
export declare function resolveRawDbDir(decryptedDir: string, env?: Record<string, string | undefined>): string;
