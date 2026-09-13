/**
 * Super Time —— 微信+前端入口
 *
 * 将迁移自 @deepseek-ai/dsh-client-ui-wechat 的 WechatDataPanel 直接挂载到
 * Electron 渲染进程；Remote 通过 preload 暴露的 window.electronAPI.wechat
 * 转发到主进程后端（wechat:call）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './titlebar.css'
import { setDirectoryPicker, setWechatRemote } from '../ui-wechat/src/client/pages/wechat-data/api.ts'
import { WechatDataPanel } from '../ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx'
import { getOpen, openWechat, subscribeOpen } from '../ui-wechat/src/client/wechat-state.ts'
import { OnboardingShell } from './onboarding/OnboardingShell.tsx'
import { loadOnboardingState, resetOnboarding } from './onboarding/store.ts'
import { LicenseGate } from './license/LicenseGate.tsx'
import { isLicenseUsable } from './license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from './license/LicenseGate.tsx'

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

/** 自绘标题栏：拖拽区域 + 最小化/全屏/关闭。 */
function initTitlebar(): void {
  const api = (window as any).electronAPI?.windowControls
  if (!api) return
  const byId = (id: string) => document.getElementById(id)
  byId('tb-min')?.addEventListener('click', () => api.minimize())
  byId('tb-close')?.addEventListener('click', () => api.close())

  // 全屏按钮：图标与提示随状态切换（两种图标都在 DOM 里，用 data-on 切）
  const fullBtn = byId('tb-full')
  const syncFull = (on: boolean): void => {
    if (!fullBtn) return
    if (on) fullBtn.setAttribute('data-on', '')
    else fullBtn.removeAttribute('data-on')
    fullBtn.setAttribute('title', on ? '退出全屏' : '全屏')
  }
  fullBtn?.addEventListener('click', () => api.toggleFullscreen())
  Promise.resolve(api.isFullscreen?.()).then(syncFull).catch(() => { /* 拿不到就当未全屏 */ })
  api.onFullscreenChange?.(syncFull)
}
initTitlebar()

/**
 * 验收测试模式的醒目横幅。
 *
 * 验收脚本用本地 mock LLM 替换真模型，回答是固定文本（内容与真实数据无关）。
 * 这曾两次被误认成「应用在编造答案」，所以在窗口顶部挂一条红条，一眼可辨。
 */
void (async (): Promise<void> => {
  try {
    const api = (window as any).electronAPI
    const isTest = await api?.isTestMode?.()
    if (!isTest) return
    if (document.getElementById('test-mode-banner')) return
    const bar = document.createElement('div')
    bar.id = 'test-mode-banner'
    bar.textContent = '⚠ 验收测试模式：本窗口的回答来自本地 mock 模型，不是真实数据'
    bar.setAttribute(
      'style',
      'flex:0 0 auto;padding:6px 12px;background:#b91c1c;color:#fff;'
        + 'font:600 12px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'text-align:center;letter-spacing:.02em',
    )
    document.body.insertBefore(bar, document.getElementById('root'))
  } catch {
    /* 横幅失败不影响使用 */
  }
})()
/**
 * 后端进程状态横幅。
 *
 * 为什么需要它：后端 worker 是独立进程，可能被杀、崩掉或重启失败。
 * 主进程会把状态作为 `wechat-backend-status` 事件广播出去，但**渲染端原先没有任何
 * 消费者** —— 后端死掉时界面只会表现为「数据一直加载不出来」，用户无从判断是没数据
 * 还是后端挂了。这里把状态显式说出来：
 *   · down / restarting → 黄条（正在自愈，稍等）
 *   · failed            → 红条（自愈失败，需要人工介入，附主进程给的排查指引）
 *   · ready             → 移除横幅
 *
 * 挂载后还会主动查一次 `backendState()`：订阅是模块加载时注册的，而首启期间后端
 * 可能先于订阅就报出状态 —— 那些事件会丢失，只靠事件会漏掉「首启就失败」的情况。
 */
