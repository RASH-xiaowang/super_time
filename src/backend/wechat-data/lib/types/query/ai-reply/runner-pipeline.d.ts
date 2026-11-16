import type { ChatAiReplyLease } from './lease-store.ts';
import type { ChatAiReplyAnchor, ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
import { type ChatAiReplyRunRef } from './runner-state.ts';
/**
 * 收口已被会话新消息越过的旧任务。
 *
 * 这里绝不生成或投递：从未生成过正文的预约直接删除（这不是失败，不留失败记录），
 * 其余仍为 pending 的旧预约（含分段）标记失败，防止别的投递入口把旧问题再次发出去；
 * 已成功/已受理的段保留事实并直接收口。
 */
export declare function cancelStaleChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<boolean>;
export declare function beginChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, anchor: ChatAiReplyAnchor, resumed: boolean, lease: ChatAiReplyLease, expectedRevision: number, options: {
    leaseMs: number;
    now: () => number;
    stale?: boolean;
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
