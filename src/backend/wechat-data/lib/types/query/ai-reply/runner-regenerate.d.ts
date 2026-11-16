import type { ChatAiReplyScanDeps } from './types.ts';
export interface ChatAiReplyRegenerateOptions {
    owner: string;
    now: () => number;
    leaseMs: number;
    /** 租约续期间隔；0 关闭（测试/无后台运行时）。 */
    heartbeatMs: number;
    /** dispose 后不再开始新的模型调用；已经开始的一轮按正常取消路径收口。 */
    isCancelled: () => boolean;
}
export interface ChatAiReplyRegenerateResult {
    ok: boolean;
    error?: string;
}
/**
 * 执行一次桌面端重新生成。
 *
 * 调用方必须已经确认这是用户明确点击的动作；本函数自身仍会完整复核所有守卫，
 * 不信任前端传入的 recordId/sourceRef。
 */
export declare function regenerateChatAiReplyRecord(deps: ChatAiReplyScanDeps, options: ChatAiReplyRegenerateOptions, recordId: number, expectedSourceRef: string): Promise<ChatAiReplyRegenerateResult>;
