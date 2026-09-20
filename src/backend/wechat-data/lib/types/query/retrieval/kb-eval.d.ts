/**
 * 知识库检索评估（G-08 的落点）—— 把「知识库搜得好不好」从主观感受变成可回归的数字。
 *
 * ── 为什么必须另起一套（而不是复用 eval-dataset.ts）───────────────────────────
 * `eval-dataset.ts` 评的是**聊天消息**检索：语料是内联在源码里的合成消息，检索适配器
 * 复现「融合 + 重排」。知识库的单元完全不同：单元是**文件块**、语料是磁盘上的真文件、
 * 走的是 `kb-search.ts` 的 FTS5 路径（`ftsPhrase` 把词编成连续 bigram 短语）。
 * 把两者混在一个数据集里，任一侧的改动都会让另一侧的指标漂移，谁也说不清是谁退化了。
 *
 * ── 语料为什么是「真夹具文件」──────────────────────────────────────────────
 * 真实微信数据隐私敏感、分布漂移，不能作为可提交的回归基准；但**合成字符串**又测不出
 * 解析与分块的真实行为（多块切点、CSV 表头重复、GB18030 解码）。折中是：在
 * `src/backend/wechat-data/tests/fixtures/kb-eval/` 放一组固定的真文件，测试把它们
 * 经 `registerKbFile` 写进临时数据根 —— 走的是与线上**逐字节相同**的
 * 「读字节 → 解析 → 分块 → 落 chunk + FTS」路径。
 *
 * ── ground truth 两层，缺一不可 ────────────────────────────────────────────
 *   · **块级**（`markers`）：答案所在的那一块里独有的字符串。它答的是「答案排多前」
 *     （MRR 是这一层最有意义的指标；Precision@10 在「一个答案块 vs 九个正常块」的
 *     场景里天然偏低，别拿它当主指标）。
 *   · **文件级**（`expectFiles`）：答案所在文件。它答的是「那份文件找到了吗」——
 *     用户真正在意的一层，且对分块口径的变动不敏感（换切点不影响文件名）。
 *   两层一起看才能区分「没找到文件」与「找到了文件但那一块没排上来」。
 *
 * ── 检索适配必须复现流水线的 query 构造 ─────────────────────────────────────
 * `pipeline.ts` 的知识库通道传的是 `plan.terms.slice(0, 12).join(' ')`，**不是原问题**。
 * 原因见该处注释：`kb-search` 用 `ftsPhrase` 把每个词编成「连续 bigram 短语」，
 * 把整句问题当一个词传进去就成了要求文件里逐字出现这一整句 —— 正常提问必然 0 命中。
 * 本文件的 `kbEvalRetrieve` 逐字复现这条构造，否则评的是一个不存在的检索器。
 */
import type { KbHit } from '../../types.ts';
import { type EvalReport } from './eval.ts';
/**
 * 评估集夹具文件名（相对 `src/backend/wechat-data/tests/fixtures/kb-eval/`）。
 *
 * 测试会断言「磁盘上的文件集合 == 这张表」：少一个夹具时用例会以「找不到文件」当场报红，
 * 而不是静默退化成「这个库只有 6 个文件」之后指标悄悄变好。
 * `玄武纪要.md` 不在任何用例的 ground truth 里 —— 它属于**另一个知识库**，
 * 只服务于「同一问题在乙库检索不到甲库的块」这条隔离断言的反向一半。
 */
export declare const KB_EVAL_FIXTURES: readonly ["蓝鲸合同.md", "合作台账.csv", "会议纪要-九月.txt", "行业规范摘录.md", "客户拜访记录.md", "旧版合同草稿.md", "押金说明-棠樾.txt", "玄武纪要.md"];
/** 一个知识库评测用例。 */
export interface KbEvalCase {
    id: string;
    question: string;
    /** 模拟规划器给出的关键词（真实链路里这一步一定发生，见 rewrite.ts）。 */
    subQueries?: string[];
    /** 块级 ground truth：**只**可能出现在正确答案那一块里的字符串。 */
    markers: string[];
    /** 文件级 ground truth：答案所在文件。 */
    expectFiles: string[];
    /**
     * 该用例在**稀疏基线**下期望一块都召不回来。
     *
     * 这不是「许愿」，是**量化缺口**：第 9 条用例问的东西文件里确实有答案，只是用词
     * 与问法字面不通（问「滞留期有多长」、文件写「押金留存时间」）。稀疏通道给 0 分是
     * 真实且必然的 —— 它记录的就是稠密通道（T4 / G-02）要抬起来的那一格。
     * 稠密上线后这条断言必须变红，届时改成「>0」并刷新 `docs/KB-EVAL-BASELINE.md`：
     * 那次翻红就是「语义召回真的补上了字面不通的缺口」的唯一证据。
     */
    expectNoHit?: boolean;
    /** 这条用例难在哪（写进基线报告，别让后人只看 id 猜）。 */
    note?: string;
}
/**
 * 评测用例（8 组难例 + 1 条量化缺口的用例）。
 *
 * 难例的选择标准：**都是真实场景里踩过的坑**，且每一组都对应分块/索引的一处具体行为
 * （末块、标题行、CSV 跨组、表头重复、非 UTF-8、实体+属性、纯数字），
 * 而不是「随便问一句看排第几」。
 */
