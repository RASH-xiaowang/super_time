/**
 * 知识库 chunk 向量库（**独立文件** `wechat_kb_vectors.db`）—— 稠密通道的存储层。
 *
 * ── 为什么是独立文件（设计稿 §3.2 已定，理由照抄并落地）────────────────
 *   分块文本是**解析产物**：删掉要用户重新选文件、重新解析。向量是**可重建产物**：
 *   换 embedding 模型、改维度，整个文件丢掉重建即可。两者生命周期不同，放同一个库里，
 *   「重建向量」就会连带冒「重建分块」的风险。
 *   另一半理由来自风险册 R5：复用消息域的 `wechat_rag_vectors.db` 会污染那条热路径的
 *   `rows` / `ready` 判定（改一个库的行数会改另一个域的行为），且两域 docKey 形状不同。
 *
 * ── 与设计稿 schema 的**一处有意增量**：多了 `file_id` ──────────────────
 *   设计稿给的是 `(chunk_id PK, kb_id, dim, vec, hash_lo, hash_hi)`。这里加一列
 *   `file_id`，原因是**跨库 JOIN 在 SQLite 里不可能**（两个文件是两个连接）：
 *     · 删一个文件时，要么「先查 kb_chunks 拿到块 id 列表、再过来按 IN 删」（两次往返、
 *       IN 列表可能上千项），要么冗余一个 `file_id` 后一句 `WHERE file_id=?` 删完；
 *     · 关掉文件级 RAG 开关时要清该文件向量，同理。
 *   冗余的代价是「两处可能不一致」，而它不可能不一致：`file_id` 只在构建时从
 *   `kb_chunks` 一并对齐写入，之后没有任何 UPDATE 会单独改它（改归属走
 *   `reassignKbVectors`，两个值一起改）。**读路径不信任它**：作用域与 RAG 开关
 *   一律回到 `kb_files.db` 上 JOIN 判定（见 `searchKbDense` 第 3 步），
 *   所以就算这一列陈旧，也不会让不该出现的块冒出来。
 *
 * ── 语料来源：`kb_chunks` ⋈ `kb_files WHERE include_in_rag = 1` ────────
 *   与 `searchKb(onlyRag:true)` 完全同源。**不解释、不兜底**：用户明确表态过
 *   「这份文件不许送进模型」，就不该有任何一条它的正文被送进 embedding 接口 ——
 *   所以这个条件写在**取语料的 SQL 里**，而不是拿到结果后再过滤。
 *
 * ── 复用而非重写 ──────────────────────────────────────────────────────
 *   SimHash 粗筛、精确余弦、两阶段建库、单飞闸这套东西与消息域**完全同构**，
 *   差别只在表名、语料 SQL 与作用域键。纯数学部分已抽到 `query/vector-math.ts`
 *   （只有一份实现，两侧共享同一组单测），本文件只写「知识库特有的那一层」。
 */
import { DatabaseSync } from 'node:sqlite';
import type { KbHit } from '../types.ts';
export { KB_VECTORS_DB, kbVectorsDbPath } from './kb-paths.ts';
import { type EmbedFn, type HashRow } from './vector-math.ts';
/** 向量表名（C4 的删除级联与守卫用例都要按名字断言，所以导出而不是散落字面量）。 */
export declare const KB_VECTORS_TABLE = "kb_vectors";
/**
 * 向量库 schema 版本；**结构或哈希算法变化时自动重建**。
 *
 * 与消息域各自一个版本号：两边的表结构本来就不同，共用一个号只会让
 * 「消息域升版本导致知识库白重建」这种无意义的重活发生。
 */
export declare const KB_VECTOR_SCHEMA_VERSION = "1";
/**
 * 「这个库的向量为什么不能用」—— 界面与降级说明要说的是这一句，而不是笼统的「未就绪」。
 *
 * 三种 mismatch 的**处置代价完全不同**，混成一句话用户就没法判断该不该重建：
 *   · `no-index` 从没建过 ⇒ 想用语义检索就建；
 *   · `model-mismatch` 换过嵌入模型 ⇒ 旧向量在新空间里没有意义，必须重建；
 *   · `schema-mismatch` 表结构升过版 ⇒ 全表都要重建（不只是本库）；
 *   · `no-model` 调用方没给出「当前用哪个模型」⇒ **无法背书溯源**，按不可用处理。
 *     这条存在的原因：以前记账名是写死的 `'default'`，等于没有溯源，
 *     于是「换模型」这件事在库里根本不留痕迹（见 `docs/KB-MODEL-CONFIG.md` §7 F1）。
 */
