/**
 * Super Time 多页面启动页
 *
 * 四页：首页 / 功能引导 / 使用说明 / 关于。
 * 首次启动必须浏览全部页面；再次启动可跳过直接进入主界面。
 * 视觉令牌复用主面板 scifi-theme.css（--nm-*）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// 启动页可能先于 WechatDataPanel 挂载，主题令牌需在此加载
import '../../ui-wechat/src/client/pages/wechat-data/scifi-theme.css'
import '../../ui-wechat/src/client/pages/wechat-data/light-theme.css'
import { getThemeMode, toggleThemeMode } from '../../ui-wechat/src/client/pages/wechat-data/theme.ts'
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
import { Reveal, pickAnim } from './Reveal.tsx'
import { LicenseAuthPanel, isLicenseUsable } from '../license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from '../license/LicenseGate.tsx'
// 隐私同意是启动页的第五站（H14）：直接复用主界面那一屏，文案与守卫都是同一份，
// 不另写一个「精简版同意提示」（两份声明会漂，而这是给用户看的法律性文本）。
import { PrivacyConsentGate } from '../privacy/PrivacyConsentGate.tsx'
// 启动页（含最后一站「授权验证」）也要能看到「有新版本可装 / 许可证即将到期」——
// 更新与到期是主进程的事，与「有没有进主界面」无关。这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '../../ui-wechat/src/client/pages/wechat-data/panels/NoticeBanner.tsx'
import css from './onboarding.module.css'
import { FEATURE_GROUPS, HELP_STEPS, MODULE_ENTRIES, NOTICES, VALUE_PROPS } from './onboarding-content.tsx'

const APP_VERSION = '1.0.7'

/** 启动页四张阶段背景图（public/onboarding → 构建后 ui-dist/onboarding）。 */
const STAGE_BGS = [
  'onboarding/bg-stage-0.png',
  'onboarding/bg-stage-1.png',
  'onboarding/bg-stage-2.png',
  'onboarding/bg-stage-3.png',
] as const

/**
 * 启动页阶段 = 4 个介绍页 + 两道闸门（隐私同意 → 授权验证）。
 *
 * 两站都不是 `OnboardingPageId`：它们不记录「已浏览」（visited 只统计内容页），
 * 却是流程的收尾，也是进入系统的唯一入口。
 */
const LICENSE_STAGE = 'license' as const
/**
 * 隐私同意这一站插在「介绍页」与「授权」之间（H14，2026-09-23 决定）。
 * 先序是有意的：**没有取得同意，就不该先向用户要许可证** —— 授权是商业闸门，
 * 而同意是合规前提，后者不能被前者挡在后面。
 * 反过来排还造成一个可观察的缺陷：机器上没有效许可证时，应用一直停在启动页，
 * 用户永远看不到同意屏（2026-09-23 全新 userData 实测：第一屏 0 个 checkbox）。
 */
const CONSENT_STAGE = 'consent' as const
type OnboardingStage = OnboardingPageId | typeof CONSENT_STAGE | typeof LICENSE_STAGE

function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" fill="currentColor" opacity=".18" />
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="6.2" cy="10.8" r="1" fill="currentColor" />
      <circle cx="9.7" cy="10.8" r="1" fill="currentColor" />
      <circle cx="13.2" cy="10.8" r="1" fill="currentColor" />
    </svg>
  )
}

/** HUD 角落装饰框（左上形态，其余用 CSS 镜像）。 */
function HudCorner(): React.JSX.Element {
  return (
    <svg viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <path d="M4 20V8a4 4 0 0 1 4-4h12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 28h8M20 4v8" stroke="currentColor" strokeWidth="1" opacity=".55" />
      <circle cx="4" cy="20" r="1.6" fill="currentColor" />
      <circle cx="20" cy="4" r="1.6" fill="currentColor" />
    </svg>
  )
}

