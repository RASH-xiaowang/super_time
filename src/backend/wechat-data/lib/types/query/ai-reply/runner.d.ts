import type { ChatAiReplyScanDeps, ChatAiReplyScanResult } from './types.ts';
import type { ChatAiReplyRegenerateResult } from './runner-regenerate.ts';
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
    /**
     * 同一轮连发的合并静默期（毫秒）；0 关闭合并。
     * 生产默认 900ms：对方连发时等这一轮说完再生成，一条消息一次模型调用。
     */
    coalesceMs?: number;
    /** 测试可固定 owner；生产每个 runner 实例自动生成唯一值。 */
    owner?: string;
    /** 跨会话同时执行的会话数上限；默认 2，避免一轮扫描同时开太多付费调用。 */
    maxConcurrentSessions?: number;
    /** 超出并发上限后的排队上限；默认 8，0 表示本拍直接跳过。 */
    maxQueue?: number;
}
export declare function createChatAiReplyRunner(deps: ChatAiReplyScanDeps, runnerOptions?: ChatAiReplyRunnerOptions): {
    scan: () => Promise<ChatAiReplyScanResult>;
    recover: () => Promise<ChatAiReplyScanResult>;
    /** 桌面端显式重跑一条空白失败的记录；会再调用一次模型。 */
    regenerate: (recordId: number, expectedSourceRef: string) => Promise<ChatAiReplyRegenerateResult>;
    dispose: () => void;
    pending: () => number;
    snapshot: () => ChatAiReplyRunnerSnapshot;
};
