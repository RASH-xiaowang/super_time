/**
 * Super Time 多页面启动页
 *
 * 四页：首页 / 功能引导 / 使用说明 / 关于。
 * 首次启动必须浏览全部页面；再次启动可跳过直接进入主界面。
 * 视觉令牌复用主面板 scifi-theme.css（--nm-*）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// 启动页可能先于 WechatDataPanel 挂载，主题令牌需在此加载
import { getThemeMode, toggleThemeMode } from '@deepseek-ai/dsh-client-ui-wechat/theme'
import {
  ONBOARDING_PAGES,
  allPagesVisited,
  completeOnboarding,
  loadOnboardingState,
  markPageVisited,
  saveOnboardingState,
  type OnboardingPageId,
  type OnboardingState,
} from './store.ts'
import { ParticleField } from './particles.tsx'
import { LicenseAuthPanel, isLicenseUsable } from '../license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from '../license/LicenseGate.tsx'
// 隐私同意是启动页的第五站（H14）：直接复用主界面那一屏，文案与守卫都是同一份，
// 不另写一个「精简版同意提示」（两份声明会漂，而这是给用户看的法律性文本）。
import { PrivacyConsentGate } from '../privacy/PrivacyConsentGate.tsx'
// 启动页（含最后一站「授权验证」也要能看到「有新版本可装 / 许可证即将到期」——
// 更新与到期是主进程的事，与「有没有进主界面」无关。这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '@deepseek-ai/dsh-client-ui-wechat/notice'
import css from './onboarding.module.css'
import cssstages from './onboarding-stages.module.css'
// 2026-10-12 拆屏：四个内容页与舞台零件各归各的文件，本文件只留状态机与外壳。
// 四页仍然从这里**转出导出** —— `scripts/onboarding-ssr.tsx` 按这个路径导入它们，
// 拆分因此不改变那份冒烟的用法（也别改：它是这些页面唯一的渲染级判据）。
import { BrandMark, HudCorner, ProgressRing, StageHead } from './stage-chrome.tsx'
import { AboutPage } from './pages/AboutPage.tsx'
import { FeaturesPage } from './pages/FeaturesPage.tsx'
import { HelpPage } from './pages/HelpPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { CONSENT_STAGE, LICENSE_STAGE, STAGE_BGS, type RuntimeVersions } from './runtime.ts'

export { AboutPage, FeaturesPage, HelpPage, HomePage }
export type { RuntimeVersions }

/** 启动页的阶段：4 个内容页 + 两道闸门（常量见 `./runtime.ts`）。 */
type OnboardingStage = OnboardingPageId | typeof CONSENT_STAGE | typeof LICENSE_STAGE

export interface OnboardingShellProps {
  /** 完成或跳过后进入主界面。 */  onComplete: () => void
  /**
   * 还没取得隐私同意时为 true：此时「隐私同意」排在「授权验证」**之前**，且没同意不算完成。
   *
   * 同意的**记录**仍由调用方（`ui-entry`）持有，这里只把它排进流程 —— 两处各存一份会漂。
   * 之所以排在这里而不是「授权之后再拦一道」：没有有效许可证的机器原本永远看不到同意屏
   * （授权失败就回启动页，走不到同意），而同意是合规前提，不能被商业闸门挡在后面（H14）。
   */
  requireConsent?: boolean
  /** 用户在同意的屏幕上点了「同意并继续」。不传则同意这一站不成立（见 `consentGate`）。 */
  onConsentAccepted?: () => void
  /** 点了「不同意并退出」。不传则屏幕上只给提示、不给退出按钮。 */
  onConsentExit?: () => void
}

