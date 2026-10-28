import type { RpaRetrySpec } from '../../types-rpa.ts';
import type { RpaBuildDeps, RpaDispatchDeps, RpaDispatchOutcome, RpaHttpRequest, RpaHttpResponse, RpaInvocationContext, RpaVendorAdapter } from './types.ts';
/** 可注入 `fetchImpl` 的传输依赖。 */
export type RpaTransportDeps = RpaDispatchDeps;
/**
 * 本域唯一出网函数：读响应体文本后交给解析层（业务成功与否由描述符判定）。
 *
 * **`fetchWithRetry` 全仓只允许出现在这里**（出网台账按 `dispatch.ts#sendRequest` 登记）。
 * @param req - 已鉴权请求。
 * @param deps - 传输依赖（测试注入 fetch）。
 * @param retry - 描述符的重试策略。
 * @returns 状态码 + 响应文本。
 */
export declare function sendRequest(req: RpaHttpRequest, deps: RpaTransportDeps, retry: RpaRetrySpec): Promise<RpaHttpResponse>;
/**
 * 派发一条触发记录到某个厂商。
 * @param input.adapter - 厂商适配器。
 * @param input.ctx - 投递上下文（text 已过隐私闸）。
 * @param input.deps - 传输依赖（生产 = 全局 fetch）。
 * @param input.buildDeps - 厂商构建钩子的解码依赖（仅 Webhook 用）。
 * @returns `sent`（含外部任务 id）/ `failed`（可读原因）。
 */
export declare function dispatchRpaRecord(input: {
    adapter: RpaVendorAdapter;
    ctx: RpaInvocationContext;
    deps: RpaDispatchDeps;
    buildDeps: RpaBuildDeps;
}): Promise<RpaDispatchOutcome>;
