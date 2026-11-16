/**
 * 实时同步的**源库签名**（自 `sync.ts` 拆出，纯搬移）。
 *
 * 拆出的原因：`sync.ts` 贴着单文件 1000 行硬上限，而 2026-11-16 的发布门禁改动
 * 需要在同步循环里加「发布成功才记账」「发布前体检」「启动 WAL 对账」三件小事。
 * 签名计算有独立语义（`mtimeNs + size`），与同步循环的调度/发布无关，先搬出来腾出余量。
 *
 * @module query/sync-signatures
 */
/**
 * 源库签名。**用字符串而不是毫秒数**（2026-09-29 第 47 轮对齐缓存层口径）：
 * 缓存侧早已是 `mtimeNs + size`（`meta.ts` 的 `fileSig`，同口径），
 * 而这里一直只比 `mtimeMs` —— 同毫秒内的写入它**看不见**，`mode` 会误判成 `wal`，
 * 于是那个分片的改动要等下一次变得更多才会被同步到。
 * 现在改成纳秒 + 大小（NTFS 100ns 精度，实测 `statSync(...,{bigint:true})` 与普通 stat 开销无差别）。
 */
export interface ShardSig {
    main: string;
    wal: string;
}
/** 源库签名片段：纳秒 + 大小（与缓存层 meta.ts 的 fileSig 同口径）。 */
export declare function statSigStr(path: string): string;
/** 消息分片签名（主库 + 同名 `-wal`）。 */
export declare function shardSig(msgDir: string, file: string): ShardSig;
/** Session-db signature (main + wal). */
export declare function sessionSig(sessionDir: string): ShardSig;
/** Contact-db signature (main + wal). */
export declare function contactSig(contactDir: string): ShardSig;
/** Signature of a plain db dir (main + wal by dbName). */
export declare function plainDbSig(dir: string, dbName: string): ShardSig;
/** 把签名压成一行字符串喂给日志（便于对照「是不是同一份数据」）。 */
export declare function sigKeyOf(sig: ShardSig): string;
