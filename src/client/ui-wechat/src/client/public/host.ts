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
