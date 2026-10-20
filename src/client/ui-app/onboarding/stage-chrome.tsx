/**
 * 启动页各屏共用的**统一页头**。
 *
 * 2026-10-12 从 `OnboardingShell.tsx` 拆出来；2026-10-19 微信化改版只留下页头这一件
 * 舞台零件 —— 原来的品牌标 / HUD 角 / 环形进度环都是霓虹装饰（HUD 角与渐变进度环
 * 尤其不属于微信的克制语言），随背景光效层一并删除。
 *
 * 页头只做两件事：**这一站叫什么**、**一句话说明**。序号与进度交给底栏那一行
 * 「第 X 步 / 共 N 步」，不再在页头重复一遍页码。
 */
import React from 'react'
import cssstages from './onboarding-stages.module.css'

export function StageHead({ title, lead }: { title: string; lead: string }): React.JSX.Element {
  return (
    <header className={cssstages.stageHead}>
      <h2 className={cssstages.stageTitle}>{title}</h2>
      <p className={cssstages.stageLead}>{lead}</p>
    </header>
  )
}
