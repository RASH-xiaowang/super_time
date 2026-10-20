/**
 * `src/backend/browser-handoff.js` 的类型声明（仅测试与主进程 require 时可见）。
 *
 * 这里不追求覆盖 Electron 的完整 BrowserWindow 面：调用方只需要知道
 * `open / restore / state / dispose` 四个方法，以及卡片尺寸常量（测试用来断言位置）。
 */
export const CARD_WIDTH: number
export const CARD_HEIGHT: number
export const CARD_MARGIN: number

/** 交接控制面。 */
export interface BrowserHandoff {
  /** 打开默认浏览器并隐藏桌面；失败时桌面保持可见。 */
  open(): Promise<{ ok: boolean, error?: string }>
  /** 返回桌面：停服务（浏览器会话作废）→ 关闭卡片 → 显示主窗口。 */
  restore(): Promise<{ ok: boolean }>
  /** 当前是否处于交接态。 */
  state(): { active: boolean }
  /** 退出前收尾（只关卡片；HTTP 服务由 main.js 停）。 */
  dispose(): void
}

/**
 * 生成右下角卡片页面。
 * @param dark - 是否深色主题。
 * @returns data URL 页面 HTML。
 */
export function cardHtml(dark: boolean): string

/** 远程服务句柄里本模块实际用到的那几个方法（允许额外字段）。 */
export interface RemoteAccessLike {
  getState(): any
  issuePairingCode(): string
  syncWithConfig(): Promise<any>
  stop(): Promise<unknown>
}

/**
 * 创建交接控制面。
 * @param deps - 主进程注入（窗口、屏幕、远程服务、打开浏览器）。
 * @returns 控制面。
 */
export function createBrowserHandoff(deps: {
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => void, on: (channel: string, handler: (...args: any[]) => void) => void }
  ipcTrust: { wrap: (channel: string, handler: (...args: any[]) => any) => (...args: any[]) => any }
  BrowserWindow: Function
  screen: { getPrimaryDisplay: () => { workArea: { x: number, y: number, width: number, height: number } } }
  nativeTheme: { shouldUseDarkColors: boolean }
  rootDir: string
  remoteAccess: RemoteAccessLike
  backendCall: (method: string, args: unknown[]) => Promise<unknown>
  openExternal: (url: string) => Promise<void>
  getMainWindow: () => unknown
}): BrowserHandoff
