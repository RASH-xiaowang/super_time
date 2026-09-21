/**
 * `query/search.ts` 的「索引的底层构造：常量、meta 水位、分词、批量查询与状态」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-scaffold
 */
import { DatabaseSync } from 'node:sqlite';
import type { SearchHit } from '../types.ts';
/**
 * WeChat full-text message search index (FTS5), rewritten from st_control
 * chat_search_index.rs. The index DB lives next to the decrypted dir
 * (data/wechat/wechat_search.db); search prefers the index and falls back
 * to a bounded full-table scan over the message shards.
 */
/** zstd magic bytes (WCDB compressed blobs). */
export declare const ZSTD_MAGIC: Buffer<ArrayBuffer>;
/**
 * 索引 schema 版本：结构变化时自动重建（存在 meta 表里）。
 *
 * v3 → v4 的两处结构变更：
 *   ① `message_meta` 增加时间范围索引 —— 「今天聊了啥」这类**纯时间问法**要按
 *      `create_time` 直取一个日期段的消息，而不是靠词法匹配（见 listMessagesInRange）；
 *   ② `meta` 表记录每个消息分片的**增量水位线**（`shard_wm:<分片名>` = 已入索引的
 *      最大 `sort_seq`）与索引刷新时刻（`refreshed_ms`）。
 *
 * 不升版本就没法安全地做增量：老索引里没有水位线，增量会从 0 开始重读整个分片，
 * 把已索引的消息**重复**写一遍。升版本顺带把「老索引一律停在构建当天」这个存量
 * 问题一次性修掉（实测生产索引 built_at=2026-09-13、库内最新消息 2026-09-11，
 * 而消息分片里已经有 2026-09-18 的对话）。
 */
export declare const INDEX_SCHEMA_VERSION = "4";
/** 索引最近一次构建/同步完成的时刻（毫秒 epoch，来自 Date.now()）。 */
export declare const REFRESHED_KEY = "refreshed_ms";
/** 每个消息分片的增量水位线（已入索引的最大 sort_seq，毫秒）在 meta 里的键前缀。 */
export declare const SHARD_WM_PREFIX = "shard_wm:";
/**
 * 分片 mtime 与 `refreshed_ms` 的容许偏差（毫秒）。
 *
 * 「分片在我们读完它之后才 commit 出新 mtime」这一边界情形、以及文件系统的时间粒度，
 * 都可能让刚同步完的分片看起来仍然更新。宁可多同步一次（读到 0 行、只花几次索引
 * 查找），也不要漏掉新消息。
 */
export declare const REFRESH_SLACK_MS = 3000;
/**
 * 幂等创建 `message_meta` 的时间索引。
 *
 * 没有它，纯时间问法（「今天聊了啥」）就得对整张 `message_meta` 全表扫描 + 排序
 * （实测 15 万行 25ms 起，且随入库消息线性变差）。
 * @param db - 已打开的索引库（可写）。
 */
export declare function ensureMetaIndexes(db: DatabaseSync): void;
/** 读取 `meta` 表里的增量水位线（分片文件名 → 已入索引的最大 sort_seq）。 */
export declare function readWatermarks(db: DatabaseSync): Map<string, number>;
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
/** 索引是否可用（存在且版本匹配）。 */
export declare function indexReady(decryptedDir: string): boolean;
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
/** Decode raw column bytes: zstd-decompress when the magic matches. */
export declare function tryDecompress(data: Buffer): Buffer | null;
/**
 * Index DB path: sibling of the decrypted dir.
 * @param decryptedDir - decrypted data root.
 * @returns the absolute path of the search index DB.
 */
export declare function searchIndexPath(decryptedDir: string): string;
/** Msg_<md5(username)> table name for a talker. */
export declare function msgTableName(username: string): string;
/** Decode a BLOB or TEXT cell to UTF-8 text (zstd + GBK aware). */
export declare function decodeCell(v: unknown): string;
/** Message shard DB files under <decrypted>/message (catalog-backed, sorted). */
export declare function messageShardFiles(decryptedDir: string): string[];
/** Session usernames from session.db (SessionTable or Session). */
export declare function loadSessionUsernames(decryptedDir: string): string[];
/** Display names: contact remark/nick then session titles. */
export declare function loadDisplayNames(decryptedDir: string): Map<string, string>;
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
