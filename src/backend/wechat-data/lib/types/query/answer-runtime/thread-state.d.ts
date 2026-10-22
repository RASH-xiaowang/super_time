/**
 * 多轮线程状态（answer runtime v2）。
 *
 * 目标不是把历史全文再塞一遍给模型，而是把「上一轮已经确定的范围」变成
 * 可继承、可覆盖、可解释的结构化状态：
 *
 *   · 显式本轮范围优先，绝不拿历史覆盖用户明说的会话 / 时间；
 *   · 「那上周呢 / 再往前」相对上一轮时间窗递进，而不是重新按今天算；
 *   · 「他 / 这个群第二条 / 刚才那个文件」从上一轮联系人、会话、引用消息继承；
 *   · 历史只保留最近若干条并受字符预算约束，避免无限增长与无关内容泄漏。
 *
 * 这个模块是纯函数，不读写数据库、不调用模型。
 *
 * @module query/answer-runtime/thread-state
 */
import type { AnswerIntentKind } from './intent.ts';
import { type AnswerHistoryMessage, type AnswerMessageReference, type AnswerTimeRange } from './intent.ts';
/** 默认保留的最近历史条数（约 8 轮）。 */
export declare const THREAD_STATE_MAX_MESSAGES = 16;
/** 默认历史字符预算。 */
export declare const THREAD_STATE_MAX_CHARS = 4000;
/** 可序列化、可持久化的线程状态。 */
export interface ThreadState {
    activeSession?: string;
    activeContact?: string;
    lastTimeRange?: {
        from: string;
        to: string;
    };
    lastEntity?: string;
    /**
     * 稳定引用串，优先 `username:local_id`，否则 `message:<摘要>`。
     *
     * 保留字符串而不是整个对象，是为了能安全落库 / 写 trace；
     * 需要完整消息时由运行时再用 key 调 `get_message_context`。
     */
    lastReferencedMessage?: string;
    lastIntent?: AnswerIntentKind;
    turns: number;
    /** 最近保留的历史（已过滤、截断）。 */
    history?: AnswerHistoryMessage[];
    /** 最近一轮的时间粒度与时区无关标签，便于下一轮递进。 */
    lastTimeGranularity?: AnswerTimeRange['granularity'];
    /** 时间范围是否来自 UI / 服务端硬筛选；硬筛选优先于问题里的相对时间。 */
    lastTimeHard?: boolean;
    /** 被截断掉的条数（只用于 trace 与调试，不参与继承）。 */
    historyOmitted?: number;
}
/** 显式范围：由 UI 筛选器 / SessionAsk 服务端强制传入。 */
export interface ThreadExplicitScope {
    username?: string;
    from?: string;
    to?: string;
}
/** `applyThreadState` 的结果。 */
export interface AppliedThreadState {
    from?: string;
    to?: string;
    session?: string;
    contact?: string;
    referencedMessage?: string;
    reason: string[];
    /** 结构化时间范围（包含递进后的粒度与来源）。 */
    timeRange?: AnswerTimeRange;
    /** 本轮中用户明确重述的字段。 */
    overrides?: ThreadScopeField[];
    /** 分类器给出的意图（若调用方需要）。 */
    intent?: AnswerIntentKind;
    /** 媒体追问提示。 */
    mediaTypes?: AnswerMessageReference['mediaTypes'];
    /** 消息序号 / 引用方式。 */
    messageRef?: AnswerMessageReference;
    /** 本轮最终采用的时间范围是否仍是硬筛选。 */
    timeHard?: boolean;
}
/** `applyThreadState` 可用的选项。 */
export interface ApplyThreadStateOptions {
    now?: Date;
    /** 已知联系人（用于识别「李四」并写入 activeContact）。 */
    knownEntities?: string[];
    /** 已知会话。 */
    knownSessions?: string[];
    /** 当前会话（会话内问答由服务端强制传入）。 */
    currentSession?: string;
}
/** 用户本轮显式覆盖的字段。 */
export type ThreadScopeField = 'session' | 'contact' | 'timeRange' | 'referencedMessage' | 'mediaTypes';
/**
 * 从历史构建线程状态。
 *
 * 继承优先级：
 * 1. 本轮 `explicitScope`（服务端强制 / UI 筛选）；
 * 2. 上一轮 `prev`（结构化的 activeSession / activeContact / lastEntity）；
 * 3. 历史文本中最后一个可识别的人名 / 会话 / 消息引用；
 * 4. 兜底无。
 *
 * @param history - 最近对话历史（纯文本消息）。
 * @param prev - 上一轮状态；缺省表示新线程。
 * @param explicitScope - 本轮显式范围。
 * @param now - 当前时刻（仅用于历史中的时间表达，可注入）。
 * @returns 新线程状态。
 */
export declare function buildThreadState(history: ReadonlyArray<AnswerHistoryMessage>, prev?: ThreadState, explicitScope?: ThreadExplicitScope, now?: Date): ThreadState;
/**
 * 将本轮问题应用到已有线程状态。
 *
 * 显式覆盖 vs 继承：
 *   · 本轮明确会话 / 时间 / 联系人 / 引用对象 → 直接覆盖；
 *   · 「那上周呢」这类递进 → 相对上轮时间窗前移；
 *   · 「这个群第二条」「刚才那个文件」→ 继承会话并解析消息引用；
 *   · 「他」无历史 → `reason` 中标记需要澄清，不伪造联系人。
 *
 * @param question - 本轮用户问题。
 * @param state - `buildThreadState` 或上一轮运行结果。
 * @param opts - 当前时间、已知实体/会话、服务端强制会话。
 * @returns 可传给检索运行时的范围与可解释 reason。
 */
export declare function applyThreadState(question: string, state: ThreadState, opts?: ApplyThreadStateOptions): AppliedThreadState;
/**
 * 本轮回答完成后推进线程状态（供运行时在 `persistAnswerTrace` 后调用）。
 *
 * `buildThreadState` 偏重「从纯历史重建」；这个函数偏重「在已有状态上追加
 * 本轮结果」，避免运行时为了更新状态再把全部历史跑一遍。
 * @param prev - 上一轮状态。
 * @param turn - 本轮问题、意图与回答（回答只留短摘要，不落全文）。
 * @param options - 字符预算等。
 * @returns 新状态。
 */
export declare function advanceThreadState(prev: ThreadState, turn: {
    question: string;
    answer?: string;
    intent?: AnswerIntentKind;
    applied?: AppliedThreadState;
    referencedMessage?: string;
}, options?: {
    maxMessages?: number;
    maxChars?: number;
}): ThreadState;
