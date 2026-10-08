/**
 * laya 决策模型的中文命题预设（纯数据，不碰模型）。
 *
 * **设计约束（PoC 实测得出）**：
 * 一道宽泛的 `choice`（5 选项含 other）Top-1 概率实测只有 **59.8%**、熵 1.06，
 * 分布糊成一团；而聚焦的 `noul` 二值命题锐利度能到 **0.69–0.94**（0.885 / 0.030 / 0.846 / 0.056）。
 * 所以这里的命题一律写成「**一句话能答是/否的聚焦判断**」，不用「说话人想干什么」这类宽泛分类题，
 * `choice` 的选项表也只放**互斥且具体**的候选，刻意不给 `other`
 * ——实测 `other` 会白吃掉一截概率质量，让真正有用的选项读数偏低。
 *
 * 命题里用反引号引用的 `dialogue` 必须与调用方 state 的键一致（laya 按这个键把文本拼进输入），
 * 见 `laya/analysis.ts` 的 `buildDialogueState()`。
 */
/** 命题类型（与 laya 的三种决策原语一一对应）。 */
export type LayaQuestionKind = 'choice' | 'score' | 'noul';
/** `noul`：0-1 概率判断。 */
export interface LayaNoulQuestion {
    type: 'noul';
    instructions: string;
    /** 前端展示用的两端标签；缺省为「不是 / 是」。 */
    labels?: {
        false: string;
        true: string;
    };
}
/** `choice`：带 criteria 的多选一，返回每个选项的概率分布。 */
export interface LayaChoiceQuestion {
    type: 'choice';
    instructions: string;
    /** 选项键 → 中文说明（laya 会把「键: 说明」作为选项文本喂给模型）。 */
    criteria: Record<string, string>;
}
/** `score`：按 criteria 分级打分，返回分值 + 每档概率。 */
export interface LayaScoreQuestion {
    type: 'score';
    instructions: string;
    /** 逐档说明，下标即分值；前端可按 `scale` 归一化展示。 */
    criteria: string[];
    /** 分值上限（默认 `criteria.length - 1`），用于「3.6 / 10」这类展示。 */
    scale?: number;
}
export type LayaQuestion = LayaNoulQuestion | LayaChoiceQuestion | LayaScoreQuestion;
/** 一次分析要问的一组命题。 */
export type LayaQuestions = Record<string, LayaQuestion>;
/**
 * 默认命题组：一次调用同时得出「真假 / 意图 / 情绪 / 紧张度 / 动作」。
 *
 * 六个命题在一次 forward 里并行完成（实测预热后单次 228 ms 覆盖全部命题，
 * 不是每个命题各跑一遍），所以命题数量本身的代价很小，代价在输入长度。
 */
export declare function defaultChatQuestions(): LayaQuestions;
/** 默认命题组的键，供 UI 按固定顺序渲染（对象键序在跨进程序列化后不保证）。 */
export declare const DEFAULT_QUESTION_ORDER: readonly string[];
