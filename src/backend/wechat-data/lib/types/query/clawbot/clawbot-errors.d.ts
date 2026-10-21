/**
 * ClawBot 数据层的会话竞态错误。
 *
 * 旧会话的异步结果可能在新绑定、解绑或跨实例接管之后才返回。调用方必须能明确
 * 区分「会话已经换了」与普通数据库错误：前者是终态，不应无限重试同一批旧数据。
 *
 * @module query/clawbot/clawbot-errors
 */
/** 带代次快照的写入发现绑定会话已经变化。 */
export declare class ClawbotSessionChangedError extends Error {
    readonly slot: number;
    readonly expected: number;
    readonly actual: number;
    constructor(slot: number, expected: number, actual: number);
}
/** 判断错误是否为会话代次失配（调用方据此停止重试当前旧批次）。 */
export declare function isClawbotSessionChangedError(error: unknown): error is ClawbotSessionChangedError;
