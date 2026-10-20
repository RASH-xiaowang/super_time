/**
 * 标题栏右上角的状态区（2026-10-17 从主面板左下角迁来）。
 *
 * ## 为什么单独一个 React root
 *
 * 标题栏是**静态 HTML**（`index.html` 的 `#titlebar`），不在主 React 树里 ——
 * 而「模型余额」要轮询、「数据就绪」要订阅状态，两者都是 React 组件。
 * 所以这里给 `#tb-status` 挂一个**独立的 React root**，与主树互不干扰
 * （主树在 `#root`，会随导航/弹窗重渲染；标题栏状态不该跟着重渲染）。
 *
 * ## 迁移动机
 *
 * 这两块与主题切换、窗口控制同属「全局动作」—— 它们描述的是**整个应用**的状态
 * （模型能不能用、数据读不读得到），而不是当前页签的内容。放右上角与窗口控制
 * 排在一起，比压在侧栏底部更符合直觉（侧栏是「导航」，不是「状态栏」）。
 */
import { createRoot } from 'react-dom/client'
import { SidebarBalance } from '@deepseek-ai/dsh-client-ui-wechat/host'
import { getApiStatus, subscribeApiStatus, type ApiStatus } from '@deepseek-ai/dsh-client-ui-wechat/host'
import { useState, useSyncExternalStore } from 'react'
import './titlebar-status.css'

/** 数据状态文案（与侧栏口径一致）。 */
function statusText(s: ApiStatus): string {
  return s === 'online' ? '数据就绪' : s === 'offline' ? '数据不可用' : '检测中…'
}

/**
 * 标题栏状态区：模型余额 + 数据就绪。
 * @returns 状态区元素。
 */
function TitlebarStatus(): React.JSX.Element {
  const apiStatus = useSyncExternalStore(subscribeApiStatus, getApiStatus)
  const [opening, setOpening] = useState(false)
  const [handoffError, setHandoffError] = useState('')

  /**
   * 打开默认浏览器并把操作权交出去。
   *
   * 失败时主窗口仍在（主进程保证「开不了浏览器就不隐藏」），这里只把原因放进
   * 按钮 title —— 标题栏没有空间再摆一条错误文案，而失败原因通常是端口/网络一句话。
   */
  const openWeb = async (): Promise<void> => {
    if (opening) return
    const bridge = window.electronAPI?.webHandoff
    if (!bridge) return
    setOpening(true)
    setHandoffError('')
    try {
      const r = await bridge.open()
      if (!r.ok) setHandoffError(r.error ?? '打开浏览器失败')
    } catch (e) {
      setHandoffError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(false)
    }
  }

  const webTitle = handoffError !== ''
    ? handoffError
    : '在默认浏览器中打开（桌面端缩为右下角卡片，可拖拽）'

  return (
    <div className="tb-status">
      <button
        type="button"
        className="tb-webBtn"
        data-error={handoffError !== '' ? 'true' : undefined}
        disabled={opening}
        title={webTitle}
        aria-label="在默认浏览器中打开"
        onClick={() => { void openWeb() }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="12" cy="12" r="8.2" />
          <path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.4 5.1 3.4 8.2s-1.2 5.9-3.4 8.2c-2.2-2.3-3.4-5.1-3.4-8.2S9.8 6.1 12 3.8Z" />
        </svg>
        <span>{opening ? '打开中…' : '打开网页'}</span>
      </button>
      {/* 模型余额：未配置模型时组件自己返回 null（不留空位）。 */}
      <SidebarBalance collapsed={false} variant="titlebar" />
      <span className="tb-apiTag" data-status={apiStatus} title="本地解密数据的可读状态">
        <span className="tb-statusDot" aria-hidden="true" />
        <span className="tb-apiTagText">{statusText(apiStatus)}</span>
      </span>
    </div>
  )
}

/**
 * 把状态区挂到标题栏的 `#tb-status` 容器上。
 *
 * 容器不存在时静默返回（浏览器里标题栏整个被摘掉，见 `ui-entry.tsx` 的 `installRemote`）。
 */
export function mountTitlebarStatus(): void {
  const host = document.getElementById('tb-status')
  if (!host) return
  createRoot(host).render(<TitlebarStatus />)
}
