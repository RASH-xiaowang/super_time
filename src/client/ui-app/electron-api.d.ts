/**
 * 打包入口这一层自己的全局桥声明。
 *
 * `electron-api.ts` 住在 `ui-wechat` 包内，而 `ui-app` 有独立的 typecheck program；
 * 跨包 `import type` 不会把它模块里的 `declare global` 带进本项目的全局作用域，
 * 因此在这里只转发同一个 `ElectronApi` 类型，不再复制桥面字段。
 */
import type { ElectronApi } from '@deepseek-ai/dsh-client-ui-wechat/host'

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
