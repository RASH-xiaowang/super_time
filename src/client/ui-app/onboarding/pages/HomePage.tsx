/**
 * 启动页第一屏：**首页**（一句话是什么 + 三步开始 + 两条高频问法 + 本机规模）。
 *
 * 微信化改版（2026-10-19）：
 *   · 删掉右侧 `TELEMETRY` rail 与四个开发者指标 —— 首屏是给用户看的，不是技术演示；
 *     只在本机规模那一行保留两个**用户可见的契约计数**（MODULES / REMOTE API），
 *     它们仍由 `docs-consistency.wiring.spec.ts` 与 `src/backend/tests/api-docs.spec.ts`
 *     与真源现算比对，改这里会红；
 *   · 高频问法 4 张 → 2 张（其余同类示例放「使用说明」的常见问题）；
 *   · 渐变标题、发光图标、逐条浮现入场全部删除。
 */
import React from 'react'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FIRST_RUN_STEPS, QUESTION_CARDS } from '../onboarding-content.tsx'

/**
 * 本机规模（用户可见的契约声明，从真源现算比对，不随手改）：
 *   · `MODULES`  = `nav-config.ts` 里侧栏正文渲染的入口数；
 *   · `REMOTE API` = `docs/API.md` 里 `@Remote` 方法数。
 * `docs-consistency.wiring.spec.ts` / `src/backend/tests/api-docs.spec.ts` / `scripts/onboarding-ssr.tsx`
 * 三处都按这两个数字现算，改了它会一起红。
 */
const FACTS = [
  { k: 'MODULES', v: '15' },
  { k: 'REMOTE API', v: '218' },
] as const

/** 一次「高频问法」点击：跳去功能引导那一页（把问句对上侧栏分组）。 */
export interface HomePageProps {
  onExplore: () => void
}

export function HomePage({ onExplore }: HomePageProps): React.JSX.Element {
  return (
    <div className={css.page}>
      <header className={cssstages.hero}>
        <h1 className={cssstages.heroTitle}>把本机微信数据变成可检索、可问答的知识库</h1>
        <p className={cssstages.heroLead}>
          解密、检索、统计与导出全部在这台机器上完成；只有你配置并调用 AI 时，
          检索到的片段才会发给你自己填的模型接口。
        </p>
      </header>

      <section className={cssstages.pageSection}>
        <div className={css.sectionTitle}>
          <span>三步开始</span>
          <span className={cssstages.sectionSub}>第一次打开按这个顺序走</span>
        </div>
        <ol className={cssstages.valueList}>
          {FIRST_RUN_STEPS.map((v, i) => (
            <li key={v.title} className={css.valueItem}>
              <div className={css.valueHead}>
                <span className={cssstages.valueIcon} aria-hidden="true">{v.icon}</span>
                <span className={css.valueIndex}>{String(i + 1).padStart(2, '0')}</span>
                <span className={css.valueTitle}>{v.title}</span>
              </div>
              <div className={cssstages.valueDesc}>{v.desc}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className={cssstages.pageSection}>
        <div className={css.sectionTitle}>
          <span>它常被用来回答这些问题</span>
          <span className={cssstages.sectionSub}>点开看每个功能落在侧栏哪一组</span>
        </div>
        <div className={cssstages.moduleStrip}>
          {QUESTION_CARDS.map((m) => (
            <button key={m.id} type="button" className={css.moduleCard} onClick={onExplore}>
              <span className={css.moduleIcon} aria-hidden="true">{m.icon}</span>
              <span className={css.moduleName}>{m.name}</span>
              <span className={cssstages.moduleDesc}>{m.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <p className={cssstages.localLine}>
        本机离线运行 ·{' '}
        {FACTS.map((f) => (
          <span key={f.k} className={cssstages.localFact}>
            {f.k} <b>{f.v}</b>
          </span>
        ))}
        {' '}· 39 个可路由页签
      </p>
    </div>
  )
}
