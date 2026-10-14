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
 * 「密钥已从 `config.json` 搬到 `secrets.json`」这条提示的确认位（W2-12.3）。
 *
 * 它住在 `config.json` 里（**不是** `secrets.json`）—— 普通配置项，不是密钥，
 * 留在原地即可，不必跟着搬走。
 *
 * 为什么需要它：搬运动作是 `saveConfig` 顺手做的、**静默**的，而 `config.json`
 * 是用户会手工编辑的文件 —— 搬完之后他去那找密钥会找不着。提示必须只出现一次，
 * 否则就成了每次开设置都要关一次的噪音。
 */
export declare const SECRET_MIGRATION_ACK_FIELD = "secret_migration_notice_ack";
/**
 * M1 密钥迁移是不是还**等着**做。
 *
 * 判据两条，都不能省：
 *   ① `config.json` 里**真的还留着有意义的密钥字段**（走 `readConfigSecretFields`，
 *     于是 `image_xor_key: 136` 这种内置默认值不算 —— 它搬不搬都一样，
 *     对它报「已迁移」等于骗人）；
 *   ② 用户还没点过「知道了」（确认位为真就不再提示）。
 *
 * 纯读：不开写、不动文件。
 * @param decryptedDir - 已解密数据根。
 * @returns `pending` 是否该提示；`fields` 是还留在 config.json 里的字段名。
 */
export declare function secretMigrationPending(decryptedDir: string): {
    pending: boolean;
    fields: string[];
};
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
