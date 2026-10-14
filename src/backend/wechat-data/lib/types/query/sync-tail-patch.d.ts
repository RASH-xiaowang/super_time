/** 尾部增量允许的最大页数（2048 页 = 8MB）。再大就退回全量（收益趋近于零）。 */
export declare const TAIL_MAX_PAGES = 2048;
/**
 * 判定一次「主库变化」能否走尾部增量。
 * @param prevMain - 上一次的主库签名（`mtime:size`）。
 * @param curMain - 当前签名。
 * @returns 可行则给出**原始文件内的偏移与页数**；否则 null（走全量）。
 */
export declare function tailAppendPlan(prevMain: string, curMain: string): {
    offset: number;
    pages: number;
} | null;
/**
 * 解密原始主库**尾部**的 `pageCount` 页（自 `offset` 起），**追加**到 staging 快照末尾。
 * 每 {@link TAIL_YIELD_PAGES} 页让出一次事件循环（单线程 worker 上不能钉住别家的请求）。
 * @param rawDb - 原始加密主库路径。
 * @param stagingDb - 已就位的 staging 快照（旧快照的副本；新页追加到它尾部）。
 * @param offset - 原始文件内的字节偏移（上一次签名的大小）。
 * @param pageCount - 新增页数。
 * @param encKey - 派生密钥。
 * @returns 实际追加的页数。
 */
export declare function decryptTailAppend(rawDb: string, stagingDb: string, offset: number, pageCount: number, encKey: Buffer): Promise<number>;
/**
 * 对 staging 快照跑一次 `PRAGMA quick_check`（只读、随用随关，连接纪律见 db-open.ts）。
 * @param stagingDb - staging 快照路径。
 * @returns 自检通过为 true；任何异常（打不开 / 缺表 / 结构坏）为 false。
 */
export declare function tailQuickCheckOk(stagingDb: string): boolean;