void (async (): Promise<void> => {
  const api = (window as any).electronAPI?.wechat
  if (!api) return
  const BANNER_ID = 'backend-status-banner'

  const render = (state: string, lastError: string | null): void => {
    const existing = document.getElementById(BANNER_ID)
    if (state === 'ready' || state === 'starting' || state === 'stopped') {
      existing?.remove()
      return
    }
    const failed = state === 'failed'
    const text = failed
      ? `⚠ ${lastError ?? '微信+ 后端不可用'}`
      : `⏳ 微信+ 后端正在重启${lastError ? `（${lastError}）` : ''}，稍后自动恢复`
    if (existing) {
      existing.textContent = text
      existing.setAttribute('data-failed', failed ? '' : 'pending')
      existing.setAttribute('style', bannerStyle(failed))
      return
    }
    const bar = document.createElement('div')
    bar.id = BANNER_ID
    bar.textContent = text
    bar.setAttribute('data-failed', failed ? '' : 'pending')
    bar.setAttribute('style', bannerStyle(failed))
    document.body.insertBefore(bar, document.getElementById('root'))
  }

  /** 与验收测试模式横幅同一套排版，只有配色随严重度变。 */
  const bannerStyle = (failed: boolean): string =>
    'flex:0 0 auto;padding:6px 12px;color:#fff;'
    + `background:${failed ? '#b91c1c' : '#b45309'};`
    + 'font:600 12px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
    + 'text-align:center;letter-spacing:.02em'

  try {
    const snap = await api.backendState?.()
    if (snap?.ok && snap.value) render(snap.value.state, snap.value.lastError ?? null)
  } catch {
    /* 拿不到状态就不显示横幅，不影响使用 */
  }
  api.onEvent?.((ev: { name: string; args?: unknown[] }) => {
    if (ev.name !== 'wechat-backend-status') return
    const s = (ev.args?.[0] ?? {}) as { state?: string; lastError?: string | null }
    render(s.state ?? 'down', s.lastError ?? null)
  })
})()
function WechatApp(): React.JSX.Element {
  const [open, setOpen] = useState(getOpen())
  // 启动页：首次必须浏览完；再次启动可跳过
  const [onboardingDone, setOnboardingDone] = useState(() => loadOnboardingState().completed)
  /** 每次启动检测 License；无效/过期时即使 onboarding 已完成也回到启动页授权 */
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [licReady, setLicReady] = useState(false)

  useEffect(() => {
    const api = (window as any).electronAPI?.license
    if (!api?.status) {
      setLicReady(true)
      return
    }
    void api.status()
      .then((s: LicenseStatus) => { setLic(s); setLicReady(true) })
      .catch(() => { setLicReady(true) })
  }, [])

  useEffect(() => subscribeOpen(() => setOpen(getOpen())), [])
  useEffect(() => {
    if (onboardingDone && licReady && isLicenseUsable(lic) && !getOpen()) openWechat()
  }, [onboardingDone, licReady, lic])
  const handleOnboardingComplete = useCallback(() => {
    setOnboardingDone(true)
    openWechat()
  }, [])
  // 主界面「数据配置 → 高级设置 → 重新查看启动页」
  useEffect(() => {
    const onShow = (): void => {
      resetOnboarding()
      setOnboardingDone(false)
    }
    window.addEventListener('super-time:show-onboarding', onShow)
    return () => window.removeEventListener('super-time:show-onboarding', onShow)
  }, [])

  if (!licReady) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#050a18', color: '#00f0ff', fontFamily: 'sans-serif', fontSize: 13,
      }}>
        正在校验授权…
      </div>
    )
  }

  // 未完成启动引导，或授权不可用 → 启动页（4 个介绍页之后才是 License 验证，它同时也是进入系统的闸门）
  if (!onboardingDone || !isLicenseUsable(lic)) {
    return <OnboardingShell onComplete={handleOnboardingComplete} />
  }
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
  return (
    <LicenseGate>
      <WechatDataPanel />
    </LicenseGate>
  )
}

createRoot(document.getElementById('root')!).render(<WechatApp />)
