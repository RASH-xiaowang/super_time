/**
 * 启动页第一屏：**首页**（hero + 三步开始 + 高频问法 + 系统概览）。
 *
 * 2026-10-12 从 `OnboardingShell.tsx` 拆出（那一座 880 行，再改任何一屏都会撞 1000 行棘轮）。
 * 拆分不改变行为：壳仍然只按 `page` 渲染其中一个，`scripts/onboarding-ssr.tsx`
 * 经由壳的转出导出拿到全部四页。
 *
 * 信息架构（首屏要同时回答「这是什么 / 我现在该干什么 / 它能帮我做什么」）：
 *   左列 hero + 三步开始 → 中列高频问法（点开直达对应分组）→ 右列系统概览（真事实）
 */
import React from 'react'
import { Reveal } from '../Reveal.tsx'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FIRST_RUN_STEPS, QUESTION_CARDS } from '../onboarding-content.tsx'
import type { RuntimeVersions } from '../runtime.ts'

/** 一次「高频问法」点击：跳去功能引导那一页（把问句对上侧栏分组）。 */
export interface HomePageProps {
  onExplore: () => void
  /** 主进程下发的运行时事实（SSR / 还没回话时为 null，页面照常渲染）。 */
  versions?: RuntimeVersions | null
}

export function HomePage({ onExplore, versions }: HomePageProps): React.JSX.Element {
  return (
    <div className={css.page}>
      <div className={cssstages.homeLayout}>
        <section className={cssstages.homePrimary}>
          <Reveal>
            <div className={cssstages.heroKicker}>
              <span className={css.kickerDot} aria-hidden="true" />
              LOCAL · WECHAT · INTELLIGENCE
            </div>
            <h1 className={cssstages.heroTitle}>
              把本机微信数据<br />
              <span className={cssstages.heroTitleAccent}>变成可检索、可问答的知识库</span>
            </h1>
          </Reveal>
          <Reveal>
            <p className={cssstages.heroLead}>
              解密、检索、统计与导出全部在这台机器上完成；只有你主动配置并调用 AI 时，
              检索到的片段才会发给你自己填的模型接口。下面先说怎么开始，再说它常被用来回答什么。
            </p>
          </Reveal>

          <Reveal>
            <div className={css.sectionTitle}>
              <span>三步开始</span>
              <span className={cssstages.sectionSub}>第一次打开按这个顺序走</span>
            </div>
          </Reveal>
          <div className={cssstages.valueList}>
            {FIRST_RUN_STEPS.map((v, i) => (
              <Reveal key={v.title}>
                <div className={css.valueItem}>
                  <span className={css.valueIndex}>{String(i + 1).padStart(2, '0')}</span>
                  <span className={cssstages.valueIcon}>{v.icon}</span>
                  <div>
                    <div className={css.valueTitle}>{v.title}</div>
                    <div className={cssstages.valueDesc}>{v.desc}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <aside className={cssstages.homeRail} aria-label="系统概览">
          <div className={cssstages.railLabel}>TELEMETRY</div>
          {[
            { k: 'MODULES', v: '17', h: '侧栏入口 · 38 个可路由页签' },
            // 这个数字是用户可见的契约声明，必须与 gateway*.ts 的 @Remote 数量一致。
            // 它曾长期停在 114 而无人发现 —— 现在由
            // src/backend/tests/api-docs.spec.ts 守着，改了方法面就会在这里转红。
            { k: 'REMOTE API', v: '195', h: '查询 / 导出 / 审计 / 总结 / 本地决策' },
            { k: 'RUNTIME', v: 'LOCAL', h: 'utilityProcess 独立后端 · 本机 SQLite' },
            /**
             * 平台/架构取**运行时事实**（主进程 `app:versions` 下发），不写死。
             * 2026-10-12：这一行原先只有一句写死的 "LOCAL"，把已经下发的平台事实丢掉了；
             * 现在 Electron / Node 版本也在同一行给出（本应用只支持 Windows x64，
             * 装错机器时这里一眼看得出来）。
             */
            {
              k: 'PLATFORM',
              v: versions?.platform ? `${versions.platform} · ${versions.arch ?? '—'}` : '—',
              h: `Electron ${versions?.electron ?? '—'} · Node ${versions?.node ?? '—'}`,
            },
          ].map((s, i) => (
            <Reveal key={s.k}>
              <div className={cssstages.railStat}>
                <div className={cssstages.railKey}>{s.k}</div>
                <div className={cssstages.railVal}>{s.v}</div>
                <div className={cssstages.railHint}>{s.h}</div>
              </div>
            </Reveal>
          ))}
        </aside>
      </div>

      <section className={cssstages.moduleSection}>
        <Reveal>
          <div className={css.sectionTitle}>
            <span>它常被用来回答这些问题</span>
            <span className={cssstages.sectionSub}>点开看每个功能落在侧栏哪一组</span>
          </div>
        </Reveal>
        <div className={cssstages.moduleStrip}>
          {QUESTION_CARDS.map((m, i) => (
            <Reveal key={m.id} className={cssstages.moduleCell}>
              <button type="button" className={css.moduleCard} onClick={onExplore}>
                <span className={cssstages.moduleIdx}>{String(i + 1).padStart(2, '0')}</span>
                <span className={css.moduleIcon}>{m.icon}</span>
                <span className={css.moduleName}>{m.name}</span>
                <span className={cssstages.moduleDesc}>{m.desc}</span>
              </button>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  )
}
