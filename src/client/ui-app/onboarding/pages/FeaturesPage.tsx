/**
 * 启动页第二屏：**功能引导**（按侧栏真实分组逐组对齐）。
 *
 * 分组名与顺序的真源是 `nav-config.ts` 的 `NAV_GROUPS` ——
 * `nav-onboarding-drift.wiring.spec.ts` 与 `scripts/onboarding-ssr.tsx`
 * 会逐组同序比对，改一边不改另一边会红。
 *
 * 微信化改版：一行一组（序号 + 组名 + 一句话 + ≤5 个真实入口），
 * 不再用两栏等权卡片 + 三十多个胶囊把一屏塞满。
 */
import React from 'react'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FEATURE_GROUPS } from '../onboarding-content.tsx'
import { StageHead } from '../stage-chrome.tsx'

export function FeaturesPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        title="功能引导"
        lead="按主界面侧栏的五个分组逐条对齐。标「（分段）」的是同一个入口里用顶部分段条切换的视图 —— 侧栏只占一个条目，不必找第二个入口。"
      />
      <div className={css.featureList}>
        {FEATURE_GROUPS.map((g, i) => (
          <article key={g.name} className={css.featureRow}>
            <div className={css.featureNo}>{String(i + 1).padStart(2, '0')}</div>
            <div>
              <div className={cssstages.featureHead}>
                <span className={cssstages.featureBadge} aria-hidden="true">{g.icon}</span>
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
        ))}
      </div>
    </div>
  )
}
