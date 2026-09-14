/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */
/** Contact meta: display names, pinned usernames, official-account types. */
export interface ContactMeta {
    names: Map<string, string>;
    pinned: Set<string>;
    bizTypes: Map<string, number>;
}
/**
 * `biz_info.type` 是否为**服务号**（否则该 `gh_` 账号是订阅号/公众号）。
 *
 * 这个判据必须**全局唯一**：聊天列表（`sessions.ts`）与通讯录（`contacts.ts`）
 * 各自写一份就会出现「同一个账号在聊天里算服务号、在通讯录里算公众号」，
 * 也就是同一个账号出现在两个类目下、或两边都看不到它。
 * 实测本机 `biz_info.type` 只有 0（订阅号）与 1（服务号）；1/3/5 是微信
 * 文档里服务号用过的取值，2/4 属订阅号，因此不能简化成 `type > 0`。
 * @param t - `biz_info.type`（缺失时为 undefined）。
 * @returns 是服务号时为 true。
 */
export declare function isServiceBizType(t: number | undefined): boolean;
/**
 * Read contact.db once and derive all contact metadata.
 * @param decryptedDir - decrypted data root.
 * @returns contact names (remark > nick > username), pinned set, biz types.
 */
export declare function contactMeta(decryptedDir: string): ContactMeta;
/** SenderName2Id fallback (message_resource.db rowid -> wxid). */
export declare function senderNameMap(decryptedDir: string): Map<number, string>;
/** One cached shard entry: which file holds a table and its columns/name map. */
export interface ShardMeta {
    file: string;
    tables: Map<string, {
        cols: Set<string>;
        name2id: Map<number, string>;
    }>;
}
/**
 * Cached message shard catalog across one or more sub-directories (message,
 * bizchat, ...). Returns the Msg_% tables each file holds.
 * @param decryptedDir - decrypted data root.
 * @param dirs - sub-directory names to scan (default ['message']).
 * @returns shard metadata keyed by file path (cache invalidated by file sigs).
 */
export declare function shardCatalogDirs(decryptedDir: string, dirs: ReadonlyArray<string>): ShardMeta[];
/** Convenience: message-directory-only catalog (the chat hot path). */
export declare function shardCatalog(decryptedDir: string): ShardMeta[];
/** Signature string for the directories a catalog covers (cache keys). */
export declare function shardCatalogSig(decryptedDir: string, dirs: ReadonlyArray<string>): string;
/** Signature of one file (mtime+size); '' when absent. */
export declare function fileSigOf(path: string): string;
/** Generic mtime/fingerprint-bounded process cache (see {@link get}). */
export declare function cachedBySig<T>(key: string, sig: string, loader: () => T, maxAgeMs?: number): T;
/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
export declare function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap?: number): void;
/** Drop every cached snapshot (called after a rewrite event when needed). */
export declare function invalidateWechatMeta(): void;
