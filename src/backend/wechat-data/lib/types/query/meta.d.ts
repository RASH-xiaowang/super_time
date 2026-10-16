/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */
/**
 * W3-9.2：insights 一族的显式 TTL（30 秒）。
 *
 * 为什么要显式写出来：不写第 4 个参数就等于用 {@link MAX_AGE_MS} 的 5 秒，
 * 而那个默认值是给**交互类**查询定的（列表页翻一下就刷新）。insights 是
 * 一次要扫几个分片的聚合：5 秒内重复算一遍纯属浪费，用户在两块面板之间来回
 * 切一次就把省下的又吐回去。写出来还让守卫看得见它（`w3-insights-ttl.spec.ts`）——
 * 没人看见的默认值，改动时也不会有人来对账。
 *
 * 30 秒而不是更长：它仍然受**数据签名**管着（分片/库文件一变立刻重算），
 * TTL 只是「签名没变时的最短重复间隔」，不是陈旧窗口的上界。
 */
export declare const INSIGHTS_TTL_MS = 30000;
/**
 * W3-9.2：年度一族的显式 TTL（60 秒）。
 *
 * 与 {@link INSIGHTS_TTL_MS} 同族不同档：年报按月/年看，用户不会在几秒内
 * 反复切回去；而它扫的是**全年**消息，比 insights 更贵。
 * 同样受数据签名管着（分片一变立刻重算），TTL 只是最短重复间隔。
 */
export declare const ANNUAL_TTL_MS = 60000;
interface Entry {
    at: number;
    /**
     * 最近一次**被读到**的时刻（W3-3.1：访问计时 LRU）。
     *
     * 为什么与 `at`（写入时刻）分开：TTL 按写入算，而淘汰顺序要按**用没用过**算。
     * 只用 `at` 的话，淘汰退化成 FIFO —— 「用户一直在看的第 201 条」会被
     * 「写进去就再没人碰过的第 1 条」之后的某一条挤掉，而那一条本来还有用。
     */
    hitAt: number;
    sig: string;
    value: unknown;
}
/**
 * 签名缓存本体。**导出只为门禁与测试能看见命中时刻**（`group-insights-swr.spec.ts` 用它断言
 * 「命中时 `at` 没被重写」—— 那条断言在外部观察不到缓存，就只能靠读这一份）。
 * 生产代码一律走 {@link cachedBySig} / {@link cachedBySigAsync}，不要直接动这个 Map。
 */
export declare const entries: Map<string, Entry>;
/**
 * 按 key 前缀的**按需限界**（N16）。
 *
 * 为什么不给整张表设一个全局上限：`contact-meta:` / `sender-names:` / `shard-meta:` /
 * `shard-catalog:` 这些条目的**条数由数据目录决定**（几十条），却是最贵的（每条要开库 +
 * 读 Name2Id + 逐表 PRAGMA）。给它们设上限，就等于「用户狂点聊天时把最贵的条目挤掉」——
 * 省下几百字节换一次全量重载，方向反了。
 *
 * 真正会涨的是 `msg-by-sid:`：key 里带 serverId，条数由「用户点过哪些消息」驱动、
 * 没有天然上限（M11 复审实测负条目 ~740B，命中条目还可能含整份 rich）。
 * 所以只钉这一族，其余照旧。
 *
 * 淘汰语义（W3-3.1 由 FIFO 改成**访问计时 LRU**）：按 `hitAt`（最近一次被读到）排序，
 * 最久没用的先走。`hitAt` 在**写入与命中时都会刷新**，所以「用户一直在看的那几条」
 * 不会排在「写进去就没人碰」的前面。目的既是「内存有上界」，也是命中率不退步。
 * 新增一族只需要在这里加一行。
 */
export declare const METADATA_KEY_FAMILY_LIMITS: ReadonlyArray<{
    prefix: string;
    cap: number;
}>;
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
/**
 * 异步版的签名缓存（P1-2：让出型查询的必经入口）。
 *
 * ## 为什么不能直接 `await cachedBySig(k, s, async () => …)`
 *
 * 同步的 `get` 会把 loader 的返回值（一个 Promise）原样塞进 `entries`，
 * 于是第二次命中拿到的是**同一个已 settle 的 Promise** —— 看着能跑，实际把
 * 「数据变了」这一维整个丢掉：签名重算是同步的，值却永远是第一次那份。
 *
 * ## 合流（同键并发只跑一份）
 *
 * 让出之后两次冷算真的可以同时在跑（面板切来切去、事件重放）。没有合流的话，
 * 54 秒的概览会被并发跑成两份，事件循环反而更堵。所以同键的后来者**等同一份** Promise。
 *
 * 但「等同一份」有个前提要处理：后来者可能带着**更新的签名**。处理办法是
 * 「只由最新那份写回」—— 完成时若自己已经不是在飞的那一份，就把结果丢掉
 * （让新的 loader 去写），避免出现「旧签名后完成、把新数据盖掉」。
 * @param key - 缓存键（含数据根与参数）。
 * @param sig - 数据签名；变了就必须重算。
 * @param loader - 异步装载器。
 * @param maxAgeMs - 保质期。
 * @returns 计算好的值（或复用同键正在跑的那一份）。
 */
export declare function cachedBySigAsync<T>(key: string, sig: string, loader: () => Promise<T>, maxAgeMs?: number, 
/**
 * 要不要把这一次的**结果**写进缓存（W2-9.4）。缺省一律缓存。
 *
 * 为什么需要：可取消的计算会返回**算了一半**的结果。把它缓存 30 秒，
 * 用户就会在接下来的 30 秒里一直看到那份半成品，而且没有任何东西告诉他「这是半的」。
 * 「不缓存」不是丢数据 —— 下一次请求会重算，而重算时已经没人取消它了。
 *
 * 只影响**写回**，不影响在飞去重（同一个 key+sig 的并发调用仍共享同一份计算）。
 * @param value - 这次算出来的值。
 * @returns `false` 表示别写进缓存。
 */
shouldCache?: (value: T) => boolean): Promise<T>;
/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
export declare function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap?: number): void;
/**
 * Drop every cached snapshot (called after a rewrite event when needed).
 */
export declare function invalidateWechatMeta(): void;
/** 推进数据世代。实时同步落地新数据后调用（全树被替换的场合仍用 invalidateWechatMeta）。 */
export declare function bumpDataGeneration(): void;
/** 数据世代签名：给「依赖整棵树」的缓存条目当 sig 用。 */
export declare function dataGenerationSig(): string;
export {};
