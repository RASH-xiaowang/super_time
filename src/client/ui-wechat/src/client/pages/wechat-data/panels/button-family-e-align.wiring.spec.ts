/**
 * P1 族 E「独立表单按钮」共享几何对齐（2026-09-28）。
 *
 * ── 为什么需要这条守卫 ──────────────────────────────────────────
 * `docs/BUTTON-CONVERGENCE-FEASIBILITY.md` 把 69 个真按钮归成 6 个语义族，
 * 其中族 E（`.optApply` / `.optDismiss` / `.optBtn` / `.loadMore`）是「真·表单按钮」——
 * 最接近 `Button` 组件的那一族。
 *
 * 但**「换 Button 组件」这个方向经 P1 实测否掉了**：
 *   · `Button` 只有 6 variant，**没有一个能表达 `.optApply` 的青色主操作语义**
 *     （`background: --nm-cyan-10` + `color: --nm-cyan-text` + `1px --nm-cyan` 边）；
 *   · 5 个类的几何**没有一种能零位移对接** `Button`（逐一算过：
 *     `.optApply` 用 `pill` 高 +2px；`.optBtn` 用 `outline sm` 左右 -2px、边框 1px→0.5px；
 *     `.loadMore` 用 `pill` 高 +2px 且左右 -2px）。
 *
 * 于是 P1 改为**「同族内共享几何对齐」**——这才是「收敛」的正确形态：
 * **统一的是同族之间的一致性，不是跨族之间的一致性。**
 *
 * ── 对齐目标（族 E 五件套）────────────────────────────────────
 *   padding: 6px 14px
 *   border-width: 1px
 *   border-radius: var(--nm-r-pill)
 *   font-size: 12px
 * 颜色语义**各自保留**（`.optApply` 青 / `.optDismiss` 描边 / `.loadMore` 卡片底）。
 *
 * ── 为什么 `.optBtn` 是豁免项（登记在案）────────────────────────
 * 它用 `height: 28px` 固定高，且在 `@media (max-width: 680px)` 里抬到 `36px`
 * —— 那是 **WCAG 2.2 SC 2.5.8 的触屏手指标**（相邻目标 ≥24px），是**无障碍设计意图**，
 * 不是随手写的值。改 `height: auto` 会破坏它。另注：`.optBtn` 所在的 `.composerFooter`
 * 与 `.optApply`/`.optDismiss` 所在的 `.optActions` **不是同一个容器**，
 * 所以它们之间**本来就不需要对高**。
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PANELS = import.meta.dirname

/** 剥注释：本仓注释里大量出现 `.类名`，不剥会造成假阳性。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 族 E 的成员：(css 文件, 类名, 是否参与几何对齐)。
 * 这条表**本身就是点名哨兵** —— 塌陷（某个类被删/改名）会立刻红。
 */
const FAMILY_E = [
  { file: 'ask.module.css', cls: 'optApply', aligned: true },
  { file: 'ask.module.css', cls: 'optDismiss', aligned: true },
  { file: 'ask.module.css', cls: 'optBtn', aligned: false },   // 豁免：固定 28px + 窄屏 36px 触屏指标
  { file: 'chats-cards.module.css', cls: 'loadMore', aligned: true },
  { file: 'records.module.css', cls: 'loadMore', aligned: true },
] as const

/** 取某个类的**主规则块**（花括号配对；`.cls:hover` 等变体不算）。 */
function ruleBody(css: string, cls: string): string | null {
  // 只认「行首（可带空白）.cls {」——避免命中 .clsXxx / .cls:hover。
  // 注意 JS 用 RegExp 构造器时 `(?m)` 内联标志**不被支持**（会 SyntaxError），要传 'm' flag。
  const m = new RegExp(`^\\s*\\.${cls}\\s*\\{`, 'm').exec(css)
  if (m === null) return null
  const open = css.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/** 从规则体里取某属性的值（允许简写，取第一个匹配）。 */
function prop(body: string, name: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(body)
  return m === null ? null : m[1]!.trim()
}

describe('P1 族 E 共享几何对齐', () => {
  /** 读并剥注释后的整份 css。 */
  const cache = new Map<string, string>()
  function cssOf(file: string): string {
    if (!cache.has(file)) {
      cache.set(file, stripComments(readFileSync(join(PANELS, file), 'utf-8')))
    }
    return cache.get(file)!
  }

  it('哨兵：族 E 五个成员都真实存在（点名表不是空转）', () => {
    expect(FAMILY_E.length, '点名表被删空').toBe(5)
    const missing: string[] = []
    for (const { file, cls } of FAMILY_E) {
      if (ruleBody(cssOf(file), cls) === null) missing.push(`${file} .${cls}`)
    }
    expect(missing, `族 E 成员缺失（被删或改名）：\n  ${missing.join('\n  ')}`).toEqual([])
    // 参与对齐的必须≥4（若有人把 aligned 全改成 false，等于守卫自废）
    const aligned = FAMILY_E.filter(m => m.aligned).length
    expect(aligned, `参与几何对齐的成员只剩 ${aligned} 个，守卫已被架空`).toBeGreaterThanOrEqual(4)
  })

  it('每个参与对齐的成员，padding / border-width / border-radius / font-size 四项一致', () => {
    const WANT = {
      padding: /^6px\s+14px$/,
      borderwidth: /^1px$/,
      borderradius: /^var\(--nm-r-pill\)$/,
      fontsize: /^12px$/,
    }
    const bad: string[] = []
    for (const { file, cls, aligned } of FAMILY_E) {
      if (!aligned) continue
      const body = ruleBody(cssOf(file), cls)
      if (body === null) { bad.push(`${file} .${cls}（找不到规则块）`); continue }
      const got = {
        padding: prop(body, 'padding'),
        borderwidth: prop(body, 'border-width'),
        borderradius: prop(body, 'border-radius'),
        fontsize: prop(body, 'font-size'),
      }
      // border 简写兜底：`border: 1px solid X` ⇒ border-width 视作 1px
      if (got.borderwidth === null) {
        const b = prop(body, 'border')
        if (b !== null && /^1px\b/.test(b)) got.borderwidth = '1px'
      }
      for (const [k, re] of Object.entries(WANT)) {
        const v = got[k as keyof typeof got]
        if (v === null) { bad.push(`${file} .${cls}：缺 ${k}`); continue }
        if (!re.test(v)) bad.push(`${file} .${cls}：${k} = "${v}"，期望匹配 ${re}`)
      }
    }
    expect(bad, `族 E 几何未对齐：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反例自证：豁免项 .optBtn 必须**仍然**是固定高（不是被顺手改掉了）', () => {
    const body = ruleBody(cssOf('ask.module.css'), 'optBtn')
    expect(body, '.optBtn 规则块丢失').not.toBeNull()
    expect(prop(body!, 'height'), '.optBtn 的固定高度被改掉了（触屏手指标会失效）').not.toBeNull()
    // 窄屏抬高的覆盖规则也必须在
    const css = cssOf('ask.module.css')
    expect(css, '.optBtn 的窄屏 36px 触屏指标覆盖规则丢失').toMatch(/\.optBtn\s*\{\s*height:\s*36px/)
  })
})
