/**
 * Super Time —— 前端入口
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
import { shouldSkipGates } from './debug-gates.ts'
import type { DebugGatesFact } from './debug-gates.ts'
import { PrivacyConsentGate } from './privacy/PrivacyConsentGate.tsx'
import { acceptConsent, loadConsentRecord, needsConsent, resetConsent } from './privacy/consent.ts'
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
 *    text 是「已生成的全文」（不是片段），渲染端整体替换即可。
 *  · wechat-export/progress —— 长任务（导出/加密备份）进度：payload 是
 *    { jobId, phase, done, total }。回调与 AbortSignal 都过不了 IPC（M3 的整个设计前提），
 *    所以进度只能这样推 —— 少中继这一条，界面上就只有一个「导出中…」的按钮在空转。 */
;(window as any).electronAPI.wechat.onEvent((ev: { name: string; args?: unknown[] }) => {
  if (ev.name === 'wechat-data/updated') {
    window.dispatchEvent(new CustomEvent('dsh-wechat-data-updated'))
  } else if (ev.name === 'wechat-ask/delta') {
    window.dispatchEvent(new CustomEvent('dsh-wechat-ask-delta', { detail: ev.args?.[0] ?? null }))
  } else if (ev.name === 'wechat-export/progress') {
    window.dispatchEvent(new CustomEvent('dsh-wechat-export-progress', { detail: ev.args?.[0] ?? null }))
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

  const render = (state: string, lastError: string | null, restarts?: number): void => {
    const existing = document.getElementById(BANNER_ID)
    if (state === 'ready' || state === 'starting' || state === 'stopped') {
      existing?.remove()
      return
    }
    const failed = state === 'failed'
    const attempt = restarts && restarts > 0 ? `（第 ${restarts} 次尝试）` : ''
    const text = failed
      ? `⚠ ${lastError ?? 'Super Time 后端不可用'}`
      : `⏳ Super Time 后端正在重启${attempt}${lastError ? `：${lastError}` : ''}，稍后自动恢复`
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
    if (snap?.ok && snap.value) render(snap.value.state, snap.value.lastError ?? null, snap.value.restarts)
  } catch {
    /* 拿不到状态就不显示横幅，不影响使用 */
  }
  api.onEvent?.((ev: { name: string; args?: unknown[] }) => {
    if (ev.name !== 'wechat-backend/status') return
    const s = (ev.args?.[0] ?? {}) as { state?: string; lastError?: string | null; restarts?: number }
    render(s.state ?? 'down', s.lastError ?? null, s.restarts)
  })
})()
function WechatApp(): React.JSX.Element {
  const [open, setOpen] = useState(getOpen())
  // 启动页：首次必须浏览完；再次启动可跳过
  const [onboardingDone, setOnboardingDone] = useState(() => loadOnboardingState().completed)
  /**
   * 隐私同意（H14）：未同意前不得进入主界面。
   *
   * 判定走纯模块（`privacy/consent.ts`）：记录缺失、形状不对、或版本低于当前声明
   * （`PRIVACY_VERSION`）都要求重新同意 —— 失败方向必须是「再问一次」，不是「默认放行」。
   */
  const [consented, setConsented] = useState(() => !needsConsent(loadConsentRecord()))
  /**
   * 首启闸门豁免（N2）：主进程给的事实，`null` 表示还没拿到（此时不放行任何一屏）。
   *
   * 为什么要单独拉一次而不是看 `SUPERTIME_TEST_MODE`：豁免必须在**非打包态**才生效，
   * 而环变量不是信任边界 —— 判定由主进程做（`app.isPackaged`），这里只做第二道校验
   * （`shouldSkipGates` 要求 `packaged === false`）。
   */
  const [gates, setGates] = useState<DebugGatesFact | null>(null)
  /** 每次启动检测 License；无效/过期时即使 onboarding 已完成也回到启动页授权 */
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [licReady, setLicReady] = useState(false)

  useEffect(() => {
    let alive = true
    const api = (window as any).electronAPI
    const pending = api?.debugGates?.()
    if (!pending || typeof pending.then !== 'function') {
      setGates({ packaged: true }) // 拿不到事实 ⇒ 不放行（guard 期望 packaged===false）
      return () => { alive = false }
    }
    void pending
      .then((g: unknown) => { if (alive) setGates((g ?? { packaged: true }) as DebugGatesFact) })
      .catch(() => { if (alive) setGates({ packaged: true }) })
    return () => { alive = false }
  }, [])
  const skipGates = shouldSkipGates(gates)

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
    if (gates === null || !licReady) return
    // 未拿到豁免时，三个条件（引导 / 同意 / 授权）都必须成立；skipGates 时直接放行 ——
    // 豁免的全部意义就是「没有许可证也能进主界面」，所以它必须能让 isLicenseUsable 那一项短路。
    if ((skipGates || (onboardingDone && consented && isLicenseUsable(lic))) && !getOpen()) openWechat()
  }, [gates, skipGates, onboardingDone, consented, licReady, lic])
  /**
   * 豁免生效时的醒目横幅（N2）：自动化与人工都能一眼看出「这一屏是跳过闸门进来的」，
   * 不会被误读成「首启流程没问题」。打包态不可能出现它（主进程的 skipGates 恒 false）。
   */
  useEffect(() => {
    if (!skipGates) return
    const BANNER_ID = 'debug-gates-banner'
    if (document.getElementById(BANNER_ID)) return
    const bar = document.createElement('div')
    bar.id = BANNER_ID
    bar.textContent = '🛠 调试模式：已跳过启动引导 / 隐私同意 / 授权（SUPERTIME_SKIP_ONBOARDING=1，仅非打包态生效）'
    bar.setAttribute(
      'style',
      'flex:0 0 auto;padding:6px 12px;background:#7c3aed;color:#fff;'
        + 'font:600 12px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'text-align:center;letter-spacing:.02em',
    )
    document.body.insertBefore(bar, document.getElementById('root'))
  }, [skipGates])
  const handleOnboardingComplete = useCallback(() => {
    setOnboardingDone(true)
    openWechat()
    // 引导页的最后一站就是「授权验证」，用户可能刚在那里导入证书 —— 而本组件的 lic
    // **只在挂载时取过一次**（见上面的 effect），不重取的话 isLicenseUsable(lic) 仍是
    // 挂载时的旧值（未授权），下面两处放行判断都过不去。表现就是「导入成功、点『进入系统』
    // 没反应」，得重开应用才进得去。
    // 这里先乐观放行（onboardingDone / openWechat 立即置位），再补一次状态；万一这次取不到，
    // 第二层的 LicenseGate 自己还会再查一次，不会因此把未授权的界面放进系统。
    const api = (window as any).electronAPI?.license
    void Promise.resolve(api?.status?.())
      .then((s: LicenseStatus | undefined) => { if (s) setLic(s) })
      .catch(() => { /* 拿不到就交给 LicenseGate 那一层兜底 */ })
  }, [])
  const recordConsent = useCallback(() => {
    acceptConsent()
    setConsented(true)
    // 这里**不**调 openWechat()：同意只是三道闸门里的一道。放行由上面那个 effect 判
    // （引导 / 同意 / 授权三项都成立才 openWechat），启动页也据此决定能不能点「进入系统」。
  }, [])
  const handleConsentAccepted = useCallback(() => {
    // 走到这条回调时引导与授权都已通过（见下面的闸门顺序），所以可以直接放行进主界面。
    recordConsent()
    openWechat()
  }, [recordConsent])
  const handleConsentRejected = useCallback(() => {
    // 不同意就不放行：关掉窗口（自绘标题栏的关闭路径由 preload 的 windowControls 提供）。
    const api = (window as any).electronAPI?.windowControls
    if (api?.close) api.close()
  }, [])
  // 主界面「数据配置 → 高级设置 → 重新查看启动页」
  useEffect(() => {
    const onShow = (): void => {
      resetOnboarding()
      // 连隐私同意一起重置：这条入口同时是「重新审阅并再次同意声明」的路径
      resetConsent()
      setOnboardingDone(false)
      setConsented(false)
    }
    window.addEventListener('super-time:show-onboarding', onShow)
    return () => window.removeEventListener('super-time:show-onboarding', onShow)
  }, [])

  // 闸门事实还没到 → 不渲染任何一屏（否则会先闪一下启动页/同意屏再跳走）
  if (!licReady || gates === null) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#050a18', color: '#00f0ff', fontFamily: 'sans-serif', fontSize: 13,
      }}>
        正在校验授权…
      </div>
    )
  }

  // 三道闸门里有两道未过 → 启动页：4 个介绍页 → **隐私同意** → License 授权（H14 定的顺序）。
  // 同意屏由启动页排在授权**之前**，于是「机器上没有有效许可证」不再等于「永远看不到同意屏」。
  // `!skipGates` 是 N2 的豁免口子：只有主进程判定「非打包态 + 显式开关」时才绕过
  if (!skipGates && (!onboardingDone || !isLicenseUsable(lic))) {
    return (
      <OnboardingShell
        onComplete={handleOnboardingComplete}
        requireConsent={!consented}
        onConsentAccepted={recordConsent}
        onConsentExit={handleConsentRejected}
      />
    )
  }
  // 引导与授权都已通过、只是声明升版要求重新同意 → 单独一屏（不塞回启动页，免得重看四页介绍）
  if (!skipGates && !consented) {
    return <PrivacyConsentGate onAccepted={handleConsentAccepted} onExit={handleConsentRejected} />
  }
  if (!open) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#050a18', color: '#e2e8f0', fontFamily: 'sans-serif' }}>
        <div style={{ fontSize: 40 }}>💬</div>
        <div>Super Time 已关闭</div>
        <button type="button" onClick={openWechat}
          style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(0,240,255,.35)', background: 'rgba(0,240,255,.08)', color: '#00f0ff', cursor: 'pointer' }}>
          打开 Super Time
        </button>
      </div>
    )
  }
  // 授权闸门的**第二层**在 LicenseGate 自己身上（它独立查一次状态，未授权就渲染解锁页）。
  // 豁免必须连它一起绕过，否则「跳过」会停在解锁页上、看起来像没生效。绕过只发生在
  // skipGates（主进程判定、仅非打包态）时；正常路径仍由 LicenseGate 把关。
  if (skipGates) {
    return <WechatDataPanel />
  }
  return (
    <LicenseGate>
      <WechatDataPanel />
    </LicenseGate>
  )
}

createRoot(document.getElementById('root')!).render(<WechatApp />)
