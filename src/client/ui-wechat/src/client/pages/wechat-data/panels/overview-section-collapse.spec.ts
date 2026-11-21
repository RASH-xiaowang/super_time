/**
 * 「数据总览不许再有折叠展开按钮」（2026-11-19）。
 *
 * ## 背景
 *
 * 用户原话：「删除数据总览界面所有的折叠展开按钮，当前不需要这个功能了」。
 *
 * 这里**替换**了原先的 `overview-section-collapse.spec.ts`（那份用真渲染 + 点击
 * 验证折叠语义）。功能被移除后，那份用例测的是不存在的东西 —— 留着只会让
 * 后来的人以为折叠还能用。现在换成反向守卫：**折叠必须彻底不在**。
 *
 * 「彻底」指的是整套：按钮、`aria-expanded`、`useState(collapsed)`、
 * `hidden={collapsed}` 接收端、localStorage 键、以及专为它写的 CSS 类。
 * 只删按钮会留下"点了没反应"的死代码，那比留一个能用的按钮更难查。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')

const parts = read('overview-parts.tsx')
const sections = read('overview-sections.tsx')
const panel = read('overview-panel.tsx')
const css = read('overview.module.css')
/** 剥注释后断言（说明里会引用被删的旧名字）。 */
const partsCode = parts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('数据总览：折叠功能已彻底移除', () => {
  it('卡片外壳里没有折叠按钮与折叠状态', () => {
    expect(partsCode, 'OvSection 里还有折叠状态').not.toContain('collapsed')
    expect(partsCode, 'OvSection 里还有折叠按钮').not.toContain('ovCollapse')
    expect(partsCode, 'OvSection 里还有 aria-expanded').not.toContain('aria-expanded')
    expect(partsCode, 'OvSection 里还有 hidden={collapsed} 接收端').not.toContain('hidden={')
  })

  it('折叠用的 localStorage 键与读写函数已删除', () => {
    expect(partsCode, '还有 OV_COLLAPSED_KEY').not.toContain('OV_COLLAPSED_KEY')
    expect(partsCode, '还有 readCollapsed').not.toContain('readCollapsed')
  })

  it('「更多分析」折叠条已删除（内容改为直接进画布）', () => {
    expect(sections, '还有 MoreAnalysis 组件').not.toContain('export function MoreAnalysis')
    expect(panel, '还在 import MoreAnalysis').not.toContain('MoreAnalysis,')
    expect(panel, '面板里还在用 MoreAnalysis').not.toContain('<MoreAnalysis')
  })

  it('CSS 里没有折叠按钮与折叠条的样式残留', () => {
    expect(cssCode, '还有 .ovCollapse 样式').not.toContain('.ovCollapse')
    expect(cssCode, '还有 .moreToggle 样式').not.toContain('.moreToggle')
    expect(cssCode, '还有 .moreAnalysis 样式').not.toContain('.moreAnalysis')
  })

  it('防空转：卡片外壳确实还在（否则上面的判据恒真）', () => {
    expect(partsCode, '找不到 OvSection').toContain('export function OvSection')
    expect(partsCode, '卡头丢了').toContain('<CanvasCard')
    // 卡头右侧仍允许放调用点自己的动作（如「详情 →」）。
    expect(partsCode, 'action 透传丢了').toContain('extra: action')
  })

  it('CSS 仍能被解析（删规则时别把文件删坏）', () => {
    const parsed = postcss.parse(css, { from: join(HERE, 'overview.module.css') })
    expect(parsed.nodes.length, '规则数异常少 ⇒ 文件可能被删坏').toBeGreaterThan(30)
  })
})
