/**
 * 问答运行时的提示词、结果映射与兜底文案（2026-10-22 自 `askdeep.ts` 抽出）。
 *
 * 这一层只放纯函数与不持有状态的辅助逻辑，生产编排在 `ask-runtime.ts`。
 * 拆开的目的不是缩行数，而是把「模型看到什么」与「运行时怎么调工具」分开：
 * 前者可单独审阅，后者才能按 profile 强制边界。
 *
 * @module remotes/ask-runtime-prompt
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AnswerIntentDecision } from '../query/answer-runtime/intent.ts';
import type { AnswerRuntimeCitation, AnswerRuntimeResourceCitation } from '../query/answer-runtime/types.ts';
import type { AnswerStatus, EvidenceBundle } from '../query/answer-runtime/evidence.ts';
import type { AnswerProfileId } from '../query/tools/profiles.ts';
import { auditGrounding } from '../query/grounding.ts';
import type { GroundingReplyMode } from '../query/grounding.ts';
import type { AskCitation } from '../types.ts';
import type { RunChatFn } from './ask-run-chat.ts';
/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
export interface AskImageInput {
    data: string;
    mediaType: string;
    name?: string;
}
/** 本轮问答的数据面。 */
export type AskDataScope = 'wechat' | 'kb-only';
/** 一次问答的范围。 */
export interface AskScope {
    username?: string;
    from?: string;
    to?: string;
}
/** 自动回复的聊天兜底提示词。 */
export declare function buildEmptyChatPrompt(question: string, history?: ReadonlyArray<{
    role: 'user' | 'assistant';
    content: string;
}>, imageNote?: string): string;
/** 解析本次问答要用的系统提示词。 */
export declare function resolveSystemPrompt(override: string | undefined, dataScope?: AskDataScope): string;
/** 构造用户消息里的回答规则。 */
export declare function buildSynthRules(dataScope: AskDataScope | undefined, timeGuardRule: string): string;
/** 「没检索到原文」时的回答文案。 */
export declare function emptyAnswerText(dataScope: AskDataScope | undefined, profile?: AnswerProfileId): string;
/** 自动回复核对失败后的安全文案。 */
export declare const CHAT_WITHHELD_ANSWER = "\u8FD9\u4E2A\u6570\u5B57\u6211\u8FD9\u8FB9\u6CA1\u6CD5\u786E\u8BA4\uFF0C\u6211\u5148\u95EE\u4E0B\u672C\u4EBA\u3002";
/** 检索范围（只保留非空字段）。 */
export declare function buildAskScope(options: {
    username?: string;
    from?: string;
    to?: string;
}): AskScope;
/** 多轮上下文裁剪：最多 16 条，并受总字数预算约束。 */
export declare function trimAskHistory(historyRaw: ReadonlyArray<{
    role: 'user' | 'assistant';
    content: string;
}> | undefined): Array<{
    role: 'user' | 'assistant';
    content: string;
}>;
/** 图片准备结果。 */
export interface PreparedAskImages {
    blocks: ImageBlock[];
    note: string;
    audit: string;
}
/** 把图片准备成消息块；宿主没有附件服务时直接交给桥接层投影。 */
export declare function prepareAskImages(ctx: Context, llm: {
    resolveModelInfo?: (provider: string, model: string) => Promise<{
        inputModalities?: readonly string[];
    }>;
} | undefined, provider: string, model: string, images: readonly AskImageInput[]): Promise<PreparedAskImages>;
/** 图片被供应商拒绝时的说明。 */
export declare const IMAGE_UNSUPPORTED_NOTE = "\n\n\uFF08\u6CE8\u610F\uFF1A\u5F53\u524D\u6A21\u578B\u770B\u4E0D\u5230\u968F\u6D88\u606F\u9644\u7684\u56FE\u7247\uFF0C\u65E0\u6CD5\u8BC6\u522B\u56FE\u7247\u5185\u5BB9\uFF1B\u8BF7\u5982\u5B9E\u544A\u8BC9\u5BF9\u65B9\u770B\u4E0D\u5230\u56FE\u7247\u5185\u5BB9\uFF0C\u4E0D\u8981\u8BF4\u300C\u6CA1\u6536\u5230\u56FE\u7247\u300D\u3002\uFF09";
/** 累加一次模型调用的 usage。 */
export declare function addTokenUsage(acc: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined;
/** 图片被供应商拒绝时按纯文本重试。 */
export declare function runChatWithImagesFallback(runChat: RunChatFn, op: (category: 'task', action: string, status: 'fail', target: string, detail: string) => void, system: string, userText: string, maxTokens: number, onDelta?: (text: string) => void, onReasoning?: (text: string) => void, images?: readonly ImageBlock[]): Promise<string>;
/**
 * 回答的数据来源说明。
 *
 * 「原文」只统计聊天消息；知识库按文件、聚合事实按条、资源按个分别单列。
 */
export declare function askBasisLine(citations: ReadonlyArray<{
    time?: string;
    username?: string;
    source?: 'msg' | 'kb' | 'agg' | 'resource';
    kb?: {
        fileId?: number;
        fileName?: string;
    };
    snippet?: string;
}>, dataScope?: AskDataScope, resourceCount?: number): string;
/** 归一知识库 id。 */
export declare function normalizeKbId(kbId: number | undefined): number | undefined;
/** 选择入口 profile。 */
export declare function selectAskProfile(options: {
    source?: string;
    dataScope?: AskDataScope;
}): AnswerProfileId;
/** 工具选择阶段的系统提示：只讲规则与范围，不塞原始证据。 */
export declare function buildToolSelectionSystem(input: {
    profile: AnswerProfileId;
    dataScope?: AskDataScope;
    scope: AskScope;
    kbId?: number;
    question: string;
    history: ReadonlyArray<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    imageNote: string;
    now: Date;
}): string;
/** 本轮工具范围的人话描述。 */
export declare function describeAskScope(scope: AskScope, profile: AnswerProfileId): string;
/** 时间线索护栏：有范围时要求模型逐条写真实日期。 */
export declare function buildTimeGuardRule(intent: AnswerIntentDecision, evidence: EvidenceBundle): string;
/** 用运行时引用与资源构造综合生成上下文。 */
export declare function buildRuntimeContext(input: {
    citations: readonly AnswerRuntimeCitation[];
    resources: readonly AnswerRuntimeResourceCitation[];
    intent: AnswerIntentDecision;
    terms: string[];
    scope: string;
    recency: boolean;
    timeHint?: string;
    hintHits?: number;
}): string;
/** 运行时引用 → 旧 AskCitation（只保留公开字段）。 */
export declare function citationToAskCitation(citation: AnswerRuntimeCitation): AskCitation;
/** 构造综合生成提示词。 */
export declare function buildSynthesisPrompt(input: {
    question: string;
    history: ReadonlyArray<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    imageHint: string;
    contextBlock: string;
    dataScope?: AskDataScope;
    timeGuardRule: string;
}): string;
/** 运行时的证据正文，按 evidenceId 索引。 */
export declare function evidenceTexts(evidence: EvidenceBundle): Map<string, string>;
/** 资源正文（参与接地审计，但不计入 [n]）。 */
export declare function resourceTexts(resources: readonly AnswerRuntimeResourceCitation[]): string[];
/**
 * 回答是否实际使用了给定证据。
 *
 * 自动回复没有 [n] 角标，仅“存在引用”不能证明模型真的用了材料：模型完全
 * 可能返回一段通用话术。这里用确定性的内容重合做保守校验：
 *   · 回答里 ≥4 个连续汉字原样出现在证据中，直接通过；
 *   · 否则比较去噪后的汉字二元组，短回答至少重合 1 个、长回答至少 2 个；
 *   · 英文/型号词至少重合 1 个长度 ≥3 的词。
 * 这不能替代语义审查，但能拦住“有引用、回答却完全无关”的无人值守发送。
 */
export declare function hasEvidenceSupport(answer: string, evidenceTexts: readonly string[]): boolean;
/**
 * 按场景完成接地核对与最多一次回炉。
 *
 * 与旧实现保持同一协议：手动问答要求 [n]；自动回复禁止 [n]，但高风险值仍核对。
 */
export declare function resolveGroundedAnswer(input: {
    /**
     * `resource` 只用于「文件/收藏/朋友圈等资源」作为唯一证据的回答：
     * 它和自动回复一样禁止 [n]，但不套用微信闲聊口吻。
     */
    mode: GroundingReplyMode | 'resource';
    answer: string;
    citationCount: number;
    synthPrompt: string;
    evidenceFor: (cited: number[]) => string[];
    allEvidence: string[];
    systemPrompt: string;
    runChat: RunChatFn;
    images?: readonly ImageBlock[];
}): Promise<{
    answer: string;
    citedIndexes: number[];
    withheld: boolean;
    grounding: ReturnType<typeof auditGrounding>;
    repaired: boolean;
    /** 回答是否与证据有可验证的内容重合（`chat` / `resource` 模式使用）。 */
    evidenceUsed: boolean;
}>;
/** 运行态状态 → 旧结果的 insufficient 口径。 */
export declare function isInsufficientStatus(status: AnswerStatus): boolean;
/** 提问消息（工具阶段与兜底阶段共用）。 */
export declare function buildQuestionContent(question: string, images: readonly ImageBlock[]): Array<{
    type: 'text';
    text: string;
} | ImageBlock>;
/** 供编排层判断消息是否携带工具结果。 */
export declare function hasToolResult(messages: readonly Message[]): boolean;