/** 底栏环形进度：已浏览页数 / 总页数。 */
function ProgressRing({ value, total }: { value: number; total: number }): React.JSX.Element {
  const r = 16
  const c = 2 * Math.PI * r
  const pct = total <= 0 ? 0 : Math.min(1, value / total)
  const offset = c * (1 - pct)
  return (
    <div className={css.progressRing} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00f0ff" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle className={css.ringTrack} cx="20" cy="20" r={r} />
        <circle
          className={css.ringValue}
          cx="20"
          cy="20"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span className={css.ringLabel}>{value}/{total}</span>
    </div>
  )
}

/** 统一舞台页头：阶段序号 + 标题 + 导语，建立阅读层次。 */
function StageHead({
  index,
  title,
  lead,
  align = 'left',
}: {
  index: string
  title: string
  lead: string
  align?: 'left' | 'center'
}): React.JSX.Element {
  return (
    <header className={`${css.stageHead}${align === 'center' ? ` ${css.stageHeadCenter}` : ''}`}>
      <Reveal anim="slide-l" delayMs={20}>
        <div className={css.stageMeta}>
          <span className={css.stageIndex}>{index}</span>
          <span className={css.stageRule} aria-hidden="true" />
          <span className={css.stageTag}>SUPER TIME BOOT</span>
        </div>
        <h2 className={css.stageTitle}>{title}</h2>
      </Reveal>
      <Reveal anim="fade" delayMs={90}>
        <p className={css.stageLead}>{lead}</p>
      </Reveal>
    </header>
  )
}

