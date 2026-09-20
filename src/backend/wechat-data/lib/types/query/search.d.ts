import type { SearchHit } from '../types.ts';
/**
 * 把文本切成「unicode61 能正确检索」的形态。
 *
 * 为什么必须这么做：FTS5 靠 tokenizer 切词，而 node:sqlite 只带 `unicode61` ——
 * 它把一整串汉字当成**一个** token，于是 `微信转账收到转账` 里查 `转账` 永远匹配不到，
 * 中文全文检索直接失效（这也是旧代码退回 `LIKE` 的原因，而 LIKE 没有任何相关度排序）。
 *
 * 解法是经典的中文 bigram 索引：**写入时**把每个汉字串拆成相邻 2 字窗口并用空格分隔，
 * 检索时用同样的规则拆查询词，`unicode61` 便能把它们当作独立 token 建 BM25 索引。
 *   微信转账收到转账 → "微信 信转 转账 账收 收到 到转 转账"
 * 查 `转账` → 命中 token `转账`；查 `聊天记录` → 短语 "聊天 天记 记录"（要求连续，精度高）。
 * 拉丁/数字串按整词小写处理；标点丢弃。
 * @param text - 原始文本。
 * @returns 空格分隔的 token 串。
 */
export declare function bigramTokens(text: string): string;
/**
 * 把一个检索词编成 FTS5 短语：bigram 之间要求连续出现（精度优先）。
 *
 * **导出**给知识库检索（`query/kb-search.ts`）复用：两处的索引都是 `bigramTokens`
 * 写进去的 tokens 列，短语编法必须一模一样 —— 各写一份的后果是「消息搜得到、
 * 文件搜不到」这种按模块分裂的怪现象，而它的成因藏在两处相似代码的细微差别里。
 * @param term - 用户输入的一个检索词（可含空格，空格在 bigram 化时被丢弃）。
 * @returns FTS5 短语表达式；无有效 token 时返回空串。
 */
export declare function ftsPhrase(term: string): string;
/**
 * 某个词在索引里的文档频率（df）。
 *
 * 用途：判断一个词是「有区分度的内容词」还是「到处都是的水词/跨词切分噪音」。
 * BM25 自身会在排序时用到 df，但**过滤**词项需要提前知道它 ——
 * 例如兜底 bigram `次转`/`账给`（来自「最近一次转账」的相邻字切分）df 极低，
 * 却是合法的 token 命中，不过滤就会把真正的「转账」通知挤出前列（实测）。
 * @param decryptedDir - decrypted data root.
 * @param term - 检索词。
 * @returns 命中文档数（索引不可用时返回 -1）。
 */
export declare function countIndexMatches(decryptedDir: string, term: string): number;
/**
 * 一次 MATCH 检索全部词项（BM25 排序的全库召回）。
 *
 * 相比旧的「每个词各查一次 LIKE、各取前 20 条、按行号倒序」，这里：
 *   ① BM25 真的按相关度排序，而不是按插入顺序取前 N；
 *   ② 命中数不再被 per-term cap 截断成任意样本
 *      （实测 `合同` 全库 4062 条，旧路径只看得到 20 条 = 0.49% 召回率）；
 *   ③ bm25() 直接给出真实的词 IDF 与词频加权，不再需要 1/(1+hits) 这种近似；
 *   ④ 会话名/发送者名单独存一列（who），「问某人」能命中与他的会话，而不只是正文里出现名字。
 * @param decryptedDir - decrypted data root.
 * @param terms - 检索词（中文按 bigram 短语处理）。
 * @param limit - 最多返回多少条候选。
 * @param opts - 可选的会话范围与人物线索。
 * @returns 按 BM25 排序的命中（含 score，越大越相关）。
 */
export declare function searchIndexBatch(decryptedDir: string, terms: string[], limit?: number, opts?: {
    username?: string;
    person?: string;
}): {
    hits: SearchHit[];
    ranked: boolean;
};
/**
 * Index DB path: sibling of the decrypted dir.
 * @param decryptedDir - decrypted data root.
 * @returns the absolute path of the search index DB.
 */
