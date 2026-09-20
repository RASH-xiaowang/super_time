/** 一个候选：出现在本库里、还没被 `[[链接]]` 引用的名字。 */
export interface LinkCandidate {
    label: string;
    /** note = 真实存在的笔记标题；entity = 模型从文件里抽出的实体。 */
    kind: 'note' | 'entity';
}
/** 一次建议的结果。 */
export interface SuggestResult {
    ranked: Array<LinkCandidate & {
        score: number;
    }>;
    /** 参与排序的候选数（截断到池上限之后）。 */
    pool: number;
    /** 为什么只有这些 / 为什么一个都没有；界面原样显示，不做美化。 */
    note?: string;
}
/** 候选池上限：再多就不是「补一个想不起来的链接」而是「把整个库 embedding 一遍」了。 */
export declare const SUGGEST_POOL_MAX = 80;
/**
 * 相似度下限。低于这个值的候选在界面上只是噪音：短标题之间的余弦本来就不高，
 * 但 0.1 以下基本是「同库里的任意两句话」的基线水平。
 * 阈值给出来是为了**可解释**（芯片上显示分数），不是当成质量保证。
 */
export declare const SUGGEST_MIN_SCORE = 0.15;
/**
 * 正文里已经写过 `[[目标]]` 的那些目标。
 *
 * 已经连上的名字不该再建议一次 —— 那不是「建议」，是「没看见用户已经做过的事」。
 * 别名写法 `[[目标|显示文本]]` 也要认：那是同一件事的另一种打字方式。
 * 判据与 `parseWikiLinks`、编辑器里的 `extractTargets` 同一口径（取 `|` 之前那段）。
 * @param text - 笔记正文（或标题+正文拼起来的串）。
 * @returns 归一化后的目标集合。
 */
export declare function alreadyLinked(text: string): Set<string>;
/**
 * 把候选按与正文的语义距离排序。
 * @param queryText - 正在编辑的正文（会被截到 1200 字：建议要的是主题，不是全文）。
 * @param candidates - 候选（调用方负责去重与截断到 `SUGGEST_POOL_MAX`）。
 * @param embed - 已过隐私闸的 embedding 函数。
 * @param opts - `topK`（默认 8）。
 * @returns 排序结果（含池大小与说明；embedding 失败时 ranked 为空 + note 说明原因）。
 */
export declare function rankLinkCandidates(queryText: string, candidates: readonly LinkCandidate[], embed: (texts: string[]) => Promise<number[][]>, opts?: {
    topK?: number;
}): Promise<SuggestResult>;
