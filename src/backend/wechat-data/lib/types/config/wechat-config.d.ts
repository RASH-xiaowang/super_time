/**
 * 自有配置的真源：`<数据根>/config.json` + `<数据根>/secrets.json`。
 *
 * 为什么独立成层（M24）：原先这些实现压在 `query/config.ts` 里，而 `keys/service.ts` 与
 * `keys/db-key-v4.ts` 也需要它 —— 于是最底层的 keys 反向 import 了上层 query，与
 * `query/image-key.ts` → `keys/key-store.ts` 构成双向依赖。抽出来之后依赖方向是
 * `config ← keys ← query`（单向）。
 *
 * 本文件只做配置读写，不 import 包内其它模块（`atomic-json.ts` 是更底的一层）。
 */
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