export type KbVectorStaleReason = '' | 'no-index' | 'model-mismatch' | 'schema-mismatch' | 'no-dim' | 'no-model';
/** 向量库状态（**按库**：`rows` 是「这个库里有多少块已入库」）。 */
export interface KbVectorIndexStatus {
    exists: boolean;
    rows: number;
    dim: number;
    /** meta 里记的「最近一次构建用的模型名」—— 诊断用；判定看 `models` 与 `current`。 */
    model: string;
    /** 本库向量行里**实际**出现过的模型名（去重 + 排序）。空表 ⇒ 空数组。 */
    models: string[];
    /** 判定时传入的「当前嵌入模型名」（与发送方同一个解析，见 gateway 的 `embedModelName`）。 */
    current: string;
    /** 未就绪的原因；`''` 表示就绪。 */
    staleReason: KbVectorStaleReason;
    built_at: string | null;
    ready: boolean;
}
/** 稠密召回选项。 */
export interface KbDenseSearchOptions {
    topK: number;
    /** 低于该余弦相似度直接丢弃。 */
    minSimilarity: number;
    /** SimHash 粗筛保留多少条参与精确计算。 */
    candidatePool: number;
    /**
     * 查询向量是哪个模型算出来的。
     *
     * 必须传：不传就没法判「库里那批向量是不是同一个模型的产物」，而维度相同、
     * 语义空间不同的两个模型（`bge-m3` 与 `bge-large-zh` 都是 1024 维）恰恰是
     * **唯一一种维度检查抓不到**的错配 —— 硬算余弦会得到一个看起来正常、
     * 实际没有意义的排序。
     */
    model: string;
}
/** 建库结果（形状与消息域 `VectorBuildResult` 对齐，便于两处日志口径一致）。 */
export interface KbVectorBuildResult {
    status: string;
    rows: number;
    embedded: number;
    embed_calls: number;
    elapsed_ms: number;
    message?: string;
}
/**
 * 打开（并初始化）向量库。
 *
 * `CREATE TABLE IF NOT EXISTS` 每次开库都跑一遍。本库虽然新增不久，但**已经发出去的版本**
 * 里没有 `model` 这一列（行级模型溯源是 `docs/KB-MODEL-CONFIG.md` 的 P0 才加的），
 * 所以要写「查 `PRAGMA table_info` → 缺才 `ALTER`」的加列分支：SQLite 没有
 * `ADD COLUMN IF NOT EXISTS`，重跑 `ALTER` 直接抛 duplicate column。
 */
declare function openVectorsDb(decryptedDir: string, readOnly?: boolean): DatabaseSync;
/** 表是否存在（只读连接上用；表缺失时按「空库」处理而不是抛错）。 */
declare function hasTable(db: DatabaseSync): boolean;
/**
 * 向量索引状态（按库）。返回**副本**：调用方都只读，但缓存共享同一个对象时
 * 迟早有人就地改写它（消息域 vector-status.spec.ts 有专门一条用例钉这件事）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param current - 当前嵌入模型名（与发送方同一个解析）。缓存键带着它，
 *   所以「同一个库、换了一个模型」两次查询不会互相污染。
 * @returns 状态快照。
 */
export declare function kbVectorIndexStatus(decryptedDir: string, kbId: number, current?: string): KbVectorIndexStatus;
/**
 * 载入某个库的粗筛表（`(chunk_id, hash_lo, hash_hi)`）。
 *
 * 与消息域同款：粗筛要做「按 (距离, 原顺序) 的计数选择」，需要随机访问全部行，
 * 不是「边读边丢」的扫描，所以**有意**一次取回；代价由指纹缓存兜住
 * （只在进程内首次 / 重建后各付一次）。
 *
 * ⚠ 这里返回的 `rows` 是**共享数组**（缓存里那一份），调用方只读。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @returns 粗筛表。
 */
declare function loadKbHashRows(decryptedDir: string, kbId: number): HashRow[];
/**
 * 构建 / 增量更新**某个库**的 chunk 向量。
 *
 * ── 为什么按库而不是一次全库 ────────────────────────────────────────────
 *   出网范围必须与用户此刻的意图一致：用户在这个库里提问，就该只把这个库的内容
 *   送去 embedding。一次全库构建会把**别的库**的正文也发出去 —— 那是一次没人授权的
 *   范围扩张，而 `include_in_rag` 只表达「文件级」意愿、表达不了「库级」。
 *
 * ── 换模型的正确处置（C4 / WeKnora `06-models` 的硬要求）────────────────
 *   模型名是**行级**属性（`kb_vectors.model`），所以「换模型」只作废**本库里由别的模型
 *   算出来的那些行**：同模型的行仍然有效，删了就是白出网一次；别的库的行更是与本次无关。
 *   唯一仍会清全表的情形是 **schema 版本变更**（列结构/哈希口径变了，每一行都不再合规）。
 *   旧实现是「换模型 = 清全表」，那时的前提是「全库共用一个嵌入模型」；
 *   按库绑定让那个前提失效，处置跟着改（理由见 `docs/KB-MODEL-CONFIG.md` C5）。
 *
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param embed - embedding 函数（上层注入，已含隐私判断）。
 * @param opts - 模型 / 批量 / 上限 / 并发 / 进度 / 强制重建。
 * @returns 构建结果。
 */
