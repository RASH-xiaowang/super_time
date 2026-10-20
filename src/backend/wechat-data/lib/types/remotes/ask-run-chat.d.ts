/**
 * 一次「文本 + 可选图片」的模型对话调用（2026-10-19 自 `askdeep.ts` 抽出）。
 *
 * 为什么单独成文件：`askdeep.ts` 已逼近 M21 的 1000 行上限，而这一块只依赖
 * `llm.stream` 与 dsh-llm 的组装器，和检索/落库无关；搬出来既守住上限，也让
 * 「usage 回调」这条记账接缝可以单独阅读。
 *
 * @module remotes/ask-run-chat
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock, TokenUsage } from '@deepseek-ai/dsh-llm';
/** 一次对话调用的形状（`runChat` 与带图降级版共用）。 */
export type RunChatFn = (system: string, userText: string, maxTokens: number, onDelta?: (text: string) => void, onReasoning?: (text: string) => void, images?: readonly ImageBlock[]) => Promise<string>;
/**
 * 构造一次「文本 + 可选图片」的对话调用。
 * @param deps - LLM 服务、模型、取消检查与 usage 回调。
 * @returns runChat（系统提示 + 用户文本 + 可选图片块 ⇒ 回答文本）。
 */
export declare function createAskRunChat(deps: {
    llm: Context['llm'];
    provider: string;
    model: string;
    throwIfCanceled: () => void;
    /** 每收到一块模型 usage 就回调（规划 / 生成 / 回炉的调用都会计数）。 */
    onUsage?: (usage: TokenUsage) => void;
}): RunChatFn;
