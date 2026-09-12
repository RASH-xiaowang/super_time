/**
 * Super Time —— 微信+前端入口
 *
 * 将迁移自 @deepseek-ai/dsh-client-ui-wechat 的 WechatDataPanel 直接挂载到
 * Electron 渲染进程；Remote 通过 preload 暴露的 window.electronAPI.wechat
 * 转发到主进程后端（wechat:call）。
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './titlebar.css'
import { setDirectoryPicker, setWechatRemote } from '../ui-wechat/src/client/pages/wechat-data/api.ts'
import { WechatDataPanel } from '../ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx'
import { getOpen, openWechat, subscribeOpen } from '../ui-wechat/src/client/wechat-state.ts'

/** 前端 Remote：一个 Proxy，把 api.ts 中的每个方法调用转成 Electron IPC。 */
const remoteProxy = new Proxy({} as Record<string, (...args: unknown[]) => unknown>, {
  get(_target, prop) {
    if (prop === '$on') return () => () => undefined
    const name = String(prop)
    return (...args: unknown[]) => (window as any).electronAPI.wechat.call(name, args)
  },
})
setWechatRemote(remoteProxy as any)

/** 目录选择器：走主进程原生对话框。 */
setDirectoryPicker(async () => {
  const r = await (window as any).electronAPI.pickDirectory()
  return r?.path ?? null
})

/** 将后端实时更新事件转发为 api.ts / 面板监听的 DOM 事件。
 *  · wechat-data/updated —— 解密数据有更新（原有）
 *  · wechat-ask/delta     —— 微信问答的**流式回答增量**：payload 是 { id, text }，
 *    text 是「已生成的全文」（不是片段），渲染端整体替换即可。 */
;(window as any).electronAPI.wechat.onEvent((ev: { name: string; args?: unknown[] }) => {
  if (ev.name === 'wechat-data/updated') {
    window.dispatchEvent(new CustomEvent('dsh-wechat-data-updated'))
  } else if (ev.name === 'wechat-ask/delta') {
    window.dispatchEvent(new CustomEvent('dsh-wechat-ask-delta', { detail: ev.args?.[0] ?? null }))
  }
})

/** 自绘标题栏：拖拽区域 + 最小化/关闭（固定窗口尺寸）。 */
function initTitlebar(): void {
  const api = (window as any).electronAPI?.windowControls
  if (!api) return
  const byId = (id: string) => document.getElementById(id)
  byId('tb-min')?.addEventListener('click', () => api.minimize())
  byId('tb-close')?.addEventListener('click', () => api.close())
}
initTitlebar()

function WechatApp(): React.JSX.Element {
  const [open, setOpen] = useState(getOpen())
  useEffect(() => subscribeOpen(() => setOpen(getOpen())), [])
  useEffect(() => {
    if (!getOpen()) openWechat()
  }, [])
  if (!open) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#050a18', color: '#e2e8f0', fontFamily: 'sans-serif' }}>
        <div style={{ fontSize: 40 }}>💬</div>
        <div>微信+已关闭</div>
        <button type="button" onClick={openWechat}
          style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(0,240,255,.35)', background: 'rgba(0,240,255,.08)', color: '#00f0ff', cursor: 'pointer' }}>
          打开微信+
        </button>
      </div>
    )
  }
  return <WechatDataPanel />
}

createRoot(document.getElementById('root')!).render(<WechatApp />)
