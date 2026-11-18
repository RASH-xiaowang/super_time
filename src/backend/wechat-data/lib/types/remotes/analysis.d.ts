/**
 * 「消息分析」处理器。
 *
 * 只读本机会话库，把上下文与提问交给用户配置的对话模型，返回结构化 JSON 分析。
 * 出网前统一过 `analyze_message` 隐私闸（由网关注入），与「推荐回复」同级。
 *
 * @module remotes/analysis
 */
import { type AnalysisDeps } from '../query/analysis/analyze.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageAnalysisInput, MessageAnalysisResult } from '../types-analysis.ts';
import type { OperationCategory, OperationStatus } from '../types.ts';
export interface CreateAnalysisRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    selfUsername: () => string;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    gate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    /**
     * 取宿主 `Context`。**默认生成器靠它读「设置里的当前对话模型」**，
     * 网关注入时必须是 `() => this._ctx`；漏注入会得到「模型环境未就绪」而不是崩溃。
     * 测试注入自己的 `generate` 时可以省略。
     */
    ctx?: () => Context;
    /** 测试注入：替换模型生成器。 */
    generate?: AnalysisDeps['generate'];
    /** 测试注入：替换语音转写。 */
    transcribeVoice?: AnalysisDeps['transcribeVoice'];
}
/**
 * 组装分析能力。
 * @param rc - 网关注入的目录、日志、隐私闸与 `Context`（默认生成器读当前对话模型用）。
 * @returns 只暴露 `analyzeMessage` 的处理器。
 */
export declare function createAnalysisRemotes(rc: CreateAnalysisRemotesInputs): {
    analyzeMessage(input: MessageAnalysisInput): Promise<MessageAnalysisResult>;
};
