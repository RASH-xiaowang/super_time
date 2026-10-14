/**
 * 同步的**跨进程签名账**：把「哪个目标的源文件、已被成功解密成什么版本」落到磁盘。
 *
 * ## 为什么要单独成文件
 *
 * `sync.ts` 已经贴着本仓的「单文件 1000 行」硬上限（实测 937 行，见
 * `src/backend/tests/m21-file-size-ratchet.spec.ts` 的 `LIMIT`），这套持久化有独立语义，
 * 按本仓既有做法（`sync-pacing.ts`、`image-warm.ts`）另起模块而不是往里塞。
 *
 * ## 这一层解决什么问题（实测）
 *
 * `sync.ts` 的 `lastState` 是**进程内存里的 `Map`**。它只在同一个后端进程内有意义：
 * 后端一重启就是空的 ⇒ 每个目标的 `prev === undefined` ⇒
 * `syncChangedShards` / `syncSessionDb` / `syncContactDb` / `syncPlainDatabase`
 * 一律把 `mode` 判成 `'full'` ⇒ **每次冷启动都把全树整库重解密一遍**，
 * 哪怕微信侧一个字节都没变、磁盘上的解密产物已经是��新的。
 *
 * 代价是实打实的：`sync.ts` 里 `message_1` 一次 ≈ **147 MB / 37456 页**（见该文件第 45 轮的
 * `[sync-trace]` 诊断注释），而 `fullDecryptFile` 每个调度步只处理 64 页
 * ⇒ 单个分片就是几百个让出点。这段整库重解密是「启动后首屏取数排不上队」的**已定位根因**
 * （ 第四节第 7 条，第 42 轮对照实验）：
 * 台账量到的 `前置 12 个页签 → 60153ms` 与「单点该面板只要 517ms」的差别就在这里。
 *
 * ## 为什么这样改**不会**拖慢「新消息可见」
 *
 * 本层只补一件事：**把「上次成功的源签名」跨进程记住**。判定逻辑一行没动 ——
 * 源签名没变 ⇒ 命中 `sync.ts` 里既有的「未变就 continue」分支（零工作量）；
 * 只有 WAL 变了 ⇒ 仍走既有的 `'wal'` 增量补丁路径；主库变了 ⇒ 仍走 `'full'`。
 * 也就是说实时同步的节奏与新鲜度**完全不受影响**，受益的只有「启动时不必白解一遍」。
 *
 * ## 失败方向：这一层的每一条分支都倒向「把活干完」
 *
 * 状态文件读不出来、版本不认识、条目形状不对、解密产物不存在或不是合法 SQLite ——
 * **一律按「没有这份账」处理，回到整库重解密**。理由很直接：
 * 误跳过一次的后果是**永久显示旧数据且没有任何提示**（面板照常出数，只是数是旧的），
 * 而多解一遍的代价只是启动慢几秒。把这一层写反了这个仓的规矩就是反的
 * （见 `docs/CONTRIBUTING.md` 第 5 节「存在性断言等于没断言」那条同源的口径）。
 *
 * 落点选在**数据根**（`decryptedDir` 的上一级，与 `all_keys.json` 同级）而不是解密目录里：
 * 它描述的是**源**的状态，不是产物的状态；放数据根也便于用户自己删掉它强制重来一次。
 */
/** 与 `sync.ts` 的 `ShardSig` 同形（刻意不复用导出，避免两处形状漂移）。 */
export interface SyncSourceSig {
    main: string;
    wal: string;
}
/**
 * 读回上次成功解密时的源签名。
 *
 * 任何一步不成立（文件不存在 / 读失败 / JSON 坏了 / 版本不认识 / 条目形状不对）
 * 都返回一个**空 Map**，也就是「没有这份账」⇒ 调用方会整库重解密。
 * @param decryptedDir - 解密快照根（用于推出数据根）。
 * @returns 目标键 → 上次成功的源签名。空 = 没有可用的账。
 */
export declare function loadSyncSourceState(decryptedDir: string): Map<string, SyncSourceSig>;
/**
 * 记一次「这个目标的源签名已经成功解密成产物了」。
 *
 * 只写内存、不落盘：落盘由 {@link flushSyncSourceState} 在一个 tick 结束时统一做一次，
 * 免得每个目标各写一遍文件（同一轮 tick 里成功目标常有 8 个以上）。
 * @param key - 目标键（分片名 / `session.db` / label，与 `noteSyncSuccess` 的键同一个）。
 * @param sig - 刚刚成功解密的**源**签名。
 */
export declare function noteSyncSourceState(key: string, sig: SyncSourceSig): void;
/**
 * 把待落盘的条目并进既有账本并原子写回。
 *
 * 合并而不是覆盖：tick 内确认成功的目标只是账本的一部分，其余条目来自上一轮，
 * 直接覆盖会把没轮到它们的目标的账抹掉 ⇒ 下次启动它们会被误判成「没解过」。
 * @param decryptedDir - 解密快照根（用于推出数据根）。
 * @returns 是否真的写了盘（没有待写条目时为 false，便于测试与日志判读）。
 */
export declare function flushSyncSourceState(decryptedDir: string): boolean;
/** 清空待落盘条目（测试用）。 */
export declare function forgetPendingSyncSourceState(): void;
/**
 * sync tick 内的 stat 分布（W2-2.3 实测，2026-10-11，本机，20 分片夹具）。
 *
 * | tick 类型 | 耗时 | statSync | existsSync | readdirSync |
 * |---|---|---|---|---|
 * | 冷（lastState 空，要真解 20 个库） | 456ms | 62 | 62 | 1 |
 * | 热（什么都没变） | 0.4ms | 42 | 22 | 1（首次）/ 0 |
 *
 * 两个读数决定了「只探测上次有变化的目录」这件事**不值得做**：
 *
 *  ① 热 tick 已经只要 0.4ms（约每分片 2 次 stat：main + wal，正是 `shardSig`）。
 *     实时同步的间隔是秒级，0.4ms 占比可以忽略；改成「只探测变化目录」最多省 0.3ms，
 *     却要引入「谁变了」的账本与它的失效判断 —— 那是拿一个新状态机换 0.3ms。
 *  ② 冷 tick 的 456ms 全在解密（stat 只占其中 62 次）。即便把 stat 全部省掉，
 *     冷 tick 还是 400ms 以上。所以这一条要优化也不是从 stat 下手。
 *
 * 结论：不改探测策略，实测数字留在这里 —— 下一个人不必再量一遍，
 * 也不会因为「tick 里有几十次 stat」这种看起来难看的数字去动结构。
 */
