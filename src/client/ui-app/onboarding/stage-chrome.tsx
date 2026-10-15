/**
 * 启动页各屏共用的**舞台零件**：品牌标、HUD 角、进度环、统一页头。
 *
 * 2026-10-12 从 `OnboardingShell.tsx` 拆出来（那座文件 880 行，逼近本仓 1000 行的
 * 硬棘轮，而「再改一屏」就得先把它拆小）。这些零件被四个内容页与壳共用，
 * 所以独立成文件；它们只依赖两份 CSS，不依赖壳的任何状态。
 */
import React from 'react'
import { Reveal } from './Reveal.tsx'
import css from './onboarding.module.css'
import cssstages from './onboarding-stages.module.css'

/** 品牌标（一只对话气泡 —— 数据来源是微信，但产品名是 Super Time）。 */
export function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
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
export function HudCorner(): React.JSX.Element {
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
export function ProgressRing({ value, total }: { value: number; total: number }): React.JSX.Element {
  const r = 16
  const c = 2 * Math.PI * r
  const pct = total <= 0 ? 0 : Math.min(1, value / total)
  const offset = c * (1 - pct)
  return (
    <div className={cssstages.progressRing} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00f0ff" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle className={cssstages.ringTrack} cx="20" cy="20" r={r} />
        <circle
          className={cssstages.ringValue}
          cx="20"
          cy="20"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span className={cssstages.ringLabel}>{value}/{total}</span>
    </div>
  )
}

/**
 * 统一舞台页头：阶段序号 + 标题 + 导语，建立阅读层次。
 *
 * 02–04 三页用它（首页是 hero，不用页头）；两道闸门页也用 ——
 * 于是「现在在第几站、这一站讲什么」在全部六站里是同一套读法。
 */
export function StageHead({
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
    <header className={`${cssstages.stageHead}${align === 'center' ? ` ${cssstages.stageHeadCenter}` : ''}`}>
      <Reveal>
        <div className={cssstages.stageMeta}>
          <span className={css.stageIndex}>{index}</span>
          <span className={cssstages.stageRule} aria-hidden="true" />
          <span className={cssstages.stageTag}>SUPER TIME BOOT</span>
        </div>
        <h2 className={cssstages.stageTitle}>{title}</h2>
      </Reveal>
      <Reveal>
        <p className={cssstages.stageLead}>{lead}</p>
      </Reveal>
    </header>
  )
}
