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
import type { AnswerModelTurn, AnswerRunTurnFn } from '../query/answer-runtime/types.ts';
/**
 * 一次对话调用的形状（`runChat` 与带图降级版共用）。
 *
 * 第 7 参是本轮模型调用的硬截止/取消信号；旧调用方可继续只传前 6 参。
 */
export type RunChatFn = (system: string, userText: string, maxTokens: number, onDelta?: (text: string) => void, onReasoning?: (text: string) => void, images?: readonly ImageBlock[], signal?: AbortSignal) => Promise<string>;
/** 一次「可带工具」的模型轮次输出（运行时层定义的公共契约）。 */
export type AskModelTurn = AnswerModelTurn;
/** 一次带历史消息与工具清单的模型调用。 */
export type RunChatTurnFn = AnswerRunTurnFn;
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
    /** 可选的固定取消信号（兼容旧的 6 参调用；普通调用也可逐次从第 7 参传入）。 */
    signal?: AbortSignal;
}): RunChatFn;
/**
 * 构造「多消息 + 工具」的模型轮次调用。
 *
 * 与 {@link createAskRunChat} 的分工：后者是旧问答的单轮纯文本调用；这里是工具循环
 * 的底层，必须把 assistant 的 `tool-call` 与 user-role 的 `tool-result` 原样交给
 * 适配器（OpenAI 兼容桥会投影成 `tool_calls` / `role:"tool"`），否则第二轮会失忆。
 * @param deps - LLM 服务、模型、取消检查与 usage 回调。
 * @returns 一次可带工具清单的模型调用。
 */
export declare function createAskRunChatTurn(deps: {
    llm: Context['llm'];
    provider: string;
    model: string;
    throwIfCanceled: () => void;
    onUsage?: (usage: TokenUsage) => void;
    signal?: AbortSignal;
}): RunChatTurnFn;
