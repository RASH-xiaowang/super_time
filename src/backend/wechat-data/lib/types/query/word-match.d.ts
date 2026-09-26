/**
 * 实体名的 **Aho-Corasick 匹配器**（性能关键，2026-09-26）。
 *
 * 为什么要有它：原来是「每条正文 × 全部名字」做 `includes`。本机实测 163,650 条正文 ×
 * 1,979 个名字 ≈ **3.2 亿次子串匹配**，占 `queryWordCloud` 总耗时的 **91%**（`probe-bench.ts`）。
 * AC 用一次 O(文本长度) 扫描取代它 —— 同一样本实测 327ms → **77ms（4.2 倍）**，
 * 全量外推 8.9s → **2.1s**；词表逐项对拍 2,891 个词**完全一致**（`probe-bench2.ts`）。
 *
 * **等价性依据**（这是本实现的正确性前提，改这里前先把四条读懂）：
 *  ① 原实现是在「已被更长名字遮罩过的 rest」上做 `includes`，AC 找的是**原文本**上的所有
 *     出现。两者等价：遮罩把命中段换成空格，而名字不含空格 —— 所以一个出现只要**与任何
 *     已遮罩区间有重叠**，它在 rest 里就不复存在；反之亦然。判定条件 = 「存在一个不与
 *     已遮罩区间重叠的出现」。
 *  ② 处理顺序仍是**长度降序**（与原实现一致），并且只遍历「真的有命中的那几个名字」——
 *     没命中的名字在原实现里 `includes` 恒为 false，本来就没有副作用。
 *  ③ 一个名字无论出现几次都只 **+1**（原实现就是 `counts.set(e, +1)`，不是按出现次数），
 *     这里保持。
 *  ④ bigram 阶段用 `covered` 位图跳过被遮罩的字符：被遮罩处等价于空格，含空格的两字组
 *     不可能是 `/[\u4e00-\u9fff]{2}/`，所以与原实现一致。
 *
 * 匹配器持有可变状态（hits/touched/covered），**逐条正文复用**以避开海量小对象分配；
 * 后端是单线程同步执行，不存在并发共用的问题。
 */
export interface EntityMatcher {
    /** 实体名（已按长度降序；AC 的 `out` 存的是这里的下标）。 */
    words: string[];
    /** goto：节点 → (码元 → 子节点)。 */
    children: Array<Map<number, number>>;
    /** 失配指针。 */
    fail: number[];
    /** 节点 → 在此结束的模式下标（含沿 fail 链继承来的）。 */
    out: number[][];
    /** 每个模式本轮的出现起点（用完清空）。 */
    hits: number[][];
    /** 本轮有命中的模式下标（顺序不定，处理前排序）。 */
    touched: number[];
    /** 被遮罩字符位图（随正文长度扩容）。 */
    covered: Uint8Array;
    /** bigram 累加器（数字 key = 前字码元 * 65536 + 后字码元）。 */
    bigram: Map<number, number>;
}
/**
 * 候选实体名：昵称/备注里取 2-8 字、非纯数字，去重。**不排序**（顺序由匹配器统一负责）。
 * @param decryptedDir 解密数据根。
 */
export declare function entityNamesOf(decryptedDir: string): string[];
/**
 * 用给定名单建 AC 匹配器。**纯函数**（不碰磁盘），所以测试可以直接构造名单来对拍。
 * 内部自己按长度降序排 —— 顺序是语义的一部分（长名先遮罩，见下），不能交给调用方。
 * @param words 候选实体名。
 */
export declare function buildEntityMatcher(words: readonly string[]): EntityMatcher;
/**
 * 把一条正文计入词频：实体先整词计数并遮罩，剩余文本走 bigram + 双重停用过滤。
 * @param text 剥掉 XML 后的正文。
 * @param counts 词频累加器（实体名与 bigram 词共用一个 Map）。
 * @param m 实体名匹配器（见 {@link EntityMatcher}）。
 */
export declare function countText(text: string, counts: Map<string, number>, m: EntityMatcher): void;