export declare const KB_EVAL_CASES: KbEvalCase[];
/** `kbEvalRetrieve` 的可选参数。 */
export interface KbEvalRetrieveOptions {
    /** 通道配额覆盖；不给则按用例意图取策略默认（与流水线一致）。 */
    topK?: number;
    /** 已知实体名（影响意图分类）；默认空数组（测试没接联系人表）。 */
    knownEntities?: string[];
    /** 固定「现在」（只影响相对时间解析，本评估集没有时间问法）。 */
    now?: Date;
}
/** 一条用例的检索明细（既给断言用，也给基线报告用）。 */
export interface KbEvalRetrieval {
    /** 实际发给 `searchKb` 的查询串（`plan.terms.slice(0,12).join(' ')`）。 */
    query: string;
    /** 完整词表（调试用：看 query 是从哪里截断的）。 */
    terms: string[];
    /** 规则判定的意图（决定通道配额）。 */
    intent: string;
    /** 本次生效的配额。 */
    topK: number;
    hits: KbHit[];
    /** 有序命中键 `kb:<kbId>:<chunkId>`。 */
    docKeys: string[];
    error?: string;
    readError?: string;
}
/** 有序命中的精简形状（避免把整块正文带进报告）。 */
export interface KbEvalHitRef {
    key: string;
    file: string;
    ordinal: number;
}
/** 一个标记词落在哪个名次 / 哪一块（没召回到 `rank = 0`）。 */
export interface KbEvalMarkerHit {
    marker: string;
    /** 1 起的名次；0 = 没召回到。
     *  一条用例有多个标记词时，这个数组就是「答案横跨多块时每一块是否都到了」的直接证据。 */
    rank: number;
    /** 命中块的 ordinal（`-1` = 没召回到）。 */
    ordinal: number;
    file: string;
}
/** 单用例明细。 */
export interface KbEvalCaseDetail {
    id: string;
    intent: string;
    topK: number;
    query: string;
    rawHits: number;
    /** 去重后的文件名（保持名次顺序）。 */
    files: string[];
    /** 前三个文件（用来断言「干扰项没有抢走首位」）。 */
    topFiles: string[];
    ordered: KbEvalHitRef[];
    expectedFiles: string[];
    /** 每个标记词各落在第几名（见 `KbEvalMarkerHit`）。 */
    markerHits: KbEvalMarkerHit[];
    /** 块级第一个相关块的名次（1 起）；没召回到相关块为 null。 */
    firstRelevantRank: number | null;
    /** 块级第一个相关块的 ordinal；没有为 null。 */
    firstRelevantOrdinal: number | null;
    /** 该用例是否期望 0 命中（见 `KbEvalCase.expectNoHit`）。 */
    noHitExpected: boolean;
}
/** `runKbEval` 的入参。 */
export interface KbEvalOptions extends KbEvalRetrieveOptions {
    /** 知识库 id；缺省 1（= `notes.ts` 的 `DEFAULT_KB_ID`）。 */
    kbId?: number;
    /** 截断位置（与 eval.ts 一致，默认 10）。 */
    k?: number;
    /** 用例集覆盖（默认 `KB_EVAL_CASES`）。 */
    cases?: KbEvalCase[];
}
/** 一次评估的完整结果。 */
export interface KbEvalResult {
    kbId: number;
    k: number;
    /** 块级报告（ground truth = `markers`，走 `textIndex` 文本片段匹配）。 */
    chunk: EvalReport;
    /** 文件级报告（ground truth = `expectFiles`，按文件名精确匹配，已按名次去重）。 */
    file: EvalReport;
    details: KbEvalCaseDetail[];
}
/**
 * 在**当前库**上跑一条用例的检索，复现流水线的 query 构造。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 知识库 id。
 * @param c - 评测用例。
 * @param opts - 配额 / 实体 / 现在。
 * @returns 检索明细。
 */
export declare function kbEvalRetrieve(decryptedDir: string, kbId: number, c: KbEvalCase, opts?: KbEvalRetrieveOptions): KbEvalRetrieval;
/**
 * 跑一遍知识库评估集。
 *
 * 同一次调用里出两份报告（块级 / 文件级），共用同一批检索结果 —— 检索只跑一次
 * （`memo` 保证两个 retrieve 闭包不会各查一遍库）。
 * @param decryptedDir - 解密数据根（`wechat_kb_files.db` 在它的父目录）。
 * @param opts - 见 KbEvalOptions。
 * @returns 两份报告 + 逐用例明细。
 */
export declare function runKbEval(decryptedDir: string, opts?: KbEvalOptions): KbEvalResult;
/**
 * 把结果格式化成可读多行文本（写进基线报告 / 操作日志）。
 * @param name - 评估集名。
 * @param r - 结果。
 * @param k - 截断位置（缺省用结果自带的）。
 * @returns 多行文本。
 */
export declare function formatKbEvalReport(name: string, r: KbEvalResult, k?: number): string;
