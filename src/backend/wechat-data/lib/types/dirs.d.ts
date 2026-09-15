/** Legacy explicit override env var for the decrypted dir (bypasses the root). */
export declare const DECRYPTED_DIR_ENV = "DSH_WECHAT_DECRYPTED_DIR";
/** Legacy explicit override env var for the decoded images dir. */
export declare const DECODED_DIR_ENV = "DSH_WECHAT_DECODED_DIR";
/** Data-root override env var (highest precedence over the DSH home default). */
export declare const DATA_DIR_ENV = "DSH_WECHAT_DATA_DIR";
/** Bootstrap source override env var. */
export declare const SOURCE_DIR_ENV = "DSH_WECHAT_SOURCE_DIR";
/** Default bootstrap source: unset — bootstrap requires an explicit env override. */
export declare const DEFAULT_SOURCE_DIR = "";
/**
 * Resolve the plugin-owned WeChat data root.
 * @param env - environment mapping (defaults to process.env).
 * @returns the absolute data root path.
 */
export declare function resolveWechatDataRoot(env?: Record<string, string | undefined>): string;
/**
 * Resolve the decrypted-dir the queries read.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decrypted`.
 */
export declare function resolveDecryptedDir(env?: Record<string, string | undefined>): string;
/**
 * Resolve the decoded-images cache dir.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decoded_images`.
 */
export declare function resolveDecodedDir(env?: Record<string, string | undefined>): string;
/**
 * Resolve the bootstrap source directory.
 * @param env - environment mapping.
 * @returns the source dir, or null when unset/empty.
 */
export declare function resolveSourceDir(env?: Record<string, string | undefined>): string | null;
/**
 * One-time bootstrap: copy `decrypted`/`decoded_images` and any existing
 * write stores from the source into the DSH-owned data root. Idempotent —
 * a root that already contains `decrypted` is left untouched. Explicit
 * legacy overrides bypass the root, so nothing is copied in that mode.
 *
 * SQLite 主库的 `-wal` 会随主库一起拷（见 copyFileWithWal）；`walCarried` 就是给调用方
 * 留痕迹用的 —— 「这次拷的是不是最新一代」不能只靠猜。
 * @param env - environment mapping.
 * @returns what was copied (or skipped), for observability.
 */
export declare function bootstrapWechatData(env?: Record<string, string | undefined>): {
    root: string;
    copied: string[];
    skipped: boolean;
    walCarried: string[];
};
