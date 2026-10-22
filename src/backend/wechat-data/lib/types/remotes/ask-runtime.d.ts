/**
 * 问答运行时 v2 的生产编排层。
 *
 * 运行时（`query/answer-runtime/*`）只负责意图、工具循环、证据与状态；这里把
 * 三个入口的装配细节接起来：
 *   · 微信问答 / 会话内问答 / ClawBot 自动回复共用同一套编排；
 *   · 工具选择阶段只看到规则与范围，证据在综合阶段才出网；
 *   · 所有真正发给模型的文本都先过隐私闸门；
 *   · 最终结果仍保持旧 `AskResult` 形状，新增字段只做附加。
 *
 * @module remotes/ask-runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ThreadState } from '../query/answer-runtime/thread-state.ts';
import { type AnswerIntentLlmClassifier } from '../query/answer-runtime/intent.ts';
import type { AnswerRuntimeEmitStage, AnswerRuntimeOp, AnswerSynthesizeFn } from '../query/answer-runtime/types.ts';
import type { AnswerStatus } from '../query/answer-runtime/evidence.ts';
import type { AnswerProfileId } from '../query/tools/profiles.ts';
import { type AskDataScope, type AskImageInput, type AskScope, type PreparedAskImages } from './ask-runtime-prompt.ts';
import { type RunChatFn, type RunChatTurnFn } from './ask-run-chat.ts';
import type { RetrievalTool, ToolContext } from '../query/tools/types.ts';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
import type { AskPlan, AskResult } from '../types.ts';
import { type AskRuntimeResult } from './ask-runtime-result.ts';
export { askResultFromRuntime, type AskCitationWithTrace, type AskRuntimeResult, } from './ask-runtime-result.ts';
/** 工具集构建输入；生产侧通常直接返回 `buildAskTools(...)`。 */
export interface AskRuntimeToolBuildInput {
    /** 本次入口对应的 profile；工具装配可按入口裁剪额外能力。 */
    profile: AnswerProfileId;
    plan: AskPlan;
    scope: AskScope;
    kbId?: number;
    wechatDataEnabled: boolean;
    knownEntities: string[];
    now: Date;
}
/** 编排依赖。所有会出网的调用都通过这里注入，便于测试离线替换。 */
export interface AskRuntimeDeps {
    decryptedDir: string;
    provider: string;
    model: string;
    privacyGate: PrivacyGateFn;
    /** 宿主上下文；有附件服务时用于把图片准备成消息块。 */
    ctx?: Context;
    llm?: Context['llm'];
    /** 完整工具集，或按本次 plan/范围装配的工厂。 */
    tools: readonly RetrievalTool[] | ((input: AskRuntimeToolBuildInput) => readonly RetrievalTool[]);
    /** 基础工具上下文（可选；会被本次范围覆盖）。 */
    toolContext?: Partial<ToolContext>;
    knownEntities?: string[] | (() => string[]);
    knownSessions?: string[] | (() => string[]);
    /** 结构化会话目录：显示名/别名 → 真实 username。 */
    knownSessionCatalog?: Array<{
        username: string;
        name?: string;
        aliases?: readonly string[];
    }> | (() => Array<{
        username: string;
        name?: string;
        aliases?: readonly string[];
    }>);
    runTurn?: RunChatTurnFn;
    runChat?: RunChatFn;
    /** 低置信意图分类器；缺省在 llm + runChat 可用时复用同一模型自动装配。 */
    intentClassifier?: AnswerIntentLlmClassifier;
    /** 意图分类独立 deadline，默认 4000ms；0 表示关闭。 */
    intentClassifierDeadlineMs?: number;
    prepareImages?: (options: AskRuntimeOptions) => Promise<PreparedAskImages> | PreparedAskImages;
    /** 直接替换综合生成（主要供测试或特殊入口使用）。 */
    synthesize?: AnswerSynthesizeFn;
    threadState?: ThreadState;
    throwIfCanceled?: () => void;
    /** 本轮取消信号；用于唤醒工具重试退避。 */
    cancelSignal?: AbortSignal;
    emitDelta?: (text: string) => void;
    emitReasoning?: (text: string) => void;
    emitStage?: AnswerRuntimeEmitStage;
    op?: AnswerRuntimeOp;
    now?: Date;
    maxRounds?: number;
    maxCallsPerRound?: number;
    maxTokens?: number;
    toolDeadlineMs?: number;
    /** 单次模型轮次 deadline；缺省由运行时取 120000ms，0 = 关闭。 */
    modelDeadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
/** 单次问答选项（与旧 `askWechat` 入参保持一致）。 */
export interface AskRuntimeOptions {
    question: string;
    username?: string;
    from?: string;
    to?: string;
    history?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    source?: string;
    usernameName?: string;
    kbId?: number;
    dataScope?: AskDataScope;
    images?: readonly AskImageInput[];
    systemPromptOverride?: string;
    streamId?: string;
    /** 上一轮返回的结构化线程状态；用于跨请求继承会话/联系人/时间窗。 */
    threadState?: ThreadState;
    now?: Date;
}
/**
 * 入口：跑一次完整问答。
 *
 * @param deps - 装配依赖（工具集、模型调用、隐私闸、取消检查）。
 * @param options - 本次问题、范围、历史与图片。
 * @returns 旧 `AskResult` 形状 + 状态/证据/trace 等附加字段。
 */
export declare function askWithRuntime(deps: AskRuntimeDeps, options: AskRuntimeOptions): Promise<AskRuntimeResult>;
/** 供主线程判断旧结果里的状态字段（类型收窄辅助）。 */
export declare function runtimeStatusOf(result: AskRuntimeResult | AskResult): AnswerStatus | undefined;
/** 判断一个未知值是否是运行时状态（用于客户端/日志读取旧记录）。 */
export declare function isAnswerStatus(value: unknown): value is AnswerStatus;
/** 运行时 trace 的形状守卫（避免调用方把任意对象当 trace 用）。 */
export declare function isToolCallTrace(value: unknown): boolean;
