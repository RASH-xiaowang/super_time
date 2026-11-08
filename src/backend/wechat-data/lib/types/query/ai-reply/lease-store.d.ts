import type { ChatAiReplyState } from './types.ts';
export declare const CHAT_AI_REPLY_LEASE_MS = 60000;
export interface ChatAiReplyLease {
    owner: string;
    fence: number;
    until: number;
}
export interface ClaimChatAiReplyRunInput {
    owner: string;
    /** 扫描时看到的快照；任一控制字段变化都放弃本次 claim。 */
    expected: Pick<ChatAiReplyState, 'enabled' | 'revision' | 'stage' | 'cursor' | 'pendingCursor' | 'pendingSourceRef' | 'recordId'>;
    now?: number;
    leaseMs?: number;
}
/**
 * 原子抢占一个会话的执行权。
 *
 * expected 必须与扫描时看到的控制面完全一致；这比只比较 revision 更强，
 * 可以阻止另一个 runner 完成上一拍后，延迟 scan 拿旧 anchor 再执行一次。
 */
export declare function claimChatAiReplyRun(decryptedDir: string, accountKey: string, chatUsername: string, input: ClaimChatAiReplyRunInput): ChatAiReplyLease | null;
/** 心跳续租；owner/fence 或 revision 已变化时返回 null。 */
export declare function renewChatAiReplyRunClaim(decryptedDir: string, accountKey: string, chatUsername: string, revision: number, lease: ChatAiReplyLease, options?: {
    now?: number;
    leaseMs?: number;
}): ChatAiReplyLease | null;
/** 主动释放；只清 until/owner，保留 fence 以维持单调性。 */
export declare function releaseChatAiReplyRunClaim(decryptedDir: string, accountKey: string, chatUsername: string, revision: number, lease: ChatAiReplyLease): boolean;
