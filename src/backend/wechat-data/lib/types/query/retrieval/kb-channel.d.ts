/**
 * 知识库文件块通道（`ChannelName = 'kb'`）—— 把 `kb-search.ts` 的命中
 * 适配成检索流水线的统一文档形状。
 *
 * ── 为什么需要一个适配层，而不是让 kb-search 直接返回 RetrievedDoc ──────────
 *   依赖方向必须单向：`retrieval/` 是**编排层**，`kb-search.ts` 是**读路径**。
 *   若让 `kb-search.ts` 去 import `retrieval/types.ts`，读路径就被绑死在编排层上，
 *   而 `retrieval/` 里的融合权重、通道枚举都还在演进 —— 改一次权重签名就要动读路径。
 *   放在中间的适配层把「知识库检索长什么样」与「检索流水线要什么」彻底解耦。
 *
 * ── 本文件唯一的硬不变量：docKey 的格式 ────────────────────────────────
 *   **`kb:<kbId>:<chunkId>`，只能由 `kbDocKey()` 产出。**
 *   理由有三，缺一条都会静默出错：
 *     ① 与消息键 `username:local_id` 天然不冲突（消息键不含 `kb:` 前缀）；
 *     ② 反馈归因靠它把「用户标为有用的第 [n] 条」对应回特征向量
 *        （`gateway` 落 trace 时用 `citationDocKey()`，与本函数的产物必须逐字相同）；
 *     ③ 融合去重靠它把同一块在多通道的命中合并成一条。
 *   因此**不要在别处手拼这个字符串**（含前缀、分隔符、顺序）。
 *
 * ── create_time 为什么是 0 ──────────────────────────────────────────────
 *   文件块没有「发生时间」。0 在本项目里已经是「无时间」的哨兵：`formatDay` /
 *   `formatClock` / `inRange` / `inSoft` 全部按 0 判空。给一个假时间戳
 *   （如 now）会立刻制造三类错误：新鲜度衰减把文件算成「刚发生的事」、
 *   软时间范围把文件算成「落在你说的那周里」、窗口展开按这个时间去翻聊天记录。
 */
import type { KbHit } from '../../types.ts';
import type { ChannelResult, RetrievedDoc } from './types.ts';
import type { EmbedFn } from '../vector-math.ts';
/**
 * 知识库块的全局去重 / 归因键（**唯一产出点**，不要在别处手拼）。
 * @param kbId - 知识库 id。
 * @param chunkId - 块 id。
 * @returns `kb:<kbId>:<chunkId>`。
 */
export declare function kbDocKey(kbId: number, chunkId: number): string;
/**
 * 引用 → 反馈归因键。
 *
 * 消息引用是 `username:local_id`（与 `RetrievedDoc.docKey` 同构），
 * 知识库引用是 `kb:<kbId>:<chunkId>`（同上）。两处必须是同一套规则，否则
 * 「这条引用有用」会归因不到任何特征向量上 —— 而且**不报错**，只是调参永远不动。
 * @param c - 引用（或引用形状的对象）。
 * @returns 归因键；KB 引用缺 `kb` 明细时退化为空串（宁可归因不到，也不要错配到别人身上）。
 */
export declare function citationDocKey(c: {
    source?: 'msg' | 'kb';
    username?: string;
    local_id?: number;
    kb?: {
        kbId: number;
        chunkId: number;
    };
}): string;
/**
 * 一条知识库命中 → 统一文档。
 *
 * `username` 用 `kb:<kbId>:<fileId>`（**按文件分组**，不是按库、也不是空串）：
 *   · 空串会让同一库里所有块看起来「同会话」，压缩阶段选了一个块就会把 ±15 分钟
 *     窗口内其余块全部当作「这段对话已经进上下文了」而跳过 —— 只剩一条；
 *   · 按库分组同样错误（文件之间没有共同语境）；
 *   · 按文件分组正好等于「同源」的语义，与去重要求一致。
 *   前缀 `kb:` 保证与真实会话 username 不可能相撞（微信 username 不以 `kb:` 开头）。
 * @param kbId - 命中所在知识库。
 * @param h - 检索命中。
 * @returns 统一文档。
 */
