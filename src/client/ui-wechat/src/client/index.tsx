/**
 * 微信+ browser plugin: wires the wechatData Remote gateway into the
 * panel access layer, relays the host realtime sync signal as a DOM event,
 * and adds a sidebar footer action. Opening it registers the WeChat data
 * dashboard as the center content-area occupant (the `conversation` slot),
 * so the left sidebar stays visible; closing restores the normal session
 * conversation.
 * @module @deepseek-ai/dsh-client-ui-wechat
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { setDirectoryPicker, setWechatRemote } from './pages/wechat-data/api.ts'
import { WechatDataPanel } from './pages/wechat-data/WechatDataPanel.tsx'
import { getOpen, subscribeOpen, toggleWechat } from './wechat-state.ts'
import shellCss from './wechat-shell.module.css'

export { WechatDataPanel } from './pages/wechat-data/WechatDataPanel.tsx'
export { setWechatRemote } from './pages/wechat-data/api.ts'
export { closeWechat, openWechat, toggleWechat } from './wechat-state.ts'

/** Services required by the wechat panels. */
export const inject = ['remote', 'remote.wechatData', 'slots', 'uiWorkspace']


/** Sidebar foot action that opens the WeChat dashboard. */
function WechatTrigger({ wide }: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'sidebar'>) {
  const open = useSyncExternalStore(subscribeOpen, getOpen)
  return (
    <button
      type="button"
      onClick={toggleWechat}
      title={open ? '关闭微信+' : '打开微信+'}
      data-on={open || undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0, padding: '6px 10px', background: open ? 'rgba(0,240,255,0.08)' : 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }}
    >
      <span aria-hidden className={shellCss.triggerIcon}>{'\uD83D\uDCAC'}</span>
      {wide ? <span className={shellCss.triggerLabel}>{open ? '关闭微信+' : '微信+'}</span> : null}
    </button>
  )
}

/** Center content-area page registered as the `conversation` slot occupant. */
function WechatContent() {
  const open = useSyncExternalStore(subscribeOpen, getOpen)
  if (!open) return null
  return (
    <div className={shellCss.contentWrap}>
      <WechatDataPanel />
    </div>
  )
}

/** Wire the remote gateway, realtime relay, and the dashboard surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  setWechatRemote(ctx.remote.wechatData)
  const workspaceUI = ctx.get('uiWorkspace') as unknown as { pickDirectory(): Promise<string | null> }
  setDirectoryPicker(() => workspaceUI.pickDirectory())
  const stopRelay = ctx.remote.$on('wechat-data/updated', () => {
    window.dispatchEvent(new CustomEvent('dsh-wechat-data-updated'))
  })
  ctx.effect(() => stopRelay, 'ui-wechat: wechat-data updated relay')
  ctx.effect(() => {
    let disposeContent: (() => void) | undefined
    const sync = (): void => {
      if (getOpen() && disposeContent === undefined) {
        disposeContent = ctx.slots.register({ name: 'conversation', priority: -10 }, WechatContent)
      } else if (!getOpen() && disposeContent !== undefined) {
        disposeContent()
        disposeContent = undefined
      }
    }
    sync()
    const unsub = subscribeOpen(sync)
    return () => { unsub(); disposeContent?.() }
  }, 'ui-wechat: content seat')
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'wechat-data', order: 0, locale: 'sidebar' }, WechatTrigger),
  ), 'ui-wechat: trigger')
}
