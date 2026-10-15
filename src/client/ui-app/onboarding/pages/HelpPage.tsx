/**
 * 启动页第三屏：**使用说明**（四步可执行步骤 + 常见问题 + 注意事项）。
 *
 * 每一步都必须写「做完应看到什么」—— 没有它，用户不知道该继续还是该回头排查。
 * 这条不变量由 `scripts/onboarding-ssr.tsx` 钉住（≥4 条「做完应看到」）。
 */
import React from 'react'
import { Reveal } from '../Reveal.tsx'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { FAQ, HELP_STEPS, NOTICES } from '../onboarding-content.tsx'
import { StageHead } from '../stage-chrome.tsx'

export function HelpPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="03"
        title="使用说明"
        lead="四步走完就能用起来。每一步都写明「做完应看到什么」，对不上时去「操作日志 / 隐私体检」找原因。"
      />
      <div className={cssstages.helpLayout}>
        <ol className={css.stepList}>
          {HELP_STEPS.map((s, i) => (
            <Reveal key={s.title}>
              <li className={css.step}>
                <div className={css.stepNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <div className={cssstages.stepTitle}>{s.title}</div>
                  <div className={cssstages.stepBody}>{s.body}</div>
                  <div className={cssstages.stepDone}>{s.done}</div>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
        <div className={cssstages.noticeCol}>
          <Reveal>
            <div className={css.sectionTitle}><span>常见问题</span></div>
          </Reveal>
          {FAQ.map((f) => (
            <Reveal key={f.title}>
              <div className={cssstages.notice}>
                <div className={cssstages.noticeTitle}>{f.title}</div>
                <div className={cssstages.noticeBody}>{f.body}</div>
              </div>
            </Reveal>
          ))}
          <Reveal>
            <div className={css.sectionTitle}><span>注意事项</span></div>
          </Reveal>
          {NOTICES.map((n) => (
            <Reveal key={n.title}>
              <div className={cssstages.notice}>
                <div className={cssstages.noticeTitle}>{n.title}</div>
                <div className={cssstages.noticeBody}>{n.body}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  )
}
