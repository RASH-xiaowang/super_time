import { WechatDataGateway } from "./gateway.js";
export { WechatDataGateway } from "./gateway.js";
/**
 * Register the WeChat data gateway.
 * @param ctx - Cordis context.
 */
export function apply(ctx) {
    ctx.plugin(WechatDataGateway);
}
//# sourceMappingURL=index.js.map