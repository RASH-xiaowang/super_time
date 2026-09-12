/**
 * Module-level open state for the 微信+ dashboard, shared by the sidebar
 * footer trigger (open/toggle) and the panel content seat (open/close). The
 * panel itself also imports {@link closeWechat} to render its own close action.
 */

let _open = false
const _listeners = new Set<() => void>()
function setOpen(value: boolean): void {
  const next = value
  if (next === _open) return
  _open = next
  for (const listener of _listeners) listener()
}
export function subscribeOpen(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}
export function getOpen(): boolean { return _open }
export function openWechat(): void { setOpen(true) }
export function closeWechat(): void { setOpen(false) }
export function toggleWechat(): void { setOpen(!_open) }
