/**
 * 问答「停止生成」的一整块（W3-6.1）：令牌、阶段检查、槽位归还、以及 `cancelAsk` 的实现。
 *
 * 为什么独立成文件：`remotes/askdeep.ts` 的 `createAskDeepRemotes` 受函数体棘轮管着
 * （`function-size-ratchet.spec.ts` 登记 607 行，**一行都不许多**），而取消这件事与
 * 「怎么生成回答」无关。抽走之后两边都短，且取消语义可以单独测（`ask-cancel.spec.ts`）。
 *
 * 三条设计约束：
 *   ① 槽位由 gateway 持有（`askSignal` / `cancelAskJob`），本模块只消费 ——
 *      「谁持有令牌」不允许出现第二个出处；
 *   ② 取消错误带 `code:'ASK_CANCELED'`：面板要据此把一次正常的停止显示成「已停止」，
 *      而不是红色错误（`unwrap` 会把 code 一起抛出来，见 `api-core.ts`）；
 *   ③ `run` 用 try/finally 包住主体：成功、抛错、被取消三条路都归还槽位 ——
 *      少了这一步，同一个轮次 id 会被永久占着，之后同 id 的取消会打到一枚没人等的控制器上。
 */
/** 本模块需要的两个把手（由 gateway 的 `_askJobs` 槽提供）。 */
export interface AskCancelHost {
    askSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    cancelAskJob: (jobId?: string) => boolean;
}
/** 一轮问答的取消控制面。 */
export interface AskCancelCtl {
    /** 本轮的取消信号；没有 jobId（旧客户端）时为 undefined = 不可取消。 */
    signal: AbortSignal | undefined;
    /** 阶段边界与流式循环里的取消检查。 */
    throwIfCanceled: () => void;
    /** 跑问答主体，并保证槽位归还。 */
    run<T>(body: () => Promise<T>): Promise<T>;
}
/**
 * 开始一轮可取消的问答。
 * @param rc - 持有槽位的宿主（gateway）。
 * @param jobId - 渲染层传进来的轮次标识（就是那轮的 streamId）。
 */
export declare function beginAskCancel(rc: AskCancelHost, jobId?: string): AskCancelCtl;
/**
 * `cancelAsk` Remote 的实现。
 *
 * 找不到在跑的那一轮时返回 `{ ok:false, message }` 而不是静默 true —— 用户点「停止生成」后
 * 必须知道取消有没有命中；命中不了的常见原因是那一轮已经结束了（点晚了），说清楚比假装成功好。
 * @param rc - 持有槽位的宿主。
 * @param options - jobId（必填）。
 */
export declare function cancelAskIn(rc: AskCancelHost, options: {
    jobId: string;
}): {
    ok: boolean;
    message?: string;
};
