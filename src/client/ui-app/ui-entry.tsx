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
// 全局隐藏滚动条（各界面一视同仁；滚动行为不受影响，理由见该文件头部注释）
import './scrollbars.css'
// 手机浏览器的视口口径（dvh / 安全区 / 可选中文字）。桌面端不受影响，理由见该文件头注。
import './mobile-viewport.css'
import { getOpen, openWechat, setCapabilities, setDirectoryPicker, setWechatRemote, subscribeOpen, WechatDataPanel } from '@deepseek-ai/dsh-client-ui-wechat/host'
import type { ElectronApi, WechatRemote } from '@deepseek-ai/dsh-client-ui-wechat/host'
import { OnboardingShell } from './onboarding/OnboardingShell.tsx'
import { loadOnboardingState, resetOnboarding } from './onboarding/store.ts'
import { shouldSkipGates } from './debug-gates.ts'
import type { DebugGatesFact } from './debug-gates.ts'
import { PrivacyConsentGate } from './privacy/PrivacyConsentGate.tsx'
import { acceptConsent, loadConsentRecord, needsConsent, resetConsent } from './privacy/consent.ts'
import { LicenseGate } from './license/LicenseGate.tsx'
import { isLicenseUsable } from './license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from './license/LicenseGate.tsx'
// 桌面端（IPC）与手机浏览器（HTTP + SSE）的分流：能力表、HTTP Remote、事件映射表、令牌门。
import { bypassLocalGates, capabilities } from './capabilities.ts'
import { createHttpRemote } from './http-remote.ts'
import { dispatchWechatEvent } from './wechat-events.ts'
import { BrowserSession } from './browser-gate.tsx'

/**
 * 安装 Remote 与事件中继：桌面端走 Electron IPC，手机浏览器走同源 HTTP + SSE。
 *
 * ## 为什么两条路能共用同一套面板
 *
 * 两边的**返回值形状**与**事件载荷形状**都一致：
 *   · IPC 的 `wechat:call` 与 HTTP 的 `POST /api/wechat/call` 都回 `{ ok, value }` /
 *     `{ ok:false, error }`，而且服务端那一边过的是**同一道闸门**（`src/backend/call-gates.js`）、
 *     进的是**同一个 worker** ⇒ `api-core.ts` 的 `unwrap` 与所有面板一行都不用改；
 *   · IPC 的 `wechat:event` 与 SSE 的 data 帧都是 `{ name, args }` ⇒ 两边都交给
 *     `wechat-events.ts` 的**同一张映射表**翻译成 DOM CustomEvent。映射只有一份，
 *     就不会出现「桌面端会实时刷新、手机端不会」这种只在一端复现的偏差。
 *
 * 判定口径在 `capabilities.ts`：只有桥**确实齐全**才算桌面端，否则一律按浏览器处理
 * （失败方向是「少几个原生按钮」，而不是「去调一个不存在的桥然后抛」）。
 */
