/**
 * 问答主链路的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 2026-10-22 起，`askWechat` 不再自己维护「LLM 规划器 + 固定检索 + 综合生成」
 * 三段式实现，而是统一交给 `askWithRuntime()`：
 *   · `wechat-ask` / `session-ask` / `clawbot-auto` 共用同一套工具循环；
 *   · 工具选择、参数修复、范围守卫、重试与证据收敛都在运行时内完成；
 *   · 本文件只保留宿主接线：取消、流式事件、图片、索引新鲜度与历史落库。
 *
 * @module remotes/askdeep
 */
import type { Context } from '@deepseek-ai/cordis';
import type { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts';
import type { EmbedFn } from '../query/retrieval/embedding.ts';
import type { IntentKind, RerankWeights } from '../query/retrieval/types.ts';
import type { AskOptimizeResult, AskResult, OperationCategory, OperationStatus } from '../types.ts';
import type { VectorBuildResult } from '../types-retrieval.ts';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
import type { ThreadState } from '../query/answer-runtime/thread-state.ts';
import type { AnswerRuntimeStage } from '../query/answer-runtime/types.ts';
/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
interface AskImageInput {
    data: string;
    mediaType: string;
    name?: string;
}
export interface createAskDeepRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    ctx: () => Context;
    askTrace: Map<string, {
        features: Map<string, RerankWeights>;
        citations: string[];
        question: string;
        answer: string;
        intent: IntentKind;
    }>;
    privacyGate: PrivacyGateFn;
    embedModelName: (override?: string) => string;
    makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined;
    makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined;
    makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined;
    /** 思考过程发射器：与可见正文分开推，界面单独折叠展示。 */
    makeReasoningEmitter: (streamId?: string) => ((text: string) => void) | undefined;
    /** 阶段事件发射器：把意图 / 工具 / 综合生成的进度推给界面。 */
    makeStageEmitter: (streamId?: string) => ((stage: AnswerRuntimeStage) => void) | undefined;
    kbModel: (kbId: number, role: KbModelRole) => ResolvedModel;
    askKnownEntities: () => string[];
    askKnownSessions: () => Array<{
        username: string;
        name: string;
    }>;
    saveAskHistory: (options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        source?: string;
        usernameName?: string;
    }, result: AskResult, elapsedMs: number, model: string) => void;
    /** W3-6.1：取本轮问答的取消信号（gateway 持有槽位）。 */
    askSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /** W3-6.1：取消一轮问答；找不到在跑的那一轮时返回 false。 */
    cancelAskJob: (jobId?: string) => boolean;
}
export declare function createAskDeepRemotes(rc: createAskDeepRemotesInputs): {
    askWechat(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: "user" | "assistant";
            content: string;
        }>;
        /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
        streamId?: string;
        /** 入口来源：`ask` = 微信问答页签，`session` = 会话内问答，`auto` = ClawBot。 */
        source?: string;
        /** 会话显示名：历史列表直接显示。 */
        usernameName?: string;
        /** 当前知识库 id；缺省不检索知识库。 */
        kbId?: number;
        jobId?: string;
        /** 数据面：`wechat`（缺省）或 `kb-only`（ClawBot 自动回复）。 */
        dataScope?: "wechat" | "kb-only";
        /** 随问题一起送模型的图片（canonical base64，最多 2 张）。 */
        images?: AskImageInput[];
        /** 系统提示词覆盖；检索材料与「不编造」规则仍由运行时追加。 */
        systemPromptOverride?: string;
        /** 上一轮问答返回的结构化线程状态；跨请求继承会话/联系人与时间窗。 */
        threadState?: ThreadState;
    }): Promise<AskResult>;
    cancelAsk: (options: {
        jobId: string;
    }) => {
        ok: boolean;
        message?: string;
    };
    optimizeAskQuestion(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: "user" | "assistant";
            content: string;
        }>;
    }): Promise<AskOptimizeResult>;
    buildRagVectorIndex(options?: {
        force?: boolean;
    }): Promise<VectorBuildResult>;
};
export {};
