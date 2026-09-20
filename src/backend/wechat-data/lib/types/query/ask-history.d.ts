import type { AskCitation, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot } from '../types.ts';
/** 一条问答记录写入的入参：调用方只需给「已经发生的事实」。 */
export interface RecordAskInput {
    question: string;
    answer: string;
    /** 入口来源：`ask`（微信问答页签）/ `session`（会话内问答）/ 其它自定义值。 */
    source?: string;
    /** 会话范围（空 = 全部会话）。 */
    username?: string;
    /** 会话显示名（便于列表直读，避免历史行只显示 wxid）。 */
    usernameName?: string;
    /** 时间范围（YYYY-MM-DD）。 */
    from?: string;
    to?: string;
    /** 回答模型（provider · model），与面板底部「片段发给谁」同一口径。 */
    model?: string;
    /** 规划器意图。 */
    intent?: string;
    /** 实际参与检索的词项。 */
    terms?: readonly string[];
    /** 引用来源（原样存 JSON，读取时解析回对象）。 */
    citations?: readonly AskCitation[];
    /** 回答正文里真正引用到的序号（1 基）。 */
    citedIndexes?: readonly number[];
    /** 数据来源说明（由检索结果算出，非模型生成）。 */
    basis?: string;
    /** 本轮没有检索到任何原文（未调模型）。 */
    insufficient?: boolean;
    /** 模型内容无法对应到任何原文，已不予采用。 */
    withheld?: boolean;
    /** 失败原因（有值时 status 记为 fail）。 */
    error?: string;
    /** 多阶段检索统计（结构化存 JSON）。 */
    retrieval?: unknown;
    /** 端到端耗时（毫秒）；缺省时由调用方决定是否传。 */
    elapsedMs?: number;
    ts?: number;
}
/**
 * 记录一次问答。best-effort：失败只留痕，绝不抛给调用方 ——
 * 存历史失败绝不能把已经生成好的回答变成一次报错。
 * @param decryptedDir - 解密数据根（历史库位于其父目录）。
 * @param input - 本次问答的事实。
 * @returns 新记录 id；写入失败（或问题/回答都为空）返回 null。
 */
export declare function recordAsk(decryptedDir: string, input: RecordAskInput): number | null;
/**
 * 读取问答历史。
 * @param decryptedDir - 解密数据根。
 * @param query - 搜索/筛选/排序/分页条件。
 * @returns 一页条目 + 命中总数 + 各聚合计数（计数按**未分页**的命中集合算）。
 */
export declare function listAskHistory(decryptedDir: string, query?: AskHistoryQuery): AskHistorySnapshot;
/**
 * 删除若干条问答历史。
 * @param decryptedDir - 解密数据根。
 * @param ids - 要删除的记录 id。
 * @returns 实际删除条数。
 */
export declare function deleteAskHistory(decryptedDir: string, ids: readonly number[]): AskHistoryDeleteResult;
/**
 * 清空全部问答历史。
 *
 * 只由界面上的**显式**入口调用（「清空全部」+ 二次确认）；不做任何自动触发，
 * 也不提供「传空对象就顺手清一遍」的定时策略 —— 静默丢掉历史比库变大糟得多。
 * @param decryptedDir - 解密数据根。
 * @returns 实际删除条数。
 */
export declare function clearAskHistory(decryptedDir: string): AskHistoryClearResult;
/** 保留以 `_` 结尾的导出形态，便于单测直接断言表名与列集合（见 tests/ask-history.spec.ts）。 */
export declare const ASK_HISTORY_DB_FILE = "wechat_privacy.db";