function installRemote(): void {
  /**
   * 能力表注入给渲染层（M9）：面板只读这一份，不再各自 `window.electronAPI?.xxx` 探桥。
   * 判环境的口径仍然只有 `capabilities.ts` 那一处 —— 这里只是把它递过包界。
   */
  setCapabilities(capabilities)
  if (capabilities.isDesktop) {
    const electronAPI = window.electronAPI!
    /** 前端 Remote：一个 Proxy，把 api.ts 中的每个方法调用转成 Electron IPC。 */
    const remoteProxy = new Proxy({} as WechatRemote, {
      get(_target, prop) {
        if (prop === '$on') return () => () => undefined
        const name = String(prop)
        return (...args: unknown[]) => electronAPI.wechat.call(name, args)
      },
    })
    setWechatRemote(remoteProxy)

    /** 目录选择器：走主进程原生对话框。 */
    setDirectoryPicker(async () => {
      const r = await electronAPI.pickDirectory()
      return r?.path ?? null
    })

    /** 将后端实时更新事件转发为 api.ts / 面板监听的 DOM 事件（映射表见 wechat-events.ts）。 */
    electronAPI.wechat.onEvent(dispatchWechatEvent)
    return
  }

  // 浏览器态：HTTP Remote。SSE 事件流**不在这里起** —— 由 BrowserSession 在令牌门
  // 放行之后启动（未授权时它只会不停收到 401，既没用也刷噪声）。
  setWechatRemote(createHttpRemote())
  // 手机上没有「本机目录」可选（数据在电脑上）。返回 null 而不是抛：
  // 依赖它的控件由 capabilities.dirPicker=false 隐藏（见 settings 面板），
  // 万一还有漏网的调用点，它拿到的也只是一次「用户取消」。
  setDirectoryPicker(async () => null)
  // 浏览器有自己的标签页与地址栏：自绘标题栏在这里只是一条 38px 高的死控件
  // （拖拽区拖不动窗口、三个按钮点了没反应）。body 是 flex column、#root 是 flex:1，
  // 所以直接把这个元素摘掉，#root 会自动占满高度 —— 不需要改任何 CSS。
  if (!capabilities.titlebar) document.getElementById('titlebar')?.remove()
}
installRemote()

