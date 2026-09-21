/**
 * `query/search.ts` 的「索引的构建与同步：ensure/sync/build、让出预算、增量维护」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-build
 */
import type { SearchHit } from '../types.ts';
import { EnsureIndexResult } from './search-scaffold.ts';
/**
 * 保证索引**存在且包含最新的消息**（提问路径的唯一入口）。
 *
 * 这是把「索引过期」从**永不自愈**变成自愈的关键。旧实现只在 `!ready`（索引缺失 /
 * schema 版本不符）时构建，而 `ready` 与「分片里有没有新消息」毫无关系 ——
 * 索引一旦建成，之后微信写入的消息**永远不会**进入索引。实测生产索引
 * `built_at=2026-09-13`、库内最新消息 2026-09-11，而消息分片里已经有 2026-09-18 的
 * 对话（09-17 一天 139 条）。问「今天聊了啥」时当天数据根本不在检索空间里，
 * BM25 只能召回正文恰好写着「今天」的旧消息（同年 2/3/7 月）—— 这就是
 * 「回复内容不正确 + 消息列表里出现其他日期的消息」的根源。
 * @param decryptedDir - 已解密数据根。
 * @returns 本次动作与耗时（写进操作日志，便于解释「为什么这次提问慢」）。
 */
export declare function ensureSearchIndex(decryptedDir: string): Promise<EnsureIndexResult>;
/** 增量同步结果。 */
export interface SyncResult {
    status: 'ok' | 'skipped' | 'error';
    /** 本次新入索引的消息条数。 */
    added: number;
    /** 本次实际读取的分片数。 */
    shards: number;
    elapsed_ms: number;
    message?: string;
}
/**
 * 按索引文件路径键控的增量同步单飞闸。
 *
 * 理由与 `inflightIndexBuilds` 相同：写事务会跨 macrotask 保持开启，并发的第二次
 * 调用只会拿到 `database is locked`。并发调用直接复用同一个在飞同步。
 */
export declare const inflightIndexSyncs: Map<string, Promise<SyncResult>>;
/**
 * 增量同步：只把「分片里新追加、尚未入索引」的消息补进 FTS。
 *
 * 为什么必须有它：微信是**持续写入**的，而 `buildSearchIndex` 的成本与**全量条数**
 * 同阶（实测 13.5 万条 5.4s），不可能每次提问都全量重建。水位线按**分片**记：
 * 分片是追加写的，`sort_seq > 水位线` 即「上次没读过的新行」，而 Msg_* 表上带有
 * 独立的 `_SORTSEQ` 索引，实测定位尾部 0ms（见 working/sync-feasibility.txt）。
 * 因此增量代价与**新增条数**同阶 —— 通常几十条、毫秒级。
 * @param decryptedDir - 已解密数据根。
 * @returns 同步结果（added = 新入索引的条数）。
 */
export declare function syncSearchIndex(decryptedDir: string): Promise<SyncResult>;
/** 增量同步实现（见 syncSearchIndex 的说明）。 */
export declare function runSyncSearchIndex(decryptedDir: string): Promise<SyncResult>;
/**
 * 按时间窗口直取消息（**纯时间问法**专用）。
 *
 * 为什么需要它：「今天聊了啥」这类问题**没有内容词** —— 拆出来的 bigram 全是
 * 「今天 / 天聊 / 聊了 / 了啥」，BM25 命中的是正文恰好写着「今天」的消息
 * （实测命中的是同年 2/3/7 月的旧对话），而当天真实消息一条都召不回来
 * （结构化通道按日期过滤后 0 命中 → `hintHits=0`）。纯时间问法的正解是
 * **按日期段枚举**，不做任何内容匹配。
 *
 * 只读我们自己维护的 `message_meta`（`(username, create_time)` 索引），
 * 不碰 200+ 张微信会话表。
 * @param decryptedDir - 已解密数据根。
 * @param fromSec - 起始（含，秒）。
 * @param toSec - 结束（含，秒）。
 * @param limit - 最多返回多少条（**按时间新→旧截断**，即保留窗口内最近的）。
 * @param username - 可选的会话范围。
 * @returns 命中（时间新→旧）与索引是否就绪。
 */
export declare function listMessagesInRange(decryptedDir: string, fromSec: number, toSec: number, limit?: number, username?: string): {
    hits: SearchHit[];
    ready: boolean;
};
/**
 * 让出节奏（行数上界）：限制「行数多、每行却很短」的场景。
 *
 * 2000 行的固定开销（逐行解码/判空 + 批量写入）大约几十毫秒，既能把单次阻塞压到远低于
 * 「秒级」，又不会因为过于频繁的 await 明显拖慢构建。
 */