export declare function searchIndexPath(decryptedDir: string): string;
/**
 * Search index status.
 * @param decryptedDir - decrypted data root.
 * @returns whether the index exists plus row count and built_at timestamp.
 */
/**
 * 已知实体名（联系人备注/昵称；无联系人信息时用会话标题兜底）。
 *
 * 用途：问答检索的「点名识别」。规划器（LLM）偶尔会漏掉问题里明确点到的人，
 * 有这份名单就能在**本地、确定性**地把名字从问题里认出来，进而走实体通道
 * （`who:` 精确命中与某人/某群的往来），而不是只靠 bigram 词法匹配。
 * 读一次联系人与会话表，代价不低，因此调用方应缓存（见 gateway 的 `_knownEntities`）。
 * @param decryptedDir - 解密数据根。
 * @param limit - 最多返回多少个名字（超大通讯录不至于拖慢每次提问）。
 * @returns 去重后的名字列表（2-24 字；过短无法区分、过长多半是群公告式标题）。
 */
export declare function knownEntityNames(decryptedDir: string, limit?: number): string[];
export declare function getSearchIndexStatus(decryptedDir: string): {
    exists: boolean;
    rows: number;
    built_at: string | null;
    ready: boolean;
};
/** 索引新鲜度（内部判据；不经 `@Remote` 暴露，避免改动 typert 的生成 schema）。 */
export interface SearchIndexFreshness {
    /** 索引最近一次构建/同步完成的时刻（毫秒 epoch；0 = 从未记录）。 */
    refreshedMs: number;
    /** 是否有分片比索引新（= 存在尚未入索引的新消息）。 */
    stale: boolean;
    /** 多少个分片比索引新。 */
    staleShards: number;
    /** 索引内最新一条消息的时间（秒；0 = 空索引）。 */
    latestIndexedTime: number;
}
/**
 * 判断索引是否落后于消息分片。
 *
 * 判据是**分片文件 mtime vs 索引刷新时刻**，而不是「分片里最大 sort_seq」：
 * 前者只是一次 `statSync`（O(1)），后者要为 200+ 张会话表各查一次索引。
 * 分片是追加写的，任何新消息都会推新 mtime；反过来 mtime 变新却没有新消息
 * （被 checkpoint / vacuum 碰过）时，增量同步只会读到 0 行，代价可忽略。
 * @param decryptedDir - 已解密数据根。
 * @returns 新鲜度指标。
 */
export declare function getSearchIndexFreshness(decryptedDir: string): SearchIndexFreshness;
/** 提问前的「索引可用且新鲜」保证结果。 */
export interface EnsureIndexResult {
    /** 本次实际做了什么：全量构建 / 增量同步 / 无需动作。 */
    action: 'build' | 'sync' | 'none';
    rows?: number;
    added?: number;
    elapsed_ms: number;
    message?: string;
}
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
/** 一条会话窗口内的消息（用于 chunk 级上下文：单条微信消息几乎不构成检索单元）。 */
export interface WindowMessage {
    local_id: number;
    sort_seq: number;
    create_time: number;
    text: string;
    sender: string;
}
/**
 * 取某个会话在 centerMs 前后 spanMs 内的连续消息（对话窗口）。
 *
 * 为什么便宜：Msg_* 表上带 `(local_type, sort_seq)` 复合索引，窗口查询走
 * `SEARCH ... USING INDEX _TYPE_SEQ`，实测 0ms。这是 chunk 级检索可行的前提 ——
 * 单条消息「我没答应」本身无法回答「谁答应过什么」，必须带上前后的对话。
 *
 * @param decryptedDir - decrypted data root.
 * @param username - 会话 username。
 * @param centerMs - 窗口中心（毫秒时间戳）。
 * @param spanMs - 前后各取多少毫秒。
 * @param limit - 窗口内最多几条。
 * @returns 按时间升序的消息；会话不可读时返回空数组（调用方退化为单条引用）。
 */
export declare function loadMessageWindow(decryptedDir: string, username: string, centerMs: number, spanMs: number, limit?: number): WindowMessage[];
/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export declare function searchIndexMessages(decryptedDir: string, query: string, limit?: number, username?: string): {
    hits: SearchHit[];
    total: number;
    indexed: boolean;
};
