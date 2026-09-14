import type { RetrievedDoc } from './types.ts';
/** 一次 embedding 请求的函数签名（由 gateway 注入，内部走 ctx.llm.embed）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;
/** 向量库状态。 */
export interface VectorIndexStatus {
    exists: boolean;
    rows: number;
    dim: number;
    model: string;
    built_at: string | null;
    ready: boolean;
}
/** 稠密召回选项。 */
export interface DenseSearchOptions {
    topK: number;
    /** 低于该余弦相似度直接丢弃。 */
    minSimilarity: number;
    /** SimHash 粗筛保留多少条参与精确计算。 */
    candidatePool: number;
    username?: string;
}
/** 向量库文件路径。 */
export declare function vectorDbPath(decryptedDir: string): string;
/** 向量库状态（不存在/损坏/版本不符时 ready=false）。 */
export declare function vectorIndexStatus(decryptedDir: string): VectorIndexStatus;
/** 生成 SIMHASH_BITS 个随机超平面（每个长度 = dim）。 */
declare function getPlanes(dim: number): Int8Array[];
/** 计算向量的 64 位 SimHash（返回两个 32 位无符号整数表示的高/低位）。 */
declare function simhash(vec: Float32Array, planes: Int8Array[]): {
    lo: number;
    hi: number;
};
/** popcount（32 位）。 */
declare function popcount32(x: number): number;
/** L2 归一化（余弦相似度 → 点积）。 */
declare function l2normalize(v: number[]): Float32Array;
/** docKey = `username:local_id`（与稀疏通道一致的去重键）。 */
declare function docKeyOf(username: string, localId: number): string;
/**
 * 构建/增量更新向量索引。
 *
 * 增量策略：以 message_meta.rowid 为游标，只给尚未入库的行算向量。
 * 这样日常「新消息进来」只多算增量，不重算全库（全量 13.5 万条 ≈ 上万次 embedding，
 * 一次性做完会很久；增量后单次通常只有几十条）。
 * @param decryptedDir - 解密数据根。
 * @param embed - embedding 函数（上层注入，已含隐私判断）。
 * @param opts - 模型名 / 批量 / 单次上限等。
 * @returns 构建结果。
 */
export declare function buildVectorIndex(decryptedDir: string, embed: EmbedFn, opts: {
    model: string;
    batchSize: number;
    maxCharsPerDoc: number;
    maxDocsPerBuild: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    force?: boolean;
}): Promise<{
    status: string;
    rows: number;
    embedded: number;
    embed_calls: number;
    elapsed_ms: number;
    message?: string;
}>;
interface HashRow {
    rowid: number;
    lo: number;
    hi: number;
    username: string;
}
/**
 * 按汉明距离取前 `pool` 个候选（稠密通道的粗筛）。
 *
 * 为什么不用 `map(...).sort(...).slice(...)`：粗筛表通常是**十几万行**（本地实测 13.5 万；
 * 另一处 `.all()` 的实测是 20 万行），而每个查询都要为每一行分配一个 `{r, d}` 对象、
 * 再做一次 O(N log N) 的**比较排序** —— 可是我们要的只是**前 pool 名**（pool 是几十到几百）。
 * 这里换成计数选择（计数排序的特例）：
 *   ① 一遍算距离，存进 `Uint8Array`（距离恒在 [0,64]，一字节够）并累加 65 格直方图；
 *   ② 用直方图找出「累计条数 ≥ pool」的那个距离 `limit`；
 *   ③ 再做一遍计数排序，把 `d <= limit` 的行按 **(距离升序, 原顺序)** 落位。
 *
 * 选出来的序列与「全量按距离升序排序后取前 pool」**逐项相同**（含同距离内的先后，
 * 因为计数排序是稳定的）—— 差别只在代价：零逐行分配、无比较排序、两次线性扫描。
 * `pool >= N` 时退化为整表，与原来一致。
 * @param rows - 粗筛表（`loadHashRows` 的结果）。
 * @param qh - 查询向量的 simhash。
 * @param pool - 要取多少个候选。
 * @returns 候选行（距离升序；同距离保持原表顺序）。
 */
declare function selectByHamming(rows: readonly HashRow[], qh: {
    lo: number;
    hi: number;
}, pool: number): HashRow[];
/**
 * 稠密召回：SimHash 粗筛 → 精确余弦 → topK。
 * @param decryptedDir - 解密数据根。
 * @param queryText - 查询文本（原句）。
 * @param embed - embedding 函数。
 * @param opts - topK / 相似度下限 / 粗筛池大小 / 会话范围。
 * @returns 命中文档（按余弦降序）+ 说明。
 */
export declare function searchDense(decryptedDir: string, queryText: string, embed: EmbedFn, opts: DenseSearchOptions): Promise<{
    docs: RetrievedDoc[];
    scores: number[];
    note?: string;
}>;
/** 计算一条查询文本的向量（供测试与消融实验复用）。 */
export declare function embedOne(text: string, embed: EmbedFn): Promise<Float32Array>;
/** 向量库摘要（前端「数据健康」用）。 */
export declare function vectorIndexSummary(decryptedDir: string): {
    rows: number;
    dim: number;
    model: string;
};
/** 便于测试：导出内部哈希工具。 */
export declare const __internals: {
    simhash: typeof simhash;
    popcount32: typeof popcount32;
    getPlanes: typeof getPlanes;
    l2normalize: typeof l2normalize;
    docKeyOf: typeof docKeyOf;
    selectByHamming: typeof selectByHamming;
    MAX_HAMMING: number;
};
export {};
