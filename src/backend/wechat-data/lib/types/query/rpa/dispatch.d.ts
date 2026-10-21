import type { RpaBuildDeps, RpaDispatchDeps, RpaDispatchOutcome, RpaInvocationContext, RpaVendorAdapter } from './types.ts';
/** 可注入 `fetchImpl` 的传输依赖。 */
export type RpaTransportDeps = RpaDispatchDeps;
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
