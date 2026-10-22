/**
 * 工具循环的截止、取消与重试运行时。
 *
 * 这些能力独立于具体工具：模型轮次需要硬截止，单次工具调用需要可取消的
 * deadline，重试退避必须能被「停止生成」立即唤醒。
 *
 * @module query/answer-runtime/tool-runtime
 */
import type { ToolLoopInput } from './types.ts';
/** 给任意 promise 套一个 deadline；超时后执行旁路取消回调。 */
export declare function withDeadline<T>(work: Promise<T>, deadlineMs: number, onTimeout?: () => void): Promise<{
    timedOut: false;
    value: T;
} | {
    timedOut: true;
}>;
/**
 * 单次模型轮次的硬截止。
 *
 * 不能只 `Promise.race`：超时后底层流式请求必须收到 abort，否则它会继续占用
 * 供应商额度，晚到的块还可能被下一轮误当作新输出。这里同时监听外部取消，
 * 并在 finally 里清理计时器与监听器。
 */
export declare function runTurnWithDeadline(input: {
    loop: ToolLoopInput;
    deadlineMs: number;
    buildTurnInput: (signal?: AbortSignal) => Parameters<ToolLoopInput['runTurn']>[0];
}): Promise<Awaited<ReturnType<ToolLoopInput['runTurn']>>>;
/** 截止/取消后，底层即使继续吐增量也不能再推给界面。 */
export declare function gateLateDelta<T>(emit: (value: T) => void, signal?: AbortSignal): (value: T) => void;
/** 把分类器给出的尝试次数收口到 1..4。 */
export declare function detailAttempts(value: number): number;
/** 指数退避，同时尊重服务端的 Retry-After，但有上限。 */
export declare function retryDelayMs(retryAfterMs: number | undefined, attempts: number): number;
/**
 * 退避等待必须可被取消唤醒。
 *
 * 只靠 sleep 结束后再查 flag 会让「停止生成」最多等满一次退避（限流场景可达
 * 5 秒），用户感知为点了没反应。这里用取消信号与 sleep 竞速；即使注入的 sleep
 * 不监听 signal，也会在 abort 时立即退出。
 */
export declare function sleepBeforeRetry(loop: ToolLoopInput, ms: number): Promise<void>;
