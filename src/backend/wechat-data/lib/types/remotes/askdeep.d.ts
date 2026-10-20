import { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts';
import { EmbedFn } from '../query/retrieval/embedding.ts';
import { IntentKind, RerankWeights } from '../query/retrieval/types.ts';
import { AskOptimizeResult, AskResult, OperationCategory, OperationStatus } from '../types.ts';
import { VectorBuildResult } from '../types-retrieval.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
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
    makeEmbedFn: (model: string, feature?: "ask_embed" | "kb_embed" | "kb_link_suggest") => EmbedFn | undefined;
    makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined;
    makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined;
    /** 思考过程发射器（2026-10-16）：与可见正文分开推，界面单独折叠展示。 */
    makeReasoningEmitter: (streamId?: string) => ((text: string) => void) | undefined;
    /** 阶段事件发射器（2026-10-16）：把「规划 / 检索 / 生成」的进度推给界面。 */
    makeStageEmitter: (streamId?: string) => ((stage: {
        key: string;
        label: string;
        status: 'running' | 'done' | 'skipped';
        detail?: string;
    }) => void) | undefined;
    kbModel: (kbId: number, role: KbModelRole) => ResolvedModel;
    askKnownEntities: () => string[];
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
        /**
         * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
         * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
         */
        source?: string;
        /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
        usernameName?: string;
        /**
         * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
         *
         * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
         * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
         * 而不是把别的库的内容也端上来。
         */
        kbId?: number;
        jobId?: string;
        /**
         * 数据面（2026-10-17）：`wechat`（缺省）= 可检索本机微信数据；
         * `kb-only` = **只检索知识库**，不碰本机微信数据。
         *
         * 自动回复（无人值守出网）传 `kb-only` —— 微信里随便一个人发一句话，
         * 不该让本机把全部聊天记录检索一遍并送去模型。
         */
        dataScope?: "wechat" | "kb-only";
        /**
         * 随问题一起送模型的图片（2026-10-18，ClawBot 自动回复「识别图中内容」）：
         * canonical base64 + MIME，最多 2 张。是否真的送模型由当前模型是否声明
         * `image` 输入模态决定；不支持时改成一句「看不到图片内容」的说明。
         */
        images?: AskImageInput[];
        /**
         * 系统提示词覆盖（2026-10-17）：传了就用它当 system，**用户消息里的检索材料与规则照旧**
         * （那部分保证「不编造」的底线）。自动回复用它注入实例的拟人化人设。
         */
        systemPromptOverride?: string;
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
