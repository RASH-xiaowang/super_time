/**
 * 知识库「解析任务队列」与它的执行器（阶段 D · G-05）。
 *
 * ── 它存在的唯一理由：把「几秒的活」从 `@Remote` 的调用栈里挪走 ──────────
 * `registerKbFile` 是同步的（它是 `@Remote('addKbFiles')` 的实现），而 PDF / Word /
 * Excel 的解析要几百毫秒到几秒。同步做完的话，用户点「确定」后界面冻住，且 IPC 期间
 * **所有**其它接口一起被挡住 —— 计划 H4 的验收正是这条：「解析一份大 PDF 期间，
 * `listKbFiles` 仍在 200ms 内返回」。
 *
 * 于是 B 档只落一行 `parse_state='queued'`，真正解它的是这里。
 *
 * ── 状态机（四个态各自代表一件**已发生**的事，不是进度条刻度）────────────
 * ```
 *   queued ──claim──> parsing ──解析完──> chunking ──同事务──> ready
 *      │                 │                   │
 *      │                 └──── 读不动 ────> failed          （抛出：密码 / 不是那种格式 / 损坏）
 *      └── 抽不出文字 ──> unsupported                        （扫描件式 PDF、空工作簿）
 * ```
 *   · `parsing` 在 **claim 的那一刻**就写（而不是解析完才写）：否则「正在解析」这个
 *     用户看得见的状态永远不会出现，而崩溃恢复也就无从知道该救谁；
 *   · `chunking` 是**真的一段时间**（20MB 正文分块要几百毫秒），不是装饰；
 *   · `ready` 与它的 chunk 行**必须同事务**（`kb-files.ts` 不变量 ②）——
 *     所以 `ready` 这一步不是 UPDATE，见 `commitReady`。
 *
 * ── 为什么**没有** `embedding` 这一步 ─────────────────────────────────
 * 计划的推进序列里列了它，但本仓的向量是**提问时**按需建的（`buildKbVectorIndex`），
 * 且它是纯派生数据。把它塞进队列有两个坏处：① 登记文件变成依赖网络（嵌入要端点），
 * 断网时连登记都做不成；② 与 H7 冲突 —— 「无 Key / 断网仍可用」的前提正是
 * 「没有向量也算 ready，关键词照样搜得到」。所以执行器停在 `ready`，
 * `INTERRUPTED_STATES` 里仍然留着 `embedding`（别的路径将来要用，且让它保持
 * 「进程死了要救」的语义）。
 *
 * ── 不持有跨 `await` 的数据库句柄 ─────────────────────────────────────
 * 解析要几百毫秒到几秒，而 sqlite 的连接持有写锁。若把连接开着去解析，这期间用户
 * 删一个文件、切一次 RAG 开关，全都会撞在 `database is locked` 上 —— 表现为
 * 「点删除没反应」，和解析八竿子打不着，极难归因。所以每次读写都是
 * 「开 → 一条语句 → 关」，解析期间一个句柄都不留。
 *
 * ── 撞锁是可重试的，不是「这份文件坏了」────────────────────────────────
 * 上一条只挡得住**本进程**自己：`node:sqlite` 是同步 API，同一线程里的两条语句
 * 不可能真正交错（`gateway.ts` 里对这一点有 500 次交叉写的实测）。它挡不住
 * **别的进程**握着读锁 —— 而本库是 rollback journal，写侧要排他锁才能 `COMMIT`。
 *
 * 后果严重得不成比例：`runJob` 里这一步失败 = 「**已经解析成功**的正文被整份丢掉，
 * 该行判 `failed`」，用户得先把它从库里移掉、再重新添加才能恢复。真机实测这一格
 * 真的会走到（`working/cdp-kb-files-b.json` 里 `季度报告.pdf` 的
 * `parse_error = 'database is locked'`，而它同一轮的 `中文地层报告.pdf` 是 `ready`）。
 *
 * 所以每个写库步骤都包一层 `withBusyRetry` —— **只重试写，不重跑解析**：解析是
 * 几百毫秒到几秒的那一半，而争用窗口只有毫秒级。
 *
 * 为什么**不**用 `PRAGMA busy_timeout`：`node:sqlite` 是同步 API，忙等会把整个
 * worker 冻住（`search.ts` 里对同一个取舍有实测记录，那边也是「快速失败 + 让出事件循环」）。
 * 这里的等法是 `await sleep(...)`，与 `yieldToLoop()` 同一条纪律。
 */
/** 一次 drain 的结果。 */
export interface KbQueueReport {
    /** 本轮真正处理过的文件数。 */
    processed: number;
    ready: number;
    unsupported: number;
    failed: number;
    /**
     * 已有执行器在跑，本次**没有**另起一个（不是失败，也不需要调用方重试）：
     * 正在跑的那一个会在本轮结束时再跑一轮，因此一定看得到这次新入队的行。
     */
    skipped: boolean;
}
/** 仅供用例清掉「正在跑」的进程内记忆。 */
export declare function resetQueueGuardForTest(): void;
/** 该数据根当下是否有执行器在跑（诊断与用例用）。 */
export declare function isQueueRunning(decryptedDir: string): boolean;
/**
 * 把队列里所有 `queued` 的文件解完。
 *
 * **重复调用是安全的**：已在跑时只挂一面旗并返回 `skipped: true`（见 `drains` 的说明）。
 *
 * 调用点只有两个，都在 `gateway.ts`：启动时扫一次（把上个进程留下的行捡回来），
 * 以及 `addKbFiles` 真正入队了 B 档文件时。存储层不触发它 —— 那会让 `kb-files.ts`
 * 反向依赖本模块，而「谁在什么时候启动后台活」本来就该在网关那一层一眼看全。
 * @param decryptedDir - 解密数据根。
 * @returns 本轮的处理统计。
 */
export declare function drainKbQueue(decryptedDir: string): Promise<KbQueueReport>;