export declare function kbDocFromHit(kbId: number, h: KbHit): RetrievedDoc;
/** 知识库通道的选项：**全都不传 = T3 那条纯关键词老路**（降级说明会如实说「仅关键词」）。 */
export interface KbChannelOptions {
    /**
     * embedding 函数。缺省 ⇒ 稠密子路径不跑。
     *
     * ⚠ 传进来只代表「**有能力**」，是否**该**跑还要看 `denseEnabled`（见下）。
     */
    embedFn?: EmbedFn;
    /**
     * 稠密子路径是否启用。
     *
     * 由 `pipeline` 按 `config.embedding.enabled && config.channels.dense.enabled &&
     * policy.channels.includes('dense')` 判定后传进来 —— **刻意不在这里自己读 config**：
     * 本文件是适配层，不该知道检索配置的形状（见头注的依赖方向），判定留在编排层。
     */
    denseEnabled?: boolean;
    /**
     * 与 `embedFn` 同一个解析出来的模型名。
     *
     * 缺省（空串）时稠密一路会**主动不可用**：没有它就没法判「库里这批向量是不是
     * 本次这个模型算的」，而硬算余弦会得到一个看起来正常、实际没有意义的排序。
     */
    embedModel?: string;
    /** 稠密召回的最低余弦相似度（低于它直接丢）。 */
    minSimilarity?: number;
    /** SimHash 粗筛保留多少候选参与精确计算。 */
    candidatePool?: number;
    /** RRF 平滑常数；应与 `config.fusion.k` 一致。 */
    fusionK?: number;
}
/** 融合后的一条命中。 */
export interface FusedKbHit {
    hit: KbHit;
    /** 融合分（RRF 累加值）。**只用于本通道内部排序**：跨通道融合仍只看名次（见 `fusion.ts`）。 */
    score: number;
}
/**
 * 把稀疏与稠密两路命中合成一条有序列表（**纯函数**：不碰 IO、不读配置）。
 *
 * 用 RRF（每个名次贡献 `1/(k+rank)`、多路命中**累加**）而不是分数加权：
 * BM25 无上界、余弦在 [-1,1]，加权必须先归一化，而归一化对异常值极敏感 ——
 * 与消息域 `fusion.ts` 同一套理由、同一个 `k`（由调用方从 `config.fusion.k` 传入）。
 *
 * 同一块被两路同时命中 ⇒ 分数累加（这正是「一致性」信号），并且**保留稀疏那一份**：
 * 稀疏命中的 `marks` 是真的高亮区间，稠密那份恒为空数组（稠密没有「命中词」可言）。
 * 取稠密那份的后果是界面上「搜到了，却一个词都没高亮」。
 * @param sparseHits - 稀疏（FTS5 bm25）命中，顺序即名次。
 * @param denseHits - 稠密命中，顺序即名次（`ranks.dense` 有值时以它为准）。
 * @param opts - `k` = RRF 平滑常数。
 * @returns 按融合分降序的命中（每条的 `ranks` 记下它在各路的原始名次）。
 */
export declare function fuseKbHits(sparseHits: readonly KbHit[], denseHits: readonly KbHit[], opts?: {
    k?: number;
}): FusedKbHit[];
/**
 * 知识库通道：在**当前库**内做「关键词（FTS5 bm25）+ 语义（向量余弦）」的混合召回。
 *
 * ── 两路各跑各的、互不阻断 ─────────────────────────────────────────────
 *   这是混合检索的全部意义。旧实现（T3 只有一条路）把 `searchKb` 抛错/读库失败
 *   当成「整条通道不可用」直接返回 —— 那在只有一条路时是对的；有了第二条路之后，
 *   关键词索引坏掉就让语义召回一起陪葬，没有任何理由。
 *   两路都可能给出 0 条，最终 `active` 只看合并后的条数。
 *
 * ── 降级说明必须如实（两条分支互斥）──────────────────────────────────
 *   · 稠密**跑过** ⇒ 只报它这次真遇到的问题（未建索引 / embedding 失败 / 维度不符），
 *     绝不再透传「仅关键词（未建向量索引）」：索引是就绪的、也查过了，
 *     那句话在这条分支上就是假话；
 *   · 稠密**没跑**（没注入 embedding / 通道关闭）⇒ 说清是**哪一种**没跑
 *     （「未配置向量模型」/「本次未启用向量通道」）。**不照抄**稀疏侧那句
 *     「未建向量索引」：索引已建好、只是这次没让它跑时，照抄出来就是一句假话。
 *
 * 出网：稀疏一路全程本机；稠密一路会把**查询文本**送去 embedding 端点
 * （不送库里的正文 —— 正文只在建库时出网一次，且只送 `include_in_rag = 1` 的文件）。
 * `onlyRag:true` 把文件级开关下推到 SQL，保证「不许送进模型」的文件连候选都进不来。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 当前知识库；缺失/非法时通道不参与。
 * @param query - 检索词（沿用消息侧同一份改写结果，见 pipeline 的调用点）。
 * @param topK - 最多取多少块。
 * @param opts - 见 {@link KbChannelOptions}；不传即纯关键词。
 * @returns 通道结果（`hits` 已按融合分排序、`rank` 重新编为 1..n）。
 */
export declare function kbChannel(decryptedDir: string, kbId: number | undefined, query: string, topK: number, opts?: KbChannelOptions): Promise<ChannelResult>;
