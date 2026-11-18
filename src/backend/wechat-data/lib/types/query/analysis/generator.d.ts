import type { Context } from '@deepseek-ai/cordis';
import type { AnalysisGenerateFn } from './analyze.ts';
export interface AnalysisGeneratorDeps {
    /** 取宿主 `Context`；可能取不到（插件未挂载），调用方按「没有模型」处理。 */
    ctx: () => Context | undefined;
}
/**
 * 默认生成器：用设置里的当前对话模型。
 * @param deps - 取 `Context` 的函数（延迟求值，避免启动期读不到模型配置）。
 * @returns 可直接注入 `AnalysisDeps.generate` 的函数。
 */
export declare function createDefaultAnalysisGenerator(deps: AnalysisGeneratorDeps): AnalysisGenerateFn;