export declare const YIELD_EVERY_ROWS = 2000;
/**
 * 让出节奏（字符上界）：限制「每行很长」的场景。
 *
 * bigram 切分与 FTS 写入的成本 ∝ 文本长度，所以只按行数设阈值时单块耗时随平均行长线性
 * 增长。取值按**实测**成本定：中文每字符约 0.33µs（bigram 下每个汉字都是独立 token，同
 * 字符数比拉丁文本贵 4–10 倍），131072 字符 ≈ 中文 30–70ms、拉丁 6–10ms。
 * 早期版本取 1<<20（约 105 万字符），实测中文单块已达 237–533ms、属「秒级临界」，故收紧。
 */
export declare const YIELD_EVERY_CHARS: number;
/**
 * 单次批量写入（flush）的字符上界。
 *
 * flush 的代价随批量内容长度线性增长，而它必然落在某个「让出块」里：500 行 × 64KB/行时
 * 单次 flush 实测 3.5s、1MB/行时 60.2s。只给循环设上界、不给批量设上界，单块耗时就没有
 * 上界。65536 字符 ≈ 中文 20ms 量级。
 */
export declare const FLUSH_EVERY_CHARS: number;
/**
 * 构建单飞闸（按**索引文件路径**键控）。
 *
 * 转 async 带来的副作用：写事务现在会**跨 macrotask** 保持开启，于是同一进程里
 * 第二次并发调用会直接撞 `database is locked`（改前同步执行不可能交错）。
 * 而 gateway 的问答路径与状态查询都会按需触发自动建索引，很容易撞上。
 * 这里让并发调用复用同一个 in-flight 构建。
 *
 * 键取 `searchIndexPath()` 而不是调用方传入的 `decryptedDir` 字符串：被争用的是**那个 DB
 * 文件**，而 `…\decrypted` 与 `…/decrypted`、带不带结尾分隔符都会解析到同一个文件。按调用
 * 方字符串键控时这些写法会各占一个槽、并发写同一个文件 —— 实测互相撞锁且事件循环停摆
 * 7.5s（`busy_timeout` 只会把「立刻失败」变成「同步忙等后仍失败」）。
 *
 * force 语义：非 force 调用可以加入任何在飞构建；force 调用若撞上在飞的非 force 构建，
 * 不能把对方的「索引已存在」当答复，而要排队在其之后再真正重建一次。
 */
export declare const inflightIndexBuilds: Map<string, {
    promise: Promise<BuildResult>;
    force: boolean;
}>;
/** 构建结果。 */
export interface BuildResult {
    status: string;
    rows?: number;
    built_at?: string;
    elapsed_ms?: number;
    message?: string;
}
/**
 * 构建全文检索索引（FTS5）。
 *
 * @param decryptedDir - 已解密数据根。
 * @param force - 为 true 时即使已有同版本索引也重建。
 * @returns 构建结果（status/rows/built_at/elapsed_ms 或 message）。
 */
export declare function buildSearchIndex(decryptedDir: string, force?: boolean): Promise<BuildResult>;
/**
 * 索引库写闸（同步、不排队）。
 *
 * 索引库有**两个写者**：`buildSearchIndex` 与 `query/members.ts` 的 `contact_fts` 构建。
 * 构建在飞时写事务跨 macrotask 持有写锁，第二个写者只会拿到 `database is locked`；
 * 而 `searchMembers` 是**同步**契约（`@Remote`，改 async 会动客户端契约与 `/api.ts`），
 * 没法 await 排队等闸。
 *
 * 所以这里的语义不是「等锁」，而是「拿不到就**明确**告诉调用方」，由调用方显式降级 ——
 * 而不是先去撞写锁、被拒后再把错误吞掉（实测 40k 行构建在飞时，155/155 次成员搜索走的
 * 就是那条「尝试写→被拒→静默退化为 LIKE」的路）。
 *
 * 键与构建闸一致（`searchIndexPath()`）：被争用的是同一个 DB 文件。
 * @param decryptedDir - 已解密数据根。
 * @param fn - 临界区。必须是同步的：闸不排队，临界区里出现 await 就等于没上锁。
 * @returns 拿到闸时 `{ok:true, value: fn()}`；有构建在飞时 `{ok:false}`。
 */
export declare function withIndexWrite<T>(decryptedDir: string, fn: () => T): {
    ok: true;
    value: T;
} | {
    ok: false;
};
export declare function runBuildSearchIndex(decryptedDir: string, force?: boolean): Promise<BuildResult>;
/**
 * 让出事件循环。
 *
 * node:sqlite 全是同步 API，所以「跑很久」= 「把承载全部查询的 worker 钉住」。
 * 只能靠 await 把控制权交回：`setImmediate` 让 I/O 与其它请求的微/宏任务插进来。
 * 索引构建按「行数 ∨ 字符数」周期性调用它 —— 否则百万行会一次性阻塞数秒。
 *
 * 导出给其它「周期性让出」的构建路径复用（如 `retrieval/embedding.ts` 的向量建库），
 * 免得各自内联一份、各自踩坑。
 */
export declare function yieldToLoop(): Promise<void>;
