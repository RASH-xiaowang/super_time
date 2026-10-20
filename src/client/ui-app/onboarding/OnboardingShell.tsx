/**
 * Super Time 多页面启动页（2026-10-19 微信化改版）
 *
 * 四页：首页 / 功能引导 / 使用说明 / 关于；之后是隐私同意与授权两道闸门。
 * 首次启动必须浏览全部介绍页；再次启动可跳过直接进入主界面。
 *
 * 版式（微信定调：简洁、克制、一致）：
 *   · 自适应单列 —— 内容列 max-width 760、超出上下滚动，不再有 1180×760 的固定舞台
 *     与等比缩放（那套「演示文稿感」已被删除）；
 *   · 只有一处品牌名（自绘标题栏），启动页顶部只留页面导航与主题切换；
 *   · 页脚只留「上一步 / 下一步（或进入系统）」+ 一行「第 X 步 / 共 N 步」，
 *     删掉进度环、进度点与 `STAGE 01/04` 这类英文装饰标签；
 *   · 背景/粒子/HUD/扫描线/渐变文字全部移除，只保留白卡 + 灰底 + 微信绿主按钮。
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
import { LicenseAuthPanel, isLicenseUsable } from '../license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from '../license/LicenseGate.tsx'
// 隐私同意是启动页的第五站（H14）：直接复用主界面那一屏，文案与守卫都是同一份，
// 不另写一个「精简版同意提示」（两份声明会漂，而这是给用户看的法律性文本）。
import { PrivacyConsentGate } from '../privacy/PrivacyConsentGate.tsx'
import { PRIVACY_VERSION } from '../privacy/consent.ts'
// 启动页（含最后一站「授权验证」也要能看到「有新版本可装 / 许可证即将到期」——
// 更新与到期是主进程的事，与「有没有进主界面」无关。这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '@deepseek-ai/dsh-client-ui-wechat/notice'
import css from './onboarding.module.css'
import cssstage from './onboarding-stage.module.css'
import cssstages from './onboarding-stages.module.css'
// 2026-10-12 拆屏：四个内容页与舞台零件各归各的文件，本文件只留状态机与外壳。
// 四页仍然从这里**转出导出** —— `scripts/onboarding-ssr.tsx` 按这个路径导入它们，
// 拆分因此不改变那份冒烟的用法（也别改：它是这些页面唯一的渲染级判据）。
import { StageHead } from './stage-chrome.tsx'
import { AboutPage } from './pages/AboutPage.tsx'
import { FeaturesPage } from './pages/FeaturesPage.tsx'
import { HelpPage } from './pages/HelpPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { CONSENT_STAGE, LICENSE_STAGE, type RuntimeVersions } from './runtime.ts'

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
  // 下一帧才跑（见上面）。按 0 兜住，否则那一帧页码会显示成 00。
  const pageIndex = Math.max(0, pageOrder.indexOf(page))

  // 每次进入启动页都检测 License（含过期/无效强制授权）
  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI?.license
    if (!api?.status) {
      setLic({ state: 'error', licensed: false, reason: 'license_api_missing' })
      return
    }
    void api.status().then((s: LicenseStatus) => {
      if (!cancelled) setLic(s)
    }).catch((err: Error) => {
      if (!cancelled) setLic({ state: 'error', licensed: false, reason: err.message })
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

  const toggleTheme = useCallback(() => {
    toggleThemeMode()
    setTheme(getThemeMode())
  }, [])

  return (
    <div className={cssstage.stage} data-theme={theme}>
      <div className={cssstage.shell}>
        {/* 主动提醒（右下角悬浮）：启动页上也要能看到「有新版本可装 / 许可证即将到期」。
            同意站除外 —— `PrivacyConsentGate` 自己带一份，两个 fixed 堆叠在同一角上会叠成
            两张一样的卡（点掉一张还剩一张，看起来像「关闭」坏了）。 */}
        {!onConsentStage ? <NoticeBanner /> : null}

        <header className={cssstage.top}>
          <div className={cssstage.topInner}>
            <nav className={cssstage.tabs} aria-label="启动页导航">
              {ONBOARDING_PAGES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${css.tab}${page === p.id ? ` ${css.tabActive}` : ''}`}
                  onClick={() => goPage(p.id)}
                  aria-current={page === p.id ? 'page' : undefined}
                >
                  {p.label}
                </button>
              ))}
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
                授权验证
              </button>
            </nav>
            <button
              type="button"
              className={cssstage.toolBtn}
              onClick={toggleTheme}
              title={theme === 'light' ? '切换到深色' : '切换到浅色'}
              aria-label="切换主题"
            >
              {theme === 'light' ? '深色' : '浅色'}
            </button>
          </div>
        </header>

        <main className={cssstage.body} ref={bodyRef}>
          {onConsentStage ? (
            /* 同意站：页头交给统一的 `StageHead`，同意屏自己只管「单列滚动 + 底部同意条」。
               ⚠️ 这里不用 `.page`：同意屏内部需要一条确定的高度链
               （`.body` → `.consentPage` → `.shell` → 滚动区 → 同意条），
               `.consentPage` 的 `height: 100%` 负责把它钉在内容区高度上。 */
            <div className={css.consentPage}>
              <StageHead
                title="隐私与数据边界"
                lead={`开始之前，请确认你了解它会读什么、会往哪里发。完整声明见 docs/PRIVACY.md（声明版本 v${PRIVACY_VERSION}）。`}
              />
              {/* `embedded`：页头由上面的 StageHead 给，本组件只排正文 + 同意条。
                  独立整屏（声明升版后的重新同意）走默认值，自己渲染页头并填满 #root。 */}
              <PrivacyConsentGate embedded onAccepted={acceptConsentHere} onExit={onConsentExit} />
            </div>
          ) : onLicenseStage ? (
            /* 授权站与同意站同一套骨架：`StageHead` 页头 + 铺满型容器。
               面板内部两栏（左栏状态 / 右栏操作），这里只负责给它一条确定的高度链。 */
            <div className={`${css.consentPage} ${css.widePage}`}>
              <StageHead
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
              {page === 'home' && <HomePage onExplore={() => goPage('features')} />}
              {page === 'features' && <FeaturesPage />}
              {page === 'help' && <HelpPage />}
              {page === 'about' && <AboutPage versions={versions} />}
            </>
          )}
        </main>

        <footer className={cssstage.footer}>
          <div className={cssstage.footerInner}>
            <span className={cssstages.progressText}>{`第 ${pageIndex + 1} 步 / 共 ${pageOrder.length} 步`}</span>
            <div className={cssstages.actions}>
              <button
                type="button"
                className={`${css.btn} ${css.btnGhost}`}
                onClick={goPrev}
                disabled={pageIndex <= 0}
              >
                上一步
              </button>
              {onConsentStage ? (
                /* 这一站不给「下一步」：能往前走的只有同意屏自己的「同意并继续」。
                   留着一颗点了没用的按钮，比不给按钮更糟（人会以为它坏了）。 */
                null
              ) : pageIndex < pageOrder.length - 1 ? (
                <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={goNext}>
                  下一步
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
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
