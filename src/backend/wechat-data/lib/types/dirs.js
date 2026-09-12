/**
 * WeChat data root resolution + one-time bootstrap.
 *
 * The migrated plugin owns its data under the DeepSeek Harness home instead
 * of reading st_control's working tree in place. The root is
 * `$DSH_HOME/wechat-data` (default `~/.dsh/wechat-data`), overridable with
 * `DSH_WECHAT_DATA_DIR`. Inside the root the layout mirrors st_control's
 * `data/wechat` directory so the query modules keep working unchanged:
 *
 *   <root>/decrypted/          decrypted SQLite libraries (read)
 *   <root>/decoded_images/     decoded image cache (read/write)
 *   <root>/message_edits.db    edit store (write)
 *   <root>/daily_summary.db    daily-summary store (write)
 *   <root>/wechat_search.db    search index (write)
 *   <root>/backups/            backup snapshots (write)
 *   <root>/exports/            CSV/TXT exports (write)
 *   <root>/config.json         WeChat config (read/write)
 *   <root>/all_keys.json       generated keys info (write)
 *
 * On first use the root is bootstrapped from the source `data/wechat`
 * directory (default `C:/Users/28361/Desktop/ST/st_control/data/wechat`,
 * overridable with `DSH_WECHAT_SOURCE_DIR`): `decrypted`, `decoded_images`
 * and existing write stores are copied once; later runs read/write only the
 * DSH-owned root. Legacy env overrides `DSH_WECHAT_DECRYPTED_DIR` /
 * `DSH_WECHAT_DECODED_DIR` bypass the root entirely (explicit user pinning).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
/** Legacy explicit override env var for the decrypted dir (bypasses the root). */
export const DECRYPTED_DIR_ENV = 'DSH_WECHAT_DECRYPTED_DIR';
/** Legacy explicit override env var for the decoded images dir. */
export const DECODED_DIR_ENV = 'DSH_WECHAT_DECODED_DIR';
/** Data-root override env var (highest precedence over the DSH home default). */
export const DATA_DIR_ENV = 'DSH_WECHAT_DATA_DIR';
/** Bootstrap source override env var. */
export const SOURCE_DIR_ENV = 'DSH_WECHAT_SOURCE_DIR';
/** Default bootstrap source: unset — bootstrap requires an explicit env override. */
export const DEFAULT_SOURCE_DIR = '';
/** Subdirectories/files copied from the source during bootstrap. */
const BOOTSTRAP_ITEMS = ['decrypted', 'decoded_images', 'message_edits.db', 'daily_summary.db', 'wechat_search.db', 'wechat_tasks.db', 'config.json', 'all_keys.json'];
/** Suffixes that must never be copied (SQLite runtime artifacts). */
const SKIP_SUFFIXES = ['-wal', '-shm'];
/** True when a name is a SQLite runtime artifact (e.g. session.db-wal). */
function isRuntimeArtifact(name) {
    return SKIP_SUFFIXES.some(suffix => name.endsWith(suffix));
}
/**
 * Resolve the plugin-owned WeChat data root.
 * @param env - environment mapping (defaults to process.env).
 * @returns the absolute data root path.
 */
export function resolveWechatDataRoot(env = process.env) {
    const explicit = env[DATA_DIR_ENV];
    if (explicit !== undefined && explicit.trim().length > 0)
        return resolve(explicit.trim());
    return resolve(join(resolveDshHome(undefined, env), 'wechat-data'));
}
/**
 * Resolve the decrypted-dir the queries read.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decrypted`.
 */
export function resolveDecryptedDir(env = process.env) {
    const pinned = env[DECRYPTED_DIR_ENV];
    if (pinned !== undefined && pinned.trim().length > 0)
        return resolve(pinned.trim());
    return join(resolveWechatDataRoot(env), 'decrypted');
}
/**
 * Resolve the decoded-images cache dir.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decoded_images`.
 */
export function resolveDecodedDir(env = process.env) {
    const pinned = env[DECODED_DIR_ENV];
    if (pinned !== undefined && pinned.trim().length > 0)
        return resolve(pinned.trim());
    return join(resolveWechatDataRoot(env), 'decoded_images');
}
/**
 * Resolve the bootstrap source directory.
 * @param env - environment mapping.
 * @returns the source dir, or null when unset/empty.
 */
export function resolveSourceDir(env = process.env) {
    const explicit = env[SOURCE_DIR_ENV];
    if (explicit !== undefined && explicit.trim().length > 0)
        return resolve(explicit.trim());
    return null;
}
/**
 * Recursively copy a directory/file skipping SQLite -wal/-shm runtime files.
 * @param src - source path.
 * @param dest - destination path.
 */
function copyTree(src, dest) {
    const st = statSync(src);
    if (!st.isDirectory()) {
        if (!isRuntimeArtifact(src.split(/[\\/]/).pop() ?? ''))
            cpSync(src, dest, { recursive: false });
        return;
    }
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (isRuntimeArtifact(entry.name))
            continue;
        copyTree(join(src, entry.name), join(dest, entry.name));
    }
}
/**
 * One-time bootstrap: copy `decrypted`/`decoded_images` and any existing
 * write stores from the source into the DSH-owned data root. Idempotent —
 * a root that already contains `decrypted` is left untouched. Explicit
 * legacy overrides bypass the root, so nothing is copied in that mode.
 * @param env - environment mapping.
 * @returns what was copied (or skipped), for observability.
 */
export function bootstrapWechatData(env = process.env) {
    const root = resolveWechatDataRoot(env);
    if (env[DECRYPTED_DIR_ENV] !== undefined && env[DECRYPTED_DIR_ENV].trim().length > 0) {
        return { root, copied: [], skipped: true };
    }
    const decrypted = join(root, 'decrypted');
    if (existsSync(decrypted))
        return { root, copied: [], skipped: true };
    const source = resolveSourceDir(env);
    if (source === null || !existsSync(source)) {
        return { root, copied: [], skipped: true };
    }
    const copied = [];
    for (const item of BOOTSTRAP_ITEMS) {
        const src = join(source, item);
        const dest = join(root, item);
        if (!existsSync(src))
            continue;
        copyTree(src, dest);
        copied.push(item);
    }
    return { root, copied, skipped: false };
}
//# sourceMappingURL=dirs.js.map