import { type FileHandle } from 'node:fs/promises';
/** staging 拷贝/打开的重试次数与间隔（真机 EBUSY 实测，见 stageCopyRetry 头注）。 */
export declare const STAGE_COPY_ATTEMPTS = 3;
export declare const STAGE_COPY_RETRY_DELAY_MS = 150;
/** 测试注入点：缺省走真 copyFile / 真 sleep。 */
export interface StageCopyDeps {
    copy?: (src: string, dst: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * 带**有界重试**的 staging 打开（与 stageCopyRetry 同一根因：刚被写过的
 * staging 文件会被 Defender/索引器瞬时独占，实测 `open stage_wal 'r+'` 撞
 * `EBUSY` —— 一撞就 10s 退避）。重试口径同 stageCopyRetry。
 * @param path - 要打开的文件。
 * @param flags - open 标志（'r' / 'w' / 'r+'）。
 * @param deps - 测试注入点（缺省走真 open / 真 sleep）。
 */
export declare function stageOpenRetry(path: string, flags: string, deps?: {
    open?: (p: string, f: string) => Promise<FileHandle>;
    sleep?: (ms: number) => Promise<void>;
}): Promise<FileHandle>;
/**
 * 带**有界重试**的 staging 拷贝（2026-10-13，真机 EBUSY 实测）。
 *
 * 真机 75 秒观察（`.tmp-e2e/sync-live-observe.mjs`）抓到两次
 * `EBUSY: copyfile '<decrypted>/message_0.db' -> '...stage_src'`：staging 拷贝
 * 要复制的**解密快照**此刻正被在途查询的连接握着（worker 单线程上，同步节拍与
 * 查询在 await 之间交错 —— 这正是 yieldToLoop 让出事件循环的代价）。旧路径一撞
 * 上就 `noteSyncFailure` 退避 10s：一次毫秒级的握手竞争，赔上 10 秒的新鲜度。
 * 查询连接毫秒内就会 close，所以**重试 3 次 × 150ms** 足以吞掉绝大多数这类竞争；
 * 真撞上持续占用（读者一直不退）才走退避，退避口径不变。
 * @param src - 源文件（快照目标或原始库文件）。
 * @param dst - staging 路径。
 * @param deps - 测试注入点。
 */
export declare function stageCopyRetry(src: string, dst: string, deps?: StageCopyDeps): Promise<void>;
/**
 * 目标旁边是否躺着一个**非空** `-wal`。
 *
 * 同步实现（不是懒）：判据与紧随其后的 `unlink` 必须同拍，异步化只会把「判完到动手之间」
 * 那个窗口拉长 —— 而窗口里正好可能来一次读者。
 * @param target - 快照主文件路径。
 * @returns true = 有帧，换代前必须处理掉。
 */
export declare function strayWalBlocks(target: string): boolean;
/**
 * 丢掉**上一代**的 `-wal`（顺手清 `-shm`）。
 * @param target - 快照主文件路径。
 * @returns 是否仍有非空 `-wal` 挡着换代（true = 还没清掉）。
 */
export declare function discardSupersededWal(target: string): Promise<boolean>;
/**
 * 扫掉上一次中断留下的旁文件/半成品：`.stage_src`/`.stage_wal`/`.decrypt_tmp`
 * 与**非空 `-wal`**（顺手清 `-shm`）。真正的解密产物一个都不匹配。
 *
 * 为什么启动时顺手清 WAL：它的成因是一次没干净收尾的会话（见模块头），而启动这一刻本进程
 * 还没读过任何快照 ⇒ 白捡一次自愈。不清的话，那个库要等到它**下一次换代**才恢复
 * —— 常年不改的分片就一直读不了。
 * @param root - 解密快照根目录。
 */
export declare function cleanStaleSnapshotLeftovers(root: string): Promise<void>;