export declare function buildKbVectorIndex(decryptedDir: string, kbId: number, embed: EmbedFn, opts: {
    model: string;
    batchSize: number;
    maxCharsPerDoc: number;
    maxDocsPerBuild: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
}): Promise<KbVectorBuildResult>;
/** 块正文摘要（稠密命中没有检索词，所以取块首一段；与稀疏的 `buildSnippet` 不同源）。 */
declare function excerpt(text: string, max?: number): string;
/**
 * 稠密召回：SimHash 粗筛 → 精确余弦 → topK。
 *
 * 三个「必须拒绝」的情形都**返回空 + 说明**，不抛错：
 *   ① 索引未就绪（没建过 / 损坏 / 版本不符）；
 *   ② **查询向量维度与库里不一致**（换过模型但没重建）—— 此时若硬算余弦，
 *      点积会退化成「前 min(n) 维的巧合」，排序看起来正常但没有意义。宁可拒答。
 *   ③ embedding 失败 / 返回空。
 *
 * ⚠ 第 3 步的回读**必须**回到 `kb_files.db` 做 JOIN 再判 `include_in_rag`：
 *   向量库里的行是派生数据，可能在「用户关掉 RAG 开关」与「清向量」之间短暂残留。
 *   读路径不信任派生数据，是本项目的一贯取舍（同 H9）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param queryText - 查询文本（原句）。
 * @param embed - embedding 函数。
 * @param opts - topK / 相似度下限 / 粗筛池大小。
 * @returns 命中（按余弦降序）+ 说明。
 */
export declare function searchKbDense(decryptedDir: string, kbId: number, queryText: string, embed: EmbedFn, opts: KbDenseSearchOptions): Promise<{
    hits: KbHit[];
    note?: string;
}>;
/**
 * 删掉某个文件在向量库里的全部行（**跨库**：向量在另一个文件里）。
 *
 * best-effort：没有跨库事务，且**向量库不存在时直接返回 0**（不新建一个空库 ——
 * 删文件这个动作不该在磁盘上留下一个刚建的空向量库）。失败只留痕不抛：
 * 调用方是删除级联，登记行该删还是要删（残留的向量行读路径也不会采信，见 `searchKbDense`）。
 * @param decryptedDir - 解密数据根。
 * @param fileId - 目标文件 id。
 * @returns 删掉的行数；0 表示「没有东西要删，或删不掉」。
 */
export declare function deleteKbVectorsForFile(decryptedDir: string, fileId: number): number;
/**
 * 把一个文件的向量改归属到目标库（删库时的 `reassign` 分支）。
 *
 * 不做这一步的后果是**静默**的：向量行还在，但 `kb_id` 指向那个即将消失的库 ⇒
 * 目标库检索不到（被 `WHERE kb_id=?` 挡掉）、源库也没了 ⇒ 这些块在稠密通道里
 * 「凭空消失」，而稀疏通道照样搜得到 —— 表现为「关键词能搜到、换个说法就搜不到」。
 * @param decryptedDir - 解密数据根。
 * @param fileId - 目标文件 id。
 * @param targetKbId - 新归属。
 * @returns 改动的行数。
 */
export declare function reassignKbVectors(decryptedDir: string, fileId: number, targetKbId: number): number;
/** 向量库摘要（「数据健康」用）。 */
export declare function kbVectorIndexSummary(decryptedDir: string, kbId: number): {
    rows: number;
    dim: number;
    model: string;
};
/** 便于测试：导出内部工具与缓存（缓存对象只读，别在用例里改它们）。 */
export declare const __internals: {
    loadKbHashRows: typeof loadKbHashRows;
    hasTable: typeof hasTable;
    openVectorsDb: typeof openVectorsDb;
    hashCache: Map<string, {
        sig: string;
        rows: HashRow[];
    }>;
    statusCache: Map<string, {
        sig: string;
        status: KbVectorIndexStatus;
    }>;
    inflightKbBuilds: Map<string, {
        promise: Promise<KbVectorBuildResult>;
        force: boolean;
    }>;
    writeChains: Map<string, Promise<unknown>>;
    excerpt: typeof excerpt;
};
