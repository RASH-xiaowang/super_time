/**
 * 快照发布的**按目标串行锁**（进程内，不需要文件锁）。
 *
 * ## 为什么需要
 *
 * 同一份快照有两个写者：实时同步的 tick 与「修复/立即解密」RPC。两者都在同一进程里，
 * 都可能在同一时刻对同一个 target 调 `atomicReplace` —— 旧实现的语义是「最后写入者赢」：
 * 同步先解出来的旧一代快照，可能压在修复刚发布的新一代之上，界面短暂回退，下一拍才补回来。
 *
 * ## 边界
 *
 * 只串行化**发布**这一段（毫秒级 + 读取者占用时的重试），不串行化解密：
 *   · 同步 tick 里最多等 {@link PUBLISH_LOCK_WAIT_MS}；等不到就抛错走既有退避，
 *     不会无限期拖住整拍推送；
 *   · 修复是用户显式动作，等一会儿没问题。
 *
 * 微信源库完全不在这个锁的范围内 —— 它只保护我们自己的解密产物目录。
 *
 * @module query/snapshot-publish-lock
 */
/** 等另一个写者发布的最长时间；超时按「本轮失败」返回，交给调用方的退避。 */
export declare const PUBLISH_LOCK_WAIT_MS = 3000;
/**
 * 在目标的发布锁内执行 `fn`。
 * @param key - 目标快照路径（同一路径的发布串行）。
 * @param fn - 真正的发布动作（`atomicReplace` 的主体）。
 * @param waitMs - 最长等待时间（默认 {@link PUBLISH_LOCK_WAIT_MS}；测试用它缩短等待）。
 * @returns `fn` 的返回值。
 * @throws 等待超过 `waitMs`（另一写者仍占着），或 `fn` 自身抛错。
 */
export declare function withPublishLock<T>(key: string, fn: () => Promise<T>, waitMs?: number): Promise<T>;
