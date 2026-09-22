import { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts';
import { EmbedFn } from '../query/retrieval/embedding.ts';
import { IntentKind, RerankWeights } from '../query/retrieval/types.ts';
import { AskOptimizeResult, AskResult, OperationCategory, OperationStatus } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
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
    privacyBlocked: (feature: string, detail?: string) => string | null;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => {
        ok: true;
        texts: string[];
    } | {
        ok: false;
        error: string;
    };
    embedModelName: (override?: string) => string;
    makeEmbedFn: (model: string, feature?: "ask_embed" | "kb_embed" | "kb_link_suggest") => EmbedFn | undefined;
    makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined;
    makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined;
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
    }): Promise<AskResult>;
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
    }): Promise<{
        ok: boolean;
        status: string;
        rows: number;
        embedded: number;
        elapsed_ms: number;
        message?: string;
    }>;
};
