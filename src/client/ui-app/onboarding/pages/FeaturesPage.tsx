/**
 * 启动页第二屏：**功能引导**（按侧栏真实分组逐组对齐）。
 *
 * 分组名与顺序的真源是 `nav-config.ts` 的 `NAV_GROUPS` ——
 * `nav-onboarding-drift.wiring.spec.ts` 与 `scripts/onboarding-ssr.tsx`
 * 会逐组同序比对，改一边不改另一边会红。
 */
import React from 'react'
import { Reveal } from '../Reveal.tsx'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FEATURE_GROUPS } from '../onboarding-content.tsx'
import { StageHead } from '../stage-chrome.tsx'

export function FeaturesPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="02"
        title="功能引导"
        lead="按主界面侧栏的分组逐条对齐。标「（分段）」的是同一个入口内用顶部分段条切换的视图 —— 侧栏只占一个条目，不必找第二个入口。"
      />
      <div className={css.featureList}>
        {FEATURE_GROUPS.map((g, i) => (
          <Reveal key={g.name}>
            <article className={css.featureRow}>
              <div className={css.featureNo}>{String(i + 1).padStart(2, '0')}</div>
              <div>
                <div className={cssstages.featureHead}>
                  <span className={cssstages.featureBadge}>{g.icon}</span>
                  <h3 className={cssstages.featureName}>{g.name}</h3>
                </div>
                <p className={cssstages.featureDesc}>{g.desc}</p>
                <div className={cssstages.chipRow}>
                  {g.items.map((it) => (
                    <span key={it} className={cssstages.chip}>{it}</span>
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
