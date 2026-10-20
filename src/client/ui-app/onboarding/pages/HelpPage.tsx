/**
 * 启动页第三屏：**首次配置**（四步可执行步骤 + 三条常见问题）。
 *
 * 每一步都必须写「做完应看到什么」—— 没有它，用户不知道该继续还是该回头排查。
 * 这条不变量由 `scripts/onboarding-ssr.tsx` 钉住（≥4 条「做完应看到」）。
 *
 * 微信化改版：删掉与首页重复的「三步开始」叙事（首页只留动作速览，这里才是完整清单），
 * 常见问题从 5 条压到 3 条（图片不显示 / 数据在哪删 / 首次很慢），注意事项并入正文。
 */
import React from 'react'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FAQ, HELP_STEPS } from '../onboarding-content.tsx'
import { StageHead } from '../stage-chrome.tsx'

export function HelpPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        title="首次配置"
        lead="四步走完就能用起来。每一步都写明「做完应看到什么」，对不上时去「操作日志 / 隐私体检」找原因。"
      />
      <ol className={css.stepList}>
        {HELP_STEPS.map((s, i) => (
          <li key={s.title} className={css.step}>
            <div className={css.stepNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
            <div>
              <div className={cssstages.stepTitle}>{s.title}</div>
              <div className={cssstages.stepBody}>{s.body}</div>
              <div className={cssstages.stepDone}>{s.done}</div>
            </div>
          </li>
        ))}
      </ol>

      <section className={cssstages.pageSection}>
        <div className={css.sectionTitle}><span>常见问题</span></div>
        <div className={cssstages.faqList}>
          {FAQ.map((f) => (
            <div key={f.title} className={cssstages.notice}>
              <div className={cssstages.noticeTitle}>{f.title}</div>
              <div className={cssstages.noticeBody}>{f.body}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
