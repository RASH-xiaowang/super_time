import type { RetrievedDoc } from './types.ts';
import { type EmbedFn, type HashRow } from '../vector-math.ts';
export type { EmbedFn, HashRow } from '../vector-math.ts';
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
/**
 * 向量库状态（不存在/损坏/版本不符时 ready=false）。
 *
 * 返回的是**副本**：调用方（gateway / pipeline / searchDense）都只读，但缓存共享同一个对象时
 * 迟早会有人就地改写它，而复制一个 6 字段字面量的代价远低于这类 bug。
 * @param decryptedDir - 解密数据根。
 * @returns 状态快照。
 */
export declare function vectorIndexStatus(decryptedDir: string): VectorIndexStatus;
/** 构建结果。 */
export interface VectorBuildResult {
    status: string;
    rows: number;
    embedded: number;
    embed_calls: number;
    elapsed_ms: number;
    message?: string;
}
/**
 * 构建/增量更新向量索引。
 *
 * 增量策略：以 message_meta.rowid 为游标，只给尚未入库的行算向量。
 * 这样日常「新消息进来」只多算增量，不重算全库（全量 13.5 万条 ≈ 上万次 embedding，
 * 一次性做完会很久；增量后单次通常只有几十条）。
 *
 * 并发调用会被单飞闸合并到同一轮构建（见 `inflightVectorBuilds` 的说明）：
 * 两个调用方都能拿到成功结果，不会各写一遍、也不会互相撞锁。
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
    signal?: AbortSignal;
}): Promise<VectorBuildResult>;
declare function loadHashRows(decryptedDir: string): HashRow[];
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
/** 向量库摘要（前端「数据健康」用）。 */
export declare function vectorIndexSummary(decryptedDir: string): {
    rows: number;
    dim: number;
    model: string;
};
/**
 * 测试接缝：**只**放"真实入口拿不到"的东西。
 *
 * `loadHashRows` 是 SimHash 粗筛表的读取 —— 它唯一的公开入口是稠密通道那一条，
 * 而那条要先跑 embedding（联网或本地模型），单测量不到它；偏偏**那条连接的生命周期**
 * 必须可测（`query-db-lifetime.spec.ts`：Windows 上没关的句柄 = 数据根再也换不掉）。
 *
 * 原先这里还挂着 `simhash` / `popcount32` / `getPlanes` / `l2normalize` /
 * `selectByHamming` / `MAX_HAMMING` —— 那些的出处其实是 `query/vector-math.ts`，
 * 已经各自 named export（P3-17：测试与门禁脚本改直连 vector-math，
 * 别再绕这层接缝 —— 接缝一旦变成"拿纯函数的后门"，改名与重构的信号就会绕过真正的 API）。
 */
export declare const __internals: {
    loadHashRows: typeof loadHashRows;
};
