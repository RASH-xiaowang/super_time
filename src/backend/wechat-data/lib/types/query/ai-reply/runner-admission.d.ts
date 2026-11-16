/**
 * AI 回复的跨会话生成准入。
 *
 * 每个会话单飞只能约束同一会话；若同时开启的会话很多，扫描会一次性把所有
 * 会话都推进到模型生成，瞬时并发和费用都不可控。这里用一个小信号量把
 * 「同时占着会话执行权」的数量限制住，超出的会话排队；队列也满时本拍直接
 * 放弃（不领租约、不建记录、不推水位），下一拍再试。
 */
export declare const CHAT_AI_REPLY_MAX_CONCURRENT_SESSIONS = 2;
export declare const CHAT_AI_REPLY_MAX_QUEUE = 8;
export interface ChatAiReplyAdmissionLimiter {
    /**
     * 申请一个执行槽位。
     * @param isDisposed - 运行器是否已停止；停止时立即返回 false。
     * @returns true 表示拿到槽位，调用方必须配对 release；false 表示本拍跳过。
     */
    acquire: (isDisposed: () => boolean) => Promise<boolean>;
    /** 释放一个执行槽位，并唤醒队首等待者。 */
    release: () => void;
    /**
     * 唤醒全部等待者。
     * @param granted - false 表示运行器已停止，等待者不应再执行。
     */
    wakeAll: (granted: boolean) => void;
    /** 当前排队数量（诊断/测试用）。 */
    waiting: () => number;
}
export declare function createAdmissionLimiter(options?: {
    maxConcurrent?: number;
    maxQueue?: number;
}): ChatAiReplyAdmissionLimiter;