export function OnboardingShell({
  onComplete, requireConsent = false, onConsentAccepted, onConsentExit,
}: OnboardingShellProps): React.JSX.Element {
  /**
   * 同意这一站是否成立：调用方既要求同意、又给了「同意之后做什么」的回调。
   * 少了回调就没有任何出口，那时宁可把这一站整体撤掉，也不能把人永久关在门外。
   * 定义在 `useState` 之前，是因为初始阶段也要按它来定（否则未接线时会停在出不去的同意站）。
   */
  const consentGate = requireConsent && onConsentAccepted !== undefined
  const [state, setState] = useState<OnboardingState>(() => loadOnboardingState())
  /**
   * 当前阶段。首启一律从「首页」开始 —— 先介绍是什么、有什么，最后才要许可证；
   * 只有「启动页已完成、再次被拉回来纯粹是因为闸门没过」才直接落到最后一站。
   */
  const [page, setPage] = useState<OnboardingStage>(() => (
    !state.completed ? 'home' : consentGate ? CONSENT_STAGE : LICENSE_STAGE
  ))
  const [versions, setVersions] = useState<RuntimeVersions | null>(null)
  const [theme, setTheme] = useState(() => getThemeMode())
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [licLoading, setLicLoading] = useState(true)
  const bodyRef = useRef<HTMLElement | null>(null)
  /** 滚轮翻页冷却：一次手势只切一页，避免触控板惯性连翻。 */
  const wheelLockRef = useRef(false)
  const wheelAccRef = useRef(0)

  const licenseOk = isLicenseUsable(lic)
  const onLicenseStage = page === LICENSE_STAGE
  const onConsentStage = page === CONSENT_STAGE
  /**
   * 两处闸门都过了才谈得上「进入系统」：授权是商业闸门，同意是合规闸门，缺一不可。
   *
   * 这里刻意用 `requireConsent` 而不是 `consentGate`：调用方若只说「还缺同意」却没接回调，
   * 闸门类判断的失败方向必须是**不放行**（与许可闸门同一口径），而不是悄悄当成已同意。
   * 那种接法会让人停在介绍页出不去 —— 那是一个看得见、改得掉的接线错误；
   * 而「未同意也放行」是看不见的合规漏洞。
   */
  const canEnter = licenseOk && !requireConsent

  // 未同意时停在同意站：点「授权验证」标签、按 → 、滚轮，一律落回同意站（见下面的 effect）。
  useEffect(() => {
    if (page === LICENSE_STAGE && consentGate) setPage(CONSENT_STAGE)
    else if (page === CONSENT_STAGE && !consentGate) setPage(LICENSE_STAGE)
  }, [page, consentGate])

  const isFirstLaunch = !state.completed
  // 同意是「完成」的前置条件之一（H14）：没同意，即使介绍页都看完、许可证也已有效，同样不放行。
  const ready = (state.completed || allPagesVisited(state)) && canEnter
  const pageOrder = useMemo<OnboardingStage[]>(
    () => [...ONBOARDING_PAGES.map((p) => p.id), ...(consentGate ? [CONSENT_STAGE] : []), LICENSE_STAGE],
    [consentGate],
  )
  // `pageOrder.indexOf` 会有**一帧**取到 -1：同意刚生效/刚失效时，纠正用的 effect 要到
  // 下一帧才跑（见上面）。按 0 兜住，否则那一帧背景整块暗掉、页码显示成 00。
  const pageIndex = Math.max(0, pageOrder.indexOf(page))
  /** 闸门两站（同意 / 授权）的页码按实际顺序算：插进同意站后授权会变成 06。 */
  const stageIndex = String(pageIndex + 1).padStart(2, '0')
  /** 背景图只有 4 张：第 5 站起（同意 / 授权）沿用最后一张，否则背景会整块暗下去。 */
  const bgIndex = Math.min(pageIndex, STAGE_BGS.length - 1)
  const visitedCount = ONBOARDING_PAGES.filter((p) => state.visited.includes(p.id)).length
  /** 闸门两站（同意 / 授权）的进度单独算：它们问的是「过了没有」，不是「看了几页」。 */
  const gateStage = onLicenseStage || onConsentStage
  const gateTotal = consentGate ? 2 : 1
  const gateDone = (consentGate ? 0 : 1) + (licenseOk ? 1 : 0)
  const gateLabel = onConsentStage ? 'CONSENT REQUIRED'
    : licLoading ? 'CHECKING LICENSE…'
      : licenseOk ? 'LICENSE OK' : 'LICENSE REQUIRED'
  /** 底栏那一句提示说的是**当前这一站还缺什么**，所以同意排在授权前面时它也先说同意。 */
  const footerHint = requireConsent
    ? (onConsentStage ? '请阅读后勾选，再点「同意并继续」' : '同意隐私声明后方可继续')
    : !licenseOk
      ? (onLicenseStage ? '完成授权后方可进入系统' : '最后一页完成授权后方可进入系统')
      : !ready && isFirstLaunch
        ? '浏览完四页后可进入 · ← → 翻页'
        : '← → 翻页'

  // 每次进入启动页都检测 License（含过期/无效强制授权）
  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI?.license
    if (!api?.status) {
      setLic({ state: 'error', licensed: false, reason: 'license_api_missing' })
      setLicLoading(false)
      return
    }
    void api.status().then((s: LicenseStatus) => {
      if (!cancelled) {
        setLic(s)
        setLicLoading(false)
      }
    }).catch((err: Error) => {
      if (!cancelled) {
        setLic({ state: 'error', licensed: false, reason: err.message })
        setLicLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.getVersions) return
    void api.getVersions().then((v: RuntimeVersions) => {
      if (v) setVersions(v)
    }).catch(() => { /* 版本信息非关键 */ })
  }, [])

  // 进入某页即记为已浏览（首启强制覆盖全部页）；同意与授权是闸门，不是内容页，不记录
  useEffect(() => {
    if (page === LICENSE_STAGE || page === CONSENT_STAGE) return
    setState((prev) => {
      const next = markPageVisited(prev, page)
      if (next === prev) return prev
      saveOnboardingState(next)
      return next
    })
  }, [page])

  // 切页后回到内容区顶部
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [page])

  /**
   * 按 `pageOrder` 前进一步 / 后退一步。
   *
   * 取到 `undefined` 就**停在原地**：`page` 与 `pageOrder` 之间有一帧不一致（同意闸门刚生效
   * 或刚失效，纠正它的 effect 要到下一帧才跑），那一帧 `indexOf` 是 -1，不加兜底的话滚一下
   * 轮就把人弹到首页去。
   */
  const stepBy = useCallback((delta: 1 | -1) => {
    setPage((cur) => {
      const i = pageOrder.indexOf(cur)
      const at = delta > 0 ? Math.min(pageOrder.length - 1, i + 1) : Math.max(0, i - 1)
      return pageOrder[at] ?? cur
    })
  }, [pageOrder])

  /**
   * 滚轮翻页：内容区能滚且未到顶/底时优先滚内容；
   * 已到边或内容不可滚时，累计足够 deltaY 后切上/下一页。
   */
  useEffect(() => {
    const shell = bodyRef.current?.parentElement
    if (!shell) return

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return
      // 同意站上的滚轮归同意屏自己：那份声明比屏幕长，滚轮被抢走就读不完，
      // 而「没读完就点同意」不叫显式同意。这一站的前进只由它自己的按钮决定。
      if (page === CONSENT_STAGE) return
      const body = bodyRef.current
      if (!body) return

      const maxScroll = body.scrollHeight - body.clientHeight
      const atTop = body.scrollTop <= 1
      const atBottom = body.scrollTop >= maxScroll - 1
      const scrollingDown = e.deltaY > 0
      const scrollingUp = e.deltaY < 0

      // 内容还可滚：交给浏览器，不切页
      if (maxScroll > 2 && !((scrollingDown && atBottom) || (scrollingUp && atTop))) {
        return
      }

      e.preventDefault()
      if (wheelLockRef.current) return

      wheelAccRef.current += e.deltaY
      const THRESHOLD = 40
      if (Math.abs(wheelAccRef.current) < THRESHOLD) return

      const dir = wheelAccRef.current > 0 ? 1 : -1
      wheelAccRef.current = 0
      wheelLockRef.current = true
      window.setTimeout(() => { wheelLockRef.current = false }, 420)

      stepBy(dir > 0 ? 1 : -1)
    }

    shell.addEventListener('wheel', onWheel, { passive: false })
    return () => { shell.removeEventListener('wheel', onWheel) }
  }, [page, stepBy])

  const goPage = useCallback((id: OnboardingStage) => {
    setPage(id)
  }, [])

  /** 同意站只由它自己那两个按钮决定（滚轮已在这一站让位，见 wheel effect）。 */
  const acceptConsentHere = useCallback(() => { onConsentAccepted?.() }, [onConsentAccepted])

  const goPrev = useCallback(() => stepBy(-1), [stepBy])

  const goNext = useCallback(() => stepBy(1), [stepBy])

  // 键盘：← → 翻页，Enter 在最后一页进入系统
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        goNext()
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (canEnter && (state.completed || allPagesVisited(state))) {
          const next = completeOnboarding(state)
          setState(next)
          onComplete()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, state, onComplete, canEnter])

  const handleEnter = useCallback(() => {
    if (!canEnter) return
    if (isFirstLaunch && !allPagesVisited(state)) return
    const next = completeOnboarding(state)
    setState(next)
    onComplete()
  }, [isFirstLaunch, state, onComplete, canEnter])

  const handleSkip = useCallback(() => {
    // 「跳过」跳的是介绍页，不是闸门：未同意或未授权时它必须同样 disabled
    // （按钮的 disabled 用的就是 canEnter，见 footer）。
    if (!canEnter) return
    const next = completeOnboarding(state)
    setState(next)
    onComplete()
  }, [state, onComplete, canEnter])

  const toggleTheme = useCallback(() => {
    toggleThemeMode()
    setTheme(getThemeMode())
  }, [])

  return (
    <div
      className={css.shell}
      data-theme={theme}
      data-stage={pageIndex}
      style={{ ['--stage-p' as string]: String(pageIndex / Math.max(1, pageOrder.length - 1)) }}
    >
      {/* 主动提醒（右下角悬浮）：启动页上也要能看到「有新版本可装 / 许可证即将到期」。
          位置由卡片自己 fixed 决定，放在 DOM 哪儿都不影响呈现。
          同意站除外 —— `PrivacyConsentGate` 自己带一份，两个 fixed 堆叠在同一角上会叠成
          两张一样的卡（点掉一张还剩一张，看起来像「关闭」坏了）。 */}
      {!onConsentStage ? <NoticeBanner /> : null}

      {/* 多张背景图：随滚轮切页交叉淡入。
          只给**当前与相邻那一张**设背景：交叉淡入同时需要「进来的」和「出去的」两张，
          其余三张在进入范围之前不下 —— 虽然 WebP 之后总共才 0.59MB，但每张 1536×1024
          解码成位图要 ~6MB 内存，四张一起下就是首启动 25MB 的常驻内存。 */}
      <div className={cssstages.bgStack} aria-hidden="true">
        {STAGE_BGS.map((src, i) => (
          <div
            key={src}
            className={`${css.bgImage}${bgIndex === i ? ` ${css.bgImageOn}` : ''}`}
            style={Math.abs(i - bgIndex) <= 1 ? { backgroundImage: `url(${src})` } : undefined}
          />
        ))}
      </div>
      <div className={css.bgVeil} aria-hidden="true" />
      {/* 阶段光晕：随滚轮切页改变位置与色相 */}
      <div className={css.stageWash} aria-hidden="true" />
      {/* 背景光效层：网格 / 粒子 / 光带 / 扫描 / 几何 / HUD 角 */}
      <div className={css.bgGrid} aria-hidden="true" />
      <ParticleField className={cssstages.particles} stage={bgIndex} />
      <div className={`${css.lightBand} ${css.lightBandA}`} aria-hidden="true" />
      <div className={`${css.lightBand} ${css.lightBandB}`} aria-hidden="true" />
      <div className={`${css.lightBand} ${css.lightBandC}`} aria-hidden="true" />
      <div className={css.scanlines} aria-hidden="true" />
      <div className={css.scanBeam} aria-hidden="true" />
      <div className={`${css.geoRing} ${css.geoRingA}`} aria-hidden="true" />
      <div className={`${css.geoRing} ${css.geoRingB}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotA}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotB}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotC}`} aria-hidden="true" />
      <div className={`${css.hudFrame} ${css.hudTl}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudTr}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudBl}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudBr}`} aria-hidden="true"><HudCorner /></div>

      <header className={css.top}>
        <div className={cssstages.brand}>
          <span className={css.brandIcon}><BrandMark size={20} /></span>
          <div className={cssstages.brandText}>
            <span className={cssstages.brandName}>Super Time</span>
            <span className={cssstages.brandSub}>Onboarding · System Boot</span>
          </div>
        </div>
        <nav className={cssstages.tabs} aria-label="启动页导航">
          {ONBOARDING_PAGES.map((p) => {
            const done = state.visited.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`${css.tab}${page === p.id ? ` ${css.tabActive}` : ''}`}
                onClick={() => goPage(p.id)}
                aria-current={page === p.id ? 'page' : undefined}
              >
                {done && page !== p.id ? <span className={cssstages.tabDot} aria-hidden="true" /> : null}
                {p.label}
              </button>
            )
          })}
          {/* 同意这一站只在还缺同意时出现；同意了就直接消失（不必留着让人回来看一份已生效的声明）。 */}
          {consentGate ? (
            <button
              type="button"
              className={`${css.tab}${onConsentStage ? ` ${css.tabActive}` : ''}`}
              onClick={() => goPage(CONSENT_STAGE)}
              aria-current={onConsentStage ? 'page' : undefined}
            >
              隐私同意
            </button>
          ) : null}
          {/* 授权是启动页的最后一站。已授权的老用户点它可直接跳过去，不必重看介绍页。 */}
          <button
            type="button"
            className={`${css.tab}${onLicenseStage ? ` ${css.tabActive}` : ''}`}
            onClick={() => goPage(LICENSE_STAGE)}
            aria-current={onLicenseStage ? 'page' : undefined}
          >
            {licenseOk && !onLicenseStage ? <span className={cssstages.tabDot} aria-hidden="true" /> : null}
            授权验证
          </button>
          {/*
            工具位（主题切换）与页面标签**分开渲染**：它不是一页，跟着整个启动页走。
            混在标签里时它长得和内容页标签一样，用户会以为点了会切走一块内容。
          */}
          <span className={cssstages.tools}>
            <button
              type="button"
              className={cssstages.toolBtn}
              onClick={toggleTheme}
              title={theme === 'light' ? '切换到深色' : '切换到浅色'}
              aria-label="切换主题"
            >
              <span aria-hidden="true">{theme === 'light' ? '🌙' : '☀️'}</span>
              {theme === 'light' ? '深色' : '浅色'}
            </button>
          </span>
        </nav>
      </header>
      <div className={css.neonRule} aria-hidden="true" />

      <main className={cssstages.body} ref={bodyRef}>
        {onConsentStage ? (
          <PrivacyConsentGate onAccepted={acceptConsentHere} onExit={onConsentExit} />
        ) : onLicenseStage ? (
          <div className={css.page}>
            <StageHead
              index={stageIndex}
              title="License 授权验证"
              lead="最后一步。已经拿到厂商签发的许可证就直接导入；没有就先导出「激活请求」交给签发方，换回许可证再来导入。"
            />
            <LicenseAuthPanel
              status={lic}
              compact
              onStatusChange={(next) => {
                setLic(next)
              }}
            />
          </div>
        ) : (
          <>
            {page === 'home' && <HomePage onExplore={() => goPage('features')} versions={versions} />}
            {page === 'features' && <FeaturesPage />}
            {page === 'help' && <HelpPage />}
            {page === 'about' && <AboutPage versions={versions} />}
          </>
        )}
      </main>

      <div className={css.neonRule} aria-hidden="true" />
      <footer className={css.footer}>
        <div className={cssstages.progress}>
          <ProgressRing
            value={gateStage ? gateDone : (isFirstLaunch ? visitedCount : pageIndex + 1)}
            total={gateStage ? gateTotal : ONBOARDING_PAGES.length}
          />
          <div className={cssstages.dots} aria-hidden="true">
            {ONBOARDING_PAGES.map((p) => (
              <span
                key={p.id}
                className={`${css.dot}${state.visited.includes(p.id) ? ` ${css.dotDone}` : ''}${page === p.id ? ` ${css.dotCurrent}` : ''}`}
              />
            ))}
            {/* 同意这一颗点只在还缺同意时存在：同意了它就整颗消失（与标签同一套逻辑）。 */}
            {consentGate ? (
              <span className={`${css.dot}${onConsentStage ? ` ${css.dotCurrent}` : ''}`} />
            ) : null}
            <span className={`${css.dot}${licenseOk ? ` ${css.dotDone}` : ''}${onLicenseStage ? ` ${css.dotCurrent}` : ''}`} />
          </div>
          <span className={cssstages.progressText}>
            {`STAGE ${stageIndex}/0${pageOrder.length}${gateStage ? ` · ${gateLabel}` : (isFirstLaunch ? ` · 已浏览 ${visitedCount}` : '')}`}
          </span>
        </div>
        <div className={cssstages.actions}>
          <span className={cssstages.hint}>{footerHint}</span>
          {state.completed ? (
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={handleSkip} disabled={!canEnter}>
              跳过
            </button>
          ) : null}
          <button type="button" className={css.btn} onClick={goPrev} disabled={pageIndex <= 0}>
            上一页
          </button>
          {onConsentStage ? (
            /* 这一站不给「下一页」：能往前走的只有同意屏自己的「同意并继续」。
               留着一颗点了没用的按钮，比不给按钮更糟（人会以为它坏了）。 */
            null
          ) : pageIndex < pageOrder.length - 1 ? (
            <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={goNext}>
              下一页
            </button>
          ) : (
            <button
              type="button"
              className={`${css.btn} ${css.btnPrimary}`}
              onClick={handleEnter}
              disabled={!ready}
            >
              进入系统
            </button>
          )}
          {pageIndex < pageOrder.length - 1 && ready ? (
            <button type="button" className={css.btn} onClick={handleEnter}>
              进入系统
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  )
}
