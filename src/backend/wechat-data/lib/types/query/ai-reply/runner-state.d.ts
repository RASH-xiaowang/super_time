/**
 * AI 回复执行期间的租约与状态机持久化。
 *
 * 所有状态写入都通过 revision + lease fence；本模块不生成文本、不投递，
 * 只负责把当前执行安全地推进到下一阶段或保留可恢复锚点。
 */
import { updateChatAiReplyRunStateResult } from './config-store.ts';
import type { ChatAiReplyLease } from './lease-store.ts';
import type { ChatAiReplyAnchor, ChatAiReplyRecordSnapshot, ChatAiReplyScanDeps, ChatAiReplyStage, ChatAiReplyState } from './types.ts';
export declare class ChatAiReplyLeaseLostError extends Error {
}
export declare class ChatAiReplyTransientWriteError extends Error {
}
export interface ChatAiReplyRunRef {
    revision: number;
    anchor: ChatAiReplyAnchor;
    sourceRef: string;
    lease?: ChatAiReplyLease;
    leaseMs: number;
    now: () => number;
    leaseLost: boolean;
    /** 从持久化 generation 快照恢复出的正文；有值时绝不再调用模型。 */
    generatedText?: string;
    recordId?: number;
    /** 只有 reserveReply 明确返回成功后才允许把 anchor 视为已落库。 */
    reservationMade: boolean;
    recordOpen: boolean;
    resumed: boolean;
    /** pending 创建后设置 revision 已被推进；只收口旧预约，不再生成/投递。 */
    revisionChanged: boolean;
    /**
     * 运行期取消信号；只读传递，不落库。
     * 生成器在流式调用期间收到 abort 后应尽快停止并交回部分结果。
     */
    signal?: AbortSignal;
}
export declare function readCurrentChatAiReplyState(deps: ChatAiReplyScanDeps, state: ChatAiReplyState): import("./config-store.ts").ChatAiReplyStateReadResult;
export declare function notifyChatAiReplyRecordUpdated(deps: ChatAiReplyScanDeps, state: Pick<ChatAiReplyState, 'accountKey' | 'chatUsername'>, recordId: number | undefined): void;
export declare function requireLiveLease(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<ChatAiReplyLease>;
export declare function guardedUpdate(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, patch: Parameters<typeof updateChatAiReplyRunStateResult>[3], releaseLease?: boolean): Promise<'updated' | 'guard-mismatch' | 'transient'>;
export declare function requireGuardedUpdate(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, patch: Parameters<typeof updateChatAiReplyRunStateResult>[3], releaseLease?: boolean): Promise<void>;
export declare function settleChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, stage: Extract<ChatAiReplyStage, 'success' | 'failed'>, error: string, opDetail: string): Promise<boolean>;
export declare function deferChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, error: string, opDetail: string, options?: {
    stage?: Extract<ChatAiReplyStage, 'failed' | 'waiting_config' | 'dispatching'>;
}): Promise<boolean>;
export declare function waitForChatAiReplyConfig(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, error: string, opDetail: string): Promise<boolean>;
export declare function failChatAiReplyReservation(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, error: string): Promise<ChatAiReplyRecordSnapshot>;
export declare function settleFromRecord(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, record: ChatAiReplyRecordSnapshot, fallbackError: string): Promise<boolean>;
