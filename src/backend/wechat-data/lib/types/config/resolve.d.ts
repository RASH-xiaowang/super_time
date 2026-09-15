/**
 * 从配置/密钥文件里解析运行时需要的路径与身份（配置层的一部分）。
 *
 * 为什么放在这一层（M24）：它们全部是「读 config.json / all_keys.json + 环境变量」的纯解析，
 * 不含任何查询逻辑；`keys/**` 也可能需要同样的解析能力，放在这里就不会再出现
 * keys → query 的反向依赖。
 */
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
