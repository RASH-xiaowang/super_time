import type { ChatAiReplyScanDeps, ChatAiReplyScanResult } from './types.ts';
/** Runtime snapshot for diagnostics/tests; cursor intentionally excluded from display. */
export interface ChatAiReplyRunnerSnapshot {
    executing: number;
}
export interface ChatAiReplyRunnerOptions {
    /** 测试可注入假时钟；生产默认 Date.now。 */
    now?: () => number;
    leaseMs?: number;
    /** 0 表示禁用心跳，仅用于确定性的租约接管测试。 */
    heartbeatMs?: number;
    /** 测试可固定 owner；生产每个 runner 实例自动生成唯一值。 */
    owner?: string;
}
export declare function createChatAiReplyRunner(deps: ChatAiReplyScanDeps, runnerOptions?: ChatAiReplyRunnerOptions): {
    scan: () => Promise<ChatAiReplyScanResult>;
    recover: () => Promise<ChatAiReplyScanResult>;
    dispose: () => void;
    pending: () => number;
    snapshot: () => ChatAiReplyRunnerSnapshot;
};
