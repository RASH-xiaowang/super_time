/**
 * 建索引期间的「实时语料复核」判据（从 `kb-vectors.ts` 搬出）。
 *
 * 语料是阶段一开始时的一次快照；索引可能要跑几分钟，这期间用户完全可能删文件、
 * 关掉某个文件的「参与语义检索」、甚至删库。只在快照时过滤的话，被删内容的正文
 * 仍会被送去 embedding（出网），向量还会按快照写回孤儿行。
 * 每批发送前按 `chunk_id` 复核一次：**不在了就不发、也不写**。
 *
 * ## 为什么连接不在这里打开
 *
 * `query-db-lifetime.spec.ts` 的棘轮只认「同一函数内 `new DatabaseSync(` 与
 * `finally` / `catch` 里的 `close()` 配对」。把 open 与 close 藏进返回的闭包里
 * 会被判成泄漏形状 —— 而那个判断在 Windows 上是**真症状**（漏关 ⇒ 解密目录换不掉），
 * 所以宁可让调用方持有连接、在它自己的 `finally` 里关，也不去放宽清单。
 *
 * 本文件因此只做「判据」与「摘除」，不碰连接生命周期。
 */
import type { DatabaseSync } from '../db-open.ts';
/**
 * 连接类型取真源（只用到 `prepare`）：手写一个 `{ get(params: unknown[]) }` 结构类型
 * 会因为**参数逆变**而拒绝真实的 `DatabaseSync`（`SQLInputValue[]` 不能赋给 `unknown[]`），
 * 编译期报 TS2345 —— 这类「形状对得上但方向不对」的类型只能靠真类型。
 */
type ReadOnlyDb = Pick<DatabaseSync, 'prepare'>;
/**
 * 造一个「这个块此刻还在、且仍参与 RAG」的判据。
 *
 * 判据写在 SQL 里（`JOIN kb_files + include_in_rag = 1`）而不是取回后再过滤：
 * 后过滤会让不许出网的行先占满批次名额再被丢掉，批次白跑一趟还可能拖延取消。
 * @param db - 调用方打开的**只读**连接（构建期间不持有写锁）。
 * @param kbId - 目标库（跨库的块同样不算「还在」）。
 * @returns `alive(chunkId)`。
 */
export declare function liveChunkAlive(db: ReadOnlyDb, kbId: number): (chunkId: number) => boolean;
/**
 * 把「已经不在了」的块从待写分组里摘掉（收尾那次复核）。
 *
 * 只改 `groups`（阶段二的写入来源）、不发请求 —— 保证写进向量库的每一行在
 * **提交这一刻**仍属于一个存在且参与 RAG 的块。
 * @param groups - 截断文本 → 待写块。
 * @param alive - 实时复核判据（见 `liveChunkAlive`）。
 */
export declare function pruneDeadChunkGroups<T extends {
    chunkId: number;
}>(groups: Map<string, T[]>, alive: (chunkId: number) => boolean): void;
export {};
