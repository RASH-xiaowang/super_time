/**
 * SQLite 文件头里的**变更计数器**（偏移 24，4 字节大端）。
 *
 * ## 为什么需要它
 *
 * `stat` 类签名（mtime/size）在 **Windows/NTFS 上有一个固有陈旧窗口**：写入并 close 之后，
 * 操作系统对"最后写入时间"是**懒刷新**的 —— 实测插入一行后 `mtimeNs` **一个数字都没变**
 * （`[算料|sig] 插入前=…4940830600:20480 插入后=…4940830600:20480`）。
 * SQLite 格式规范规定：数据库文件每次被修改（**包括 WAL checkpoint**）都会把偏移 24 的
 * 4 字节计数器**自增**。读它与文件时间**完全无关**，因此不受懒刷新影响；
 * 而且只要"开 → 读 32 字节 → 关"，不需要连接、不需要查询。
 *
 * 成本实测（2 万次）：`statSync(path,{bigint:true})` **8.70µs** vs 本函数 **9.10µs**
 * ⇒ 每次签名多约 **0.4µs**，可忽略。
 *
 * ⚠️ 只对**真 SQLite 文件**生效：先验头部魔数（`SQLite format 3`），不是就返回空串 ——
 * 否则会把任意文件第 24-27 字节当计数器，给非数据库文件引入无意义的抖动。
 *
 * 背景与四条失效通道见 `docs/CACHE-INVALIDATION.md`。
 *
 * @param path - 文件路径。
 * @returns 形如 `:<计数器>`；非 SQLite 文件或读不动时为空串。
 */
export declare function sqliteChangeCounter(path: string): string;
