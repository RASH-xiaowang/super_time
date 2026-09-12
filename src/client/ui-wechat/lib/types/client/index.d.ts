/**
 * 私人微信 browser plugin: wires the wechatData Remote gateway into the
 * panel access layer, relays the host realtime sync signal as a DOM event,
 * and adds a sidebar footer action. Opening it registers the WeChat data
 * dashboard as the center content-area occupant (the `conversation` slot),
 * so the left sidebar stays visible; closing restores the normal session
 * conversation.
 * @module @deepseek-ai/dsh-client-ui-wechat
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export { WechatDataPanel } from './pages/wechat-data/WechatDataPanel.tsx';
export { setWechatRemote } from './pages/wechat-data/api.ts';
export { closeWechat, openWechat, toggleWechat } from './wechat-state.ts';
/** Services required by the wechat panels. */
export declare const inject: string[];
/** Wire the remote gateway, realtime relay, and the dashboard surfaces.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map