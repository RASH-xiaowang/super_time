/**
 * Module-level open state for the 私人微信 dashboard, shared by the sidebar
 * footer trigger (open/toggle) and the panel content seat (open/close). The
 * panel itself also imports {@link closeWechat} to render its own close action.
 */
let _open = false;
const _listeners = new Set();
function setOpen(value) {
    const next = value;
    if (next === _open)
        return;
    _open = next;
    for (const listener of _listeners)
        listener();
}
export function subscribeOpen(listener) {
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
}
export function getOpen() { return _open; }
export function openWechat() { setOpen(true); }
export function closeWechat() { setOpen(false); }
export function toggleWechat() { setOpen(!_open); }
//# sourceMappingURL=wechat-state.js.map