/** 自绘标题栏：拖拽区域 + 最小化/全屏/关闭。 */
function initTitlebar(): void {
  const api = window.electronAPI?.windowControls
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
 * 自动化窗口的横幅（2026-09-29 改写：把"自动化"与"mock 模型"分开说）。
 *
 * ## 为什么改
 *
 * 原文字是「⚠ 验收测试模式：本窗口的回答来自本地 mock 模型，不是真实数据」。但
 * `SUPERTIME_TEST_MODE=1` **只表示"这个窗口是自动化脚本起的"** —— 只有 `npm run ui:accept`
 * 才会真的把 `llm.json` 指向本地 mock（并同时设 `SUPERTIME_LLM_MOCK=1`）。
 * 主题审计 / 面板审计 / 性能测量这些真机脚本**从不装 mock**，用的还是**真实数据根 + 真实配置**。
 * 原文字让实机截图里的人以为"整份验收都在用假数据"（用户 2026-09-29 就是这么报障的）。
 *
 * 现在横幅分两句：**永远先说是自动化窗口 + 数据根是哪一份**；只有真装了 mock 才补一句
 * 「回答来自本地 mock 模型」。这样"这次验收用没用真实数据"一眼可查。
 */
void (async (): Promise<void> => {
  try {
    const api = window.electronAPI
    const mode = await (api?.runMode?.() ?? api?.isTestMode?.())
    // 兼容两种形状：新接口给对象，老接口给布尔。
    const isTest = typeof mode === 'object' && mode !== null ? mode.test === true : mode === true
    if (!isTest) return
    if (document.getElementById('test-mode-banner')) return
    const llmMock = typeof mode === 'object' && mode !== null ? mode.llmMock === true : false
    const dataRoot = typeof mode === 'object' && mode !== null ? String(mode.dataRoot ?? '') : ''
    const where = dataRoot !== '' ? `数据根：${dataRoot}` : '数据根：未记录'
    const llm = llmMock
      ? '回答来自**本地 mock 模型**（内容与真实数据无关）'
      : '使用真实配置（含 llm.json），答案来自你配置的模型'
    const bar = document.createElement('div')
    bar.id = 'test-mode-banner'
    bar.textContent = `⚠ 自动化验收窗口（SUPERTIME_TEST_MODE=1）· ${where} · ${llm}`
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
  const api = window.electronAPI?.wechat
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
    const api: ElectronApi | undefined = window.electronAPI
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
  /**
   * 「跳过本地三道闸门」的总口径 = 调试豁免 **或** 浏览器态。
   *
   * 两者理由不同，但结论一样（直接进主面板）：
   *   · `skipGates` 是主进程判定的调试豁免（打包态恒 false），给验收脚本用；
   *   · `bypassLocalGates` 是手机浏览器态 —— 那三道闸门在这台设备上**一件都做不成**
   *     （引导讲的是本机数据根与密钥、隐私同意记录在桌面端的 localStorage 里、
   *     许可证绑的是电脑的设备指纹），而真正的授权已经由「桌面端主人生成令牌并交给手机」
   *     完成了，每次调用还要再过服务端那道 `authorizeCall`。
   *
   * 刻意**不**把它并进 `skipGates`：调试横幅（下面那个 effect）只该在调试豁免时出现，
   * 手机上挂一条「🛠 调试模式」会把用户吓到，也会让真机截图失去意义。
   */
  const gatesBypassed = skipGates || bypassLocalGates

  useEffect(() => {
    const api = window.electronAPI?.license
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
    // 未拿到豁免时，三个条件（引导 / 同意 / 授权）都必须成立；gatesBypassed 时直接放行 ——
    // 豁免的全部意义就是「没有许可证也能进主界面」，所以它必须能让 isLicenseUsable 那一项短路。
    if ((gatesBypassed || (onboardingDone && consented && isLicenseUsable(lic))) && !getOpen()) openWechat()
  }, [gates, gatesBypassed, onboardingDone, consented, licReady, lic])
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
    const api = window.electronAPI?.license
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
    const api = window.electronAPI?.windowControls
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

  // 闸门事实还没到 → 不渲染任何一屏（否则会先闪一下启动页/同意屏再跳走）。
  // 背景与文字用 CSS 变量：`--nm-*` 由 `:root.theme-light` 翻转，而 `theme.ts`
  // 在模块加载时就已把 class 写到 <html> 上（见 theme.ts:120-133），所以这一屏
  // 不需要自己判断主题 —— 之前写死 `#050a18 / #00f0ff`，浅色主题下这里是一块黑屏。
  if (!licReady || gates === null) {
    return (
      <div
        className="boot-gate-checking"
        role="status"
        aria-live="polite"
        style={{
          height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 14,
          background: 'var(--nm-bg-0, #050a18)', color: 'var(--nm-text-2, #94a3b8)',
          fontFamily: 'var(--nm-font-sans, sans-serif)',
        }}
      >
        <span style={{ color: 'var(--nm-cyan, #00f0ff)' }} aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" />
            <circle cx="6.2" cy="10.8" r="1" fill="currentColor" stroke="none" />
            <circle cx="9.7" cy="10.8" r="1" fill="currentColor" stroke="none" />
            <circle cx="13.2" cy="10.8" r="1" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <div style={{ fontSize: 13, letterSpacing: '.02em' }}>正在检查本机状态…</div>
        {/*
          说清在等**什么**：这三件事各自主进程查（授权 / 引导记录 / 隐私同意），
          慢的是第一条（要读签名与设备指纹）。原先只写「正在校验授权…」，
          用户会以为卡在授权上，而真正在跑的可能只是读 localStorage 里那条引导记录。
        */}
        <div style={{ fontSize: 11.5, color: 'var(--nm-text-3, #64748b)', lineHeight: 1.7, textAlign: 'center' }}>
          正在确认：许可证有效性 · 启动引导记录 · 隐私声明版本<br />
          本机计算，不发出任何请求
        </div>
      </div>
    )
  }

  // 三道闸门里有两道未过 → 启动页：4 个介绍页 → **隐私同意** → License 授权（H14 定的顺序）。
  // 同意屏由启动页排在授权**之前**，于是「机器上没有有效许可证」不再等于「永远看不到同意屏」。
  // `!gatesBypassed` 是豁免口子：调试豁免（主进程判定「非打包态 + 显式开关」）或手机浏览器态
  // （那三道闸门在这台设备上做不成，且令牌门已经代表桌面端主人授权过了 —— 见 capabilities.ts）。
  if (!gatesBypassed && (!onboardingDone || !isLicenseUsable(lic))) {
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
  if (!gatesBypassed && !consented) {
    return <PrivacyConsentGate onAccepted={handleConsentAccepted} onExit={handleConsentRejected} />
  }
  if (!open) {
    /**
     * 「已关闭」态：窗口还在（托盘 / 任务栏），只是把聊天界面收起来了。
     *
     * 2026-10-12 完善：这块原来是裸 div + 写死 `#050a18`，**浅色主题下是一块黑屏**
     * （同一个坑上面那屏已经填过一次，两边当时只修了一边）。现在背景与文字都走
     * `--nm-*` 令牌，并补上品牌位、「去哪再打开」的说明与可聚焦的按钮样式。
     * 用 `role="status"`：读屏软件需要知道这一屏是在解释状态而不是报错。
     */
    return (
      <div
        className="boot-closed"
        role="status"
        style={{
          height: '100%', display: 'flex', flexDirection: 'column', gap: 14,
          alignItems: 'center', justifyContent: 'center',
          background: 'var(--nm-bg-0, #050a18)', color: 'var(--nm-text-2, #94a3b8)',
          fontFamily: 'var(--nm-font-sans, sans-serif)', padding: 24,
        }}
      >
        <span style={{ color: 'var(--nm-cyan, #00f0ff)' }} aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" />
            <circle cx="6.2" cy="10.8" r="1" fill="currentColor" stroke="none" />
            <circle cx="9.7" cy="10.8" r="1" fill="currentColor" stroke="none" />
            <circle cx="13.2" cy="10.8" r="1" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--nm-text-1, #e2e8f0)', letterSpacing: '.02em' }}>
          Super Time 已收起
        </div>
        <div style={{ fontSize: 12.5, textAlign: 'center', lineHeight: 1.75, maxWidth: 420 }}>
          数据界面已关闭，后端与托盘仍在运行。<br />
          需要时从托盘图标、或者主界面左下角重新打开。
        </div>
        <button type="button" onClick={openWechat}
          style={{
            padding: '10px 20px', borderRadius: 'var(--nm-r-md, 10px)',
            border: '1px solid var(--nm-cyan-35, rgba(0, 240, 255, .35))',
            background: 'var(--nm-cyan-10, rgba(0, 240, 255, .1))',
            color: 'var(--nm-cyan, #00f0ff)', cursor: 'pointer',
            font: 'inherit', fontSize: 13, fontWeight: 600, letterSpacing: '.02em',
          }}>
          打开 Super Time
        </button>
      </div>
    )
  }
  // 授权闸门的**第二层**在 LicenseGate 自己身上（它独立查一次状态，未授权就渲染解锁页）。
  // 豁免必须连它一起绕过，否则「跳过」会停在解锁页上、看起来像没生效。绕过发生在
  // gatesBypassed 时（调试豁免，或手机浏览器态 —— 授权由服务端逐调用把关，
  // 手机侧再查一次只会查到「这台设备没有许可证」，把一个已授权的会话挡在门外）；
  // 桌面端的正常路径仍由 LicenseGate 把关。
  if (gatesBypassed) {
    return <WechatDataPanel />
  }
  return (
    <LicenseGate>
      <WechatDataPanel />
    </LicenseGate>
  )
}

/**
 * 根组件：手机浏览器要先过**令牌门**，桌面端直接进。
 *
 * 门放在这一层（而不是 `WechatApp` 里面）是有意的：未授权时连 `WechatApp` 都不该挂载 ——
 * 它一挂载就会发一串请求，而那些请求全会拿到 401，界面上表现为「一屏加载失败」，
 * 用户看不出真正的原因是「还没输入令牌」。
 */
function Root(): React.JSX.Element {
  if (capabilities.isBrowser) return <BrowserSession><WechatApp /></BrowserSession>
  return <WechatApp />
}

createRoot(document.getElementById('root')!).render(<Root />)
