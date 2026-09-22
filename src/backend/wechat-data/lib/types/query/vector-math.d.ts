/** 一次 embedding 请求的函数签名（由 gateway 注入，内部走 ctx.llm.embed）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;
/** SimHash 位数（= 粗筛表的哈希宽度）。 */
export declare const SIMHASH_BITS = 64;
/** 汉明距离的上界：两个 32 位 popcount 相加，最大 64。 */
export declare const MAX_HAMMING = 64;
/**
 * 粗筛表的一行（只保留定位与哈希，不含向量本身）。
 *
 * `rowid` 是「回到向量表取向量的主键」：消息域是 `vectors.fts_rowid`，
 * 知识库域是 `kb_vectors.chunk_id`。
 *
 * `username` 是**分区键**，语义随域而变，两处刻意不同：
 *   · 消息域 = 会话 `username`，`searchDense` 会拿它按会话过滤（粗筛在内存里做，所以必须带上）；
 *   · 知识库域 = 空串 —— 那里按库过滤已经在 SQL 里做掉了（`WHERE kb_id = ?`），
 *     内存再过滤一遍反而会掩盖「SQL 里漏了 kb_id」这种失效（同 kb-search 的单一过滤点纪律）。
 */
export interface HashRow {
    rowid: number;
    lo: number;
    hi: number;
    username: string;
}
/** 生成 SIMHASH_BITS 个随机超平面（每个长度 = dim）。 */
export declare function getPlanes(dim: number): Int8Array[];
/**
 * 两个向量前 `min(len)` 维的点积。
 *
 * 这是 SimHash 与精确余弦打分共用的那一步（向量都已 L2 归一化 ⇒ 点积就是余弦），也正是本文件
 * 存在的理由：两套向量库各写一份，某天只改了一处就是「检索质量悄悄下降而不报错」。
 *
 * 越界读兜成 0 是**点积的加法单位元** —— 「少一项」与「这项是 0」是同一件事，不存在把
 * 「没取到」伪装成「取到 0」的问题。长度不等只可能是存的 dim 与查询的 dim 不一致（换过
 * embedding 模型），那时按短的算 —— 与抽出本函数之前两处写法的口径逐字相同。
 */
export declare function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number;
/** 计算向量的 64 位 SimHash（返回两个 32 位无符号整数表示的高/低位）。 */
export declare function simhash(vec: Float32Array, planes: Int8Array[]): {
    lo: number;
    hi: number;
};
/** popcount（32 位）。 */
export declare function popcount32(x: number): number;
/** L2 归一化（余弦相似度 → 点积）。 */
export declare function l2normalize(v: number[]): Float32Array;
/** Float32Array → BLOB 字节。 */
export declare function vecToBlob(v: Float32Array): Uint8Array;
/** BLOB 字节 → Float32Array（复制，避免引用底层 buffer 被复用）。 */
export declare function blobToVec(b: Uint8Array, dim: number): Float32Array;
/** 文件 mtime+size 指纹（缓存失效依据；向量库两处缓存都用它）。 */
export declare function statSig(p: string): string;
/**
 * 按汉明距离取前 `pool` 个候选（两套向量库共用的粗筛）。
 *
 * 为什么不用 `map(...).sort(...).slice(...)`：粗筛表通常是**十几万行**（本地实测 13.5 万；
 * 另一处 `.all()` 的实测是 20 万行），而每个查询都要为每一行分配一个 `{r, d}` 对象、
 * 再做一次 O(N log N) 的**比较排序** —— 可是我们要的只是**前 pool 名**（pool 是几十到几百）。
 * 这里换成计数选择（计数排序的特例）：
 *   ① 一遍算距离，存进 `Uint8Array`（距离恒在 [0,64]，一字节够）并累加 65 格直方图；
 *   ② 用直方图找出「累计条数 ≥ pool」的那个距离 `limit`；
 *   ③ 再扫一遍按 **(距离升序, 原顺序)** 把**行本身**落位到前 pool 个位置。
 *
 * 第 ③ 步不先排出下标数组再回取行（那是两次 O(N) 访问 + 一张中间数组），而是直接写行 ——
 * 距离表已经是「每行一个字节」，回它一次就够了。
 *
 * 选出来的序列与「全量按距离升序排序后取前 pool」**逐项相同**（含同距离内的先后，
 * 因为计数排序是稳定的）—— 差别只在代价：零逐行分配、无比较排序、两次线性扫描。
 * `pool >= N` 时退化为整表，与原来一致。
 * @param rows - 粗筛表（`loadHashRows` 的结果）。
 * @param qh - 查询向量的 simhash。
 * @param pool - 要取多少个候选。
 * @returns 候选行（距离升序；同距离保持原表顺序）。
 */
export declare function selectByHamming(rows: readonly HashRow[], qh: {
    lo: number;
    hi: number;
}, pool: number): HashRow[];
/** 汉明距离（两条 64 位 SimHash）。 */
export declare function hammingDistance(a: {
    lo: number;
    hi: number;
}, b: {
    lo: number;
    hi: number;
}): number;
