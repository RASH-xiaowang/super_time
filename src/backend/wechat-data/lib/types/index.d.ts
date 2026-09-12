/**
 * WeChat data backend plugin: registers the WechatDataGateway Remote service.
 */
import type { Context } from '@deepseek-ai/cordis';
export type * from './types.ts';
export { WechatDataGateway } from './gateway.ts';
/**
 * Register the WeChat data gateway.
 * @param ctx - Cordis context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map