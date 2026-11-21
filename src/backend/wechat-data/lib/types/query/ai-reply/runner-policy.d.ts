/**
 * 把 AI 队友的发送闸接进回复运行器。
 *
 * 运行器本身仍然负责预约、生成和投递。这里只回答两件事：这一拍要不要先别
 * 调用模型，以及生成完成后要不要改成草稿。测试不注入闸门时，两条都是空操作。
 *
 * @module query/ai-reply/runner-policy
 */
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
import type { ChatAiReplyRunRef } from './runner-state.ts';
export declare function resetReplyPolicyLog(): void;
/**
 * 生成前拦截。返回 true 表示这一拍到此结束，水位不动，下一拍再看。
 */
export declare function deferReplyIfBlocked(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, now?: number): boolean;
/**
 * 生成后、出网前。`held` 表示已经收成草稿并推进水位；`blocked` 表示本不该发、
 * 但草稿没写上，调用方不得改走投递。
 */
export declare function holdReplyIfRequired(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<'send' | 'held' | 'blocked'>;
/** 出网前问草稿闸。允许发送时才调用传入的投递函数，并记下额度。 */
export declare function deliverChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean, dispatch: (deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean) => Promise<boolean>): Promise<boolean>;
