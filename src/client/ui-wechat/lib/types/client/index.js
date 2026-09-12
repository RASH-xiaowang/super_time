import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useSyncExternalStore } from 'react';
import { setDirectoryPicker, setWechatRemote } from "./pages/wechat-data/api.js";
import { WechatDataPanel } from "./pages/wechat-data/WechatDataPanel.js";
import { getOpen, subscribeOpen, toggleWechat } from "./wechat-state.js";
export { WechatDataPanel } from "./pages/wechat-data/WechatDataPanel.js";
export { setWechatRemote } from "./pages/wechat-data/api.js";
export { closeWechat, openWechat, toggleWechat } from "./wechat-state.js";
/** Services required by the wechat panels. */
export const inject = ['remote', 'remote.wechatData', 'slots', 'uiWorkspace'];
/** Sidebar foot action that opens the WeChat dashboard. */
function WechatTrigger({ wide }) {
    const open = useSyncExternalStore(subscribeOpen, getOpen);
    return (_jsxs("button", { type: "button", onClick: toggleWechat, title: open ? '关闭私人微信' : '打开私人微信', "data-on": open || undefined, style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0, padding: '6px 10px', background: open ? 'rgba(0,240,255,0.08)' : 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }, children: [_jsx("span", { "aria-hidden": true, style: { fontSize: 16 }, children: '\uD83D\uDCAC' }), wide ? _jsx("span", { style: { fontSize: 12 }, children: open ? '关闭私人微信' : '私人微信' }) : null] }));
}
/** Center content-area page registered as the `conversation` slot occupant. */
function WechatContent() {
    const open = useSyncExternalStore(subscribeOpen, getOpen);
    if (!open)
        return null;
    return (_jsx("div", { style: { height: '100%', overflow: 'auto' }, children: _jsx(WechatDataPanel, {}) }));
}
/** Wire the remote gateway, realtime relay, and the dashboard surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    setWechatRemote(ctx.remote.wechatData);
    const workspaceUI = ctx.get('uiWorkspace');
    setDirectoryPicker(() => workspaceUI.pickDirectory());
    const stopRelay = ctx.remote.$on('wechat-data/updated', () => {
        window.dispatchEvent(new CustomEvent('dsh-wechat-data-updated'));
    });
    ctx.effect(() => stopRelay, 'ui-wechat: wechat-data updated relay');
    ctx.effect(() => {
        let disposeContent;
        const sync = () => {
            if (getOpen() && disposeContent === undefined) {
                disposeContent = ctx.slots.register({ name: 'conversation', priority: -10 }, WechatContent);
            }
            else if (!getOpen() && disposeContent !== undefined) {
                disposeContent();
                disposeContent = undefined;
            }
        };
        sync();
        const unsub = subscribeOpen(sync);
        return () => { unsub(); disposeContent?.(); };
    }, 'ui-wechat: content seat');
    ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'wechat-data', order: 0, locale: 'sidebar' }, WechatTrigger)), 'ui-wechat: trigger');
}
//# sourceMappingURL=index.js.map