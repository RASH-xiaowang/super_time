import type { ChatAiReplyLease } from './lease-store.ts';
import type { ChatAiReplyAnchor, ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
import { type ChatAiReplyRunRef } from './runner-state.ts';
export declare function beginChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, anchor: ChatAiReplyAnchor, resumed: boolean, lease: ChatAiReplyLease, expectedRevision: number, options: {
    leaseMs: number;
    now: () => number;
}): Promise<ChatAiReplyRunRef | null>;
/**
 * 设置 revision 已推进时，旧 pending 只能收口，不能沿用新配置继续生成或投递。
 * 若状态里丢了 recordId，先用 sourceRef 做一次幂等查找再标记失败。
 */
export declare function cancelSupersededChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<boolean>;
export declare function reserveChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<'generate' | 'dispatch' | 'done'>;
export declare function dispatchChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean): Promise<boolean>;
export declare function saveAndDispatchChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean): Promise<boolean>;
export declare function failChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, error: string): Promise<boolean>;