function HomePage({ onExplore }: { onExplore: () => void }): React.JSX.Element {
  return (
    <div className={css.page}>
      <div className={css.homeLayout}>
        <section className={css.homePrimary}>
          <Reveal anim="slide-l" delayMs={30}>
            <div className={css.heroKicker}>
              <span className={css.kickerDot} aria-hidden="true" />
              LOCAL · WECHAT · INTELLIGENCE
            </div>
            <h1 className={css.heroTitle}>
              把微信数据<br />
              <span className={css.heroTitleAccent}>变成可检索的知识库</span>
            </h1>
          </Reveal>
          <Reveal anim="fade" delayMs={120}>
            <p className={css.heroLead}>
              Super Time 在本机解密并分析你的消息库：会话、社交、资产、资金与隐私一体覆盖，
              并提供 AI 问答与周期总结。数据默认不出机。
            </p>
          </Reveal>

          <div className={css.valueList}>
            {VALUE_PROPS.map((v, i) => (
              <Reveal key={v.title} anim={pickAnim(i, ['slide-l', 'slide-u', 'fade', 'slide-r'])} delayMs={180 + i * 70}>
                <div className={css.valueItem}>
                  <span className={css.valueIndex}>{String(i + 1).padStart(2, '0')}</span>
                  <span className={css.valueIcon}>{v.icon}</span>
                  <div className={css.valueCopy}>
                    <div className={css.valueTitle}>{v.title}</div>
                    <div className={css.valueDesc}>{v.desc}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <aside className={css.homeRail} aria-label="系统概览">
          <div className={css.railLabel}>TELEMETRY</div>
          {[
            { k: 'MODULES', v: '16', h: '侧栏入口 · 30+ 视图' },
            // 这个数字是用户可见的契约声明，必须与 gateway.ts 的 @Remote 数量一致。
            // 它曾长期停在 114 而无人发现 —— 现在由
            // src/backend/tests/api-docs.spec.ts 守着，改了方法面就会在这里转红。
            { k: 'REMOTE API', v: '162', h: '查询 / 导出 / 审计 / 总结' },
            { k: 'RUNTIME', v: 'LOCAL', h: 'utilityProcess 独立后端' },
          ].map((s, i) => (
            <Reveal key={s.k} anim="slide-r" delayMs={140 + i * 90}>
              <div className={css.railStat}>
                <div className={css.railKey}>{s.k}</div>
                <div className={css.railVal}>{s.v}</div>
                <div className={css.railHint}>{s.h}</div>
              </div>
            </Reveal>
          ))}
        </aside>
      </div>

      <section className={css.moduleSection}>
        <Reveal anim="slide-l" delayMs={60}>
          <div className={css.sectionTitle}>
            <span>快速入口</span>
            <span className={css.sectionSub}>进入系统后可从侧栏打开</span>
          </div>
        </Reveal>
        <div className={css.moduleStrip}>
          {MODULE_ENTRIES.map((m, i) => (
            <Reveal key={m.id} anim={pickAnim(i, ['slide-u', 'fade', 'slide-l', 'scale'])} delayMs={i * 50} className={css.moduleCell}>
              <button type="button" className={css.moduleCard} onClick={onExplore}>
                <span className={css.moduleIdx}>{String(i + 1).padStart(2, '0')}</span>
                <span className={css.moduleIcon}>{m.icon}</span>
                <span className={css.moduleName}>{m.name}</span>
                <span className={css.moduleDesc}>{m.desc}</span>
              </button>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  )
}

function FeaturesPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="02"
        title="功能引导"
        lead="按主界面侧栏分组了解能力边界。部分视图在面板内以分段切换进入（如总结中的周期 / 年度）。"
      />
      <div className={css.featureList}>
        {FEATURE_GROUPS.map((g, i) => (
          <Reveal key={g.name} anim={pickAnim(i, ['slide-l', 'slide-r', 'fade', 'slide-u'])} delayMs={i * 55}>
            <article className={css.featureRow}>
              <div className={css.featureNo}>{String(i + 1).padStart(2, '0')}</div>
              <div className={css.featureBody}>
                <div className={css.featureHead}>
                  <span className={css.featureBadge}>{g.icon}</span>
                  <h3 className={css.featureName}>{g.name}</h3>
                </div>
                <p className={css.featureDesc}>{g.desc}</p>
                <div className={css.chipRow}>
                  {g.items.map((it) => (
                    <span key={it} className={css.chip}>{it}</span>
                  ))}
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </div>
  )
}

function HelpPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="03"
        title="使用说明"
        lead="建议按顺序完成首次配置。出错时可到「数据健康 / 操作日志」查看诊断信息。"
      />
      <div className={css.helpLayout}>
        <ol className={css.stepList}>
          {HELP_STEPS.map((s, i) => (
            <Reveal key={s.title} anim="slide-l" delayMs={i * 80}>
              <li className={css.step}>
                <div className={css.stepNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <div className={css.stepTitle}>{s.title}</div>
                  <div className={css.stepBody}>{s.body}</div>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
        <div className={css.noticeCol}>
          <Reveal anim="slide-r" delayMs={40}>
            <div className={css.sectionTitle}><span>注意事项</span></div>
          </Reveal>
          {NOTICES.map((n, i) => (
            <Reveal key={n.title} anim="fade" delayMs={100 + i * 70}>
              <div className={css.notice}>
                <div className={css.noticeTitle}>{n.title}</div>
                <div className={css.noticeBody}>{n.body}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  )
}

function AboutPage({ versions }: {
  versions: { electron?: string; chrome?: string; node?: string } | null
}): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="04"
        title="关于 Super Time"
        lead="项目定位、运行时版本与反馈渠道。"
      />
      <div className={css.aboutLayout}>
        <Reveal anim="slide-l" delayMs={100}>
          <section className={css.aboutBlock}>
            <h3 className={css.aboutTitle}>项目简介</h3>
            <p className={css.aboutText}>
              Super Time 是面向个人用户的本地微信数据分析桌面应用。
              Electron 桌面壳 + React/Vite 前端（NEON MATRIX）+ 独立 utilityProcess 后端，
              提供会话检索、社交图谱、资产盘点、隐私审计与 AI 总结。核心分析默认离线。
            </p>
            <dl className={css.metaList}>
              <div className={css.metaRow}><dt>应用版本</dt><dd>{APP_VERSION}</dd></div>
              <div className={css.metaRow}><dt>Electron</dt><dd>{versions?.electron ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Chromium</dt><dd>{versions?.chrome ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Node</dt><dd>{versions?.node ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>产品名</dt><dd>Super Time</dd></div>
            </dl>
          </section>
        </Reveal>
        <Reveal anim="slide-r" delayMs={180}>
          <section className={css.aboutBlock}>
            <h3 className={css.aboutTitle}>联系方式与反馈</h3>
            <p className={css.aboutText}>
              提交问题或建议时请勿附带密钥或完整聊天内容。
            </p>
            <ul className={css.contactList}>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>项目内反馈</span>
                <span className={css.contactDesc}>导出「操作日志」诊断，连同复现步骤一并提交</span>
              </li>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>在线文档</span>
                <span className={css.contactDesc}>仓库 README 与 docs/compose/spec</span>
              </li>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>隐私承诺</span>
                <span className={css.contactDesc}>默认不上传聊天数据；AI 仅在你配置的接口处理</span>
              </li>
            </ul>
          </section>
        </Reveal>
      </div>
    </div>
  )
}

export interface OnboardingShellProps {
  /** 完成或跳过后进入主界面。 */
  onComplete: () => void
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
  const [versions, setVersions] = useState<{ electron?: string; chrome?: string; node?: string } | null>(null)
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
    const api = (window as any).electronAPI?.license
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
    const api = (window as any).electronAPI
    if (!api?.getVersions) return
    void api.getVersions().then((v: { electron?: string; chrome?: string; node?: string }) => {
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

      {/* 多张背景图：随滚轮切页交叉淡入 */}
      <div className={css.bgStack} aria-hidden="true">
        {STAGE_BGS.map((src, i) => (
          <div
            key={src}
            className={`${css.bgImage}${bgIndex === i ? ` ${css.bgImageOn}` : ''}`}
            style={{ backgroundImage: `url(${src})` }}
          />
        ))}
      </div>
      <div className={css.bgVeil} aria-hidden="true" />
      {/* 阶段光晕：随滚轮切页改变位置与色相 */}
      <div className={css.stageWash} aria-hidden="true" />
      {/* 背景光效层：网格 / 粒子 / 光带 / 扫描 / 几何 / HUD 角 */}
      <div className={css.bgGrid} aria-hidden="true" />
      <ParticleField className={css.particles} stage={bgIndex} />
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
        <div className={css.brand}>
          <span className={css.brandIcon}><BrandMark size={20} /></span>
          <div className={css.brandText}>
            <span className={css.brandName}>Super Time</span>
            <span className={css.brandSub}>Onboarding · System Boot</span>
          </div>
        </div>
        <nav className={css.tabs} aria-label="启动页导航">
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
                {done && page !== p.id ? <span className={css.tabDot} aria-hidden="true" /> : null}
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
            {licenseOk && !onLicenseStage ? <span className={css.tabDot} aria-hidden="true" /> : null}
            授权验证
          </button>
          <button
            type="button"
            className={`${css.tab}`}
            onClick={toggleTheme}
            title={theme === 'light' ? '切换到深色' : '切换到浅色'}
            aria-label="切换主题"
          >
            {theme === 'light' ? '🌙 深色' : '☀️ 浅色'}
          </button>
        </nav>
      </header>
      <div className={css.neonRule} aria-hidden="true" />

      <main className={css.body} ref={bodyRef}>
        {onConsentStage ? (
          <PrivacyConsentGate onAccepted={acceptConsentHere} onExit={onConsentExit} />
        ) : onLicenseStage ? (
          <div className={css.page}>
            <StageHead
              index={stageIndex}
              title="License 授权验证"
              lead="启动页的最后一步：导入厂商签发的许可证即可进入系统主界面。已授权可跳过本页。"
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

      <div className={css.neonRule} aria-hidden="true" />
      <footer className={css.footer}>
        <div className={css.progress}>
          <ProgressRing
            value={gateStage ? gateDone : (isFirstLaunch ? visitedCount : pageIndex + 1)}
            total={gateStage ? gateTotal : ONBOARDING_PAGES.length}
          />
          <div className={css.dots} aria-hidden="true">
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
          <span className={css.progressText}>
            {`STAGE ${stageIndex}/0${pageOrder.length}${gateStage ? ` · ${gateLabel}` : (isFirstLaunch ? ` · 已浏览 ${visitedCount}` : '')}`}
          </span>
        </div>
        <div className={css.actions}>
          <span className={css.hint}>{footerHint}</span>
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
