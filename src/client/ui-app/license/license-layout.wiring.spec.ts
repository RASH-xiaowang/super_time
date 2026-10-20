/**
 * 授权验证面板的排版守卫（2026-10-17 重设计：用户要求「分为两列」）。
 *
 * 为什么需要它：授权面板是**启动页最后一站**，它的排版错了没有任何构建或类型检查会报，
 * 症状只有对着那一屏才看得见（本轮实测：单列 560px 宽、817px 高、右侧 550px 全空、
 * 内容溢出 107px 要滚动、`StageHead` 被滚出视野）。
 *
 * 三条不变量：
 *   ① **两栏**（左栏状态 / 右栏操作），两栏各自滚动；
 *   ② **字号与启动页对齐**（页头 26 / 正文 13 / 小字 11.5）；
 *   ③ **嵌入启动页时不重复页头**（`StageHead` 已给「License 授权验证」）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(HERE, 'license-gate.module.css'), 'utf8')
const panelSrc = readFileSync(join(HERE, 'LicenseAuthPanel.tsx'), 'utf8')
const shellSrc = readFileSync(join(HERE, '..', 'onboarding', 'OnboardingShell.tsx'), 'utf8')
const stagesCss = readFileSync(join(HERE, '..', 'onboarding', 'onboarding-stages.module.css'), 'utf8')

/** 剥掉 CSS 注释（保留换行）。断言前必须剥 —— 注释里常写着历史成因（如被否掉的旧值）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 取某个类名的声明块（到第一个右花括号），**已剥注释**。 */
function block(sel: string): string {
  const at = css.indexOf(`${sel} {`)
  expect(at, `CSS 里找不到 ${sel} 规则`).toBeGreaterThan(-1)
  return stripComments(css.slice(at, css.indexOf('}', at) + 1))
}

describe('授权面板：两栏布局（2026-10-17 用户要求「分为两列」）', () => {
  it('① 两栏等宽，且两栏各自滚动', () => {
    expect(block('.cols'), '必须是两栏').toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/)
    expect(block('.col'), '两栏必须各自滚动').toMatch(/overflow-y:\s*auto/)
    expect(block('.col'), '两栏必须能收缩（否则内容把行撑开，滚动永不触发）').toMatch(/min-height:\s*0/)
  })

  it('② 面板铺满内容区（不许再限宽 560px 让右侧空着）', () => {
    const embed = block('.embed')
    expect(embed, '嵌入模式必须铺满').toMatch(/width:\s*100%/)
    expect(embed, '嵌入模式不许再限宽 560px').not.toMatch(/max-width:\s*560px/)
  })

  it('③ 字号与启动页对齐（页头 26 / 正文 13 / 小字 11.5）', () => {
    // 启动页的基准（改那边要同步改这里）
    expect(stagesCss, '启动页导语基准变了，本判据要跟着改').toMatch(/\.stageLead\s*\{[^}]*font-size:\s*13px/)
    expect(block('.lead'), '导语必须与启动页同刻度 13px').toMatch(/font-size:\s*13px/)
    expect(block('.embedTitle'), '状态标题是次级标题（20px），不许与页头 26px 抢层级').toMatch(/font-size:\s*20px/)
    expect(block('.faqBody'), '常见问题正文 11.5px').toMatch(/font-size:\s*11\.5px/)
  })

  it('④ 嵌入启动页时不重复页头（StageHead 已给「License 授权验证」）', () => {
    // 两行同名标题叠在一起只是噪音
    expect(panelSrc, 'compact 时不许再渲染 brand 行').toMatch(/compact \? null : <div className=\{gateCss\.brand\}>/)
  })

  it('⑤ 授权站与同意站同一套骨架（StageHead + consentPage）', () => {
    const at = shellSrc.indexOf('{onConsentStage ? (')
    expect(at, '找不到同意站分支').toBeGreaterThan(-1)
    const branch = shellSrc.slice(at, at + 2400)
    expect(branch, '授权站必须用统一的 StageHead').toContain('title="License 授权验证"')
    expect(branch, '授权站必须用 consentPage 容器（确定的高度链）').toContain('css.consentPage')
  })
})
