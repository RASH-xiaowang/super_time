/**
 * Host-facing public entry for the WeChat data shell.
 *
 * `ui-app` is the only allowed consumer of these names. Keep this surface small:
 * every export here becomes an API that the Electron/browser host depends on.
 */
import '../pages/wechat-data/scifi-theme.css'
import '../pages/wechat-data/light-theme.css'

export { setCapabilities, setDirectoryPicker, setWechatRemote } from '../pages/wechat-data/api.ts'
export type { WechatRemote } from '../pages/wechat-data/api.ts'
export { WechatDataPanel } from '../pages/wechat-data/WechatDataPanel.tsx'
export { getOpen, openWechat, subscribeOpen } from '../wechat-state.ts'
export type { ElectronApi } from '../electron-api.ts'
export type { BackendEvent, LicenseStatus, RemoteEnvelope } from '../contracts.ts'
/*
 * 主题（2026-10-17）：宿主标题栏要放主题切换按钮，而按钮在**静态 HTML** 里
 * （`index.html` 的 `#titlebar`），不在 React 树里 —— 所以宿主需要直接调这两个函数。
 * 只导出「读 + 切 + 订阅」三件，不导出 `setThemeMode`（宿主不该指定具体主题）。
 */
export { getThemeMode, subscribeThemeMode, toggleThemeMode } from '../pages/wechat-data/theme.ts'
export type { ThemeMode } from '../pages/wechat-data/theme.ts'
/*
 * 标题栏状态区（2026-10-17）：宿主标题栏要放「模型余额」与「数据就绪」，
 * 而这两块在**静态 HTML** 里（`index.html` 的 `#tb-status`），不在主 React 树里 ——
 * 所以宿主需要自己挂一个独立 root，并拿到组件与状态订阅。
 * 只导出「组件 + 读 + 订阅」，不导出 `setApiStatus`（宿主不该伪造数据状态）。
 */
export { SidebarBalance } from '../pages/wechat-data/panels/SidebarBalance.tsx'
export { getApiStatus, subscribeApiStatus } from '../pages/wechat-data/api-status.ts'
export type { ApiStatus } from '../pages/wechat-data/api-status.ts'
