/**
 * P2 族 A（胶囊 chip）令牌化守卫（2026-09-28）。
 *
 * ── 这份守卫钉什么 ────────────────────────────────────────────────
 * 族 A = 「可选中/可清除的筛选标签」，共 **14 个**真 chip。它们的共同几何特征：
 *   border-radius: var(--nm-r-pill)（**已 100% 统一**，R2 完成）
 *   同一容器内多个并排 / 高度由内容撑开 / 字号统一
 *
 * ── 为什么只钉 font-size，不钉 padding ───────────────────────────
 * 实测 14 个真 chip 的 padding 有 **9 种签名**（`4px 12px`×6 / `2px 8px`×2 /
 * `0 12px` / `3px 8px` / `4px 6px` / `6px var(--nm-dense-g3)` / `4px 13px` /
 * `4px 14px` / `0 8px`）。它们**不是随手写的**——是按各自内容与容器调的：
 *   · `2px 8px` 用于标签小片（`tagChip`/`kbfiles.chip`）
 *   · `4px 12px` 用于筛选条（`catBtn`/`chip`/`authorChip`）
 *   · `6px var(--nm-dense-g3)` 用于模型条（`modelChip`）
 * 跨面板拉齐会**改 6 处高度**，属**设计变更**，不在本轮（P2 只做「零视觉变化」的那层）。
 *
 * ── 本轮实际收敛的（11 处，逐字节等价）───────────────────────────
 *   `font-size: 12px` → `var(--nm-fs-sm)`        （9 处；`--nm-fs-sm` 就是 12px）
 *   `font-size: 11px` → `var(--nm-dense-fs-sm)`  （2 处；`--nm-dense-fs-sm` 就是 11px）
 * 值与令牌定义**完全相同** ⇒ 零像素变化，纯粹的「裸值 → 令牌」纪律收敛。
 *
 * ── 为什么这值得钉死 ─────────────────────────────────────────────
 * 「裸 12px」和「var(--nm-fs-sm)」渲染**一模一样**，所以**没有任何视觉回归能发现
 * 有人把令牌换回裸值**。这种「等价但不一致」的漂移只能靠守卫拦。
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PANELS = import.meta.dirname
const THEME = join(PANELS, '..', 'scifi-theme.css')

/** 剥注释：本仓注释里大量出现 `.类名` 与 `font-size`，不剥会假阳性。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 族 A 真 chip 点名表（14 个）。
 * 判据：**有选中态**（`[data-active]` / `[data-on]` / `[data-dim]` / `[data-set]` /
 * `[data-custom]`）—— 这是「可选中筛选标签」与「普通按钮」的硬分界。
 *
 * 排除掉的名（曾按 `border-radius: pill` 粗筛出 29 个，其中 14 个不是 chip）：
 *   `optApply` / `optDismiss` / `loadMore`×2 / `actionBtn`（P1 族 E，独立表单按钮）
 *   `optBtn` / `distillBtn` / `clearChip` / `clearBtn`
 *   `moreBtn` / `exportAction` / `suggestBtn` / `note-editor.chip` / `groupChip`
 *
 * ⚠️ `fbBtn` **同时有固定 height**（24px）—— 它是 chip 但高度被钉死（密集工具条）。
 * 本守卫只查 `font-size`，不碰高度，所以它可以安全留在表内。
 */
const CHIPS = [
  { file: 'chats-rows.module.css', cls: 'exportChip' },
  { file: 'contacts.module.css', cls: 'catBtn' },
  { file: 'daily-summary.module.css', cls: 'tabBtn' },
  { file: 'graph.module.css', cls: 'chip' },
  { file: 'graph.module.css', cls: 'detailChip' },
  { file: 'graph.module.css', cls: 'segBtn' },
  { file: 'kb-rail.module.css', cls: 'modelChip' },
  { file: 'kbfiles.module.css', cls: 'chip' },
  { file: 'knowledge-base.module.css', cls: 'tagChip' },
  { file: 'list-panel.module.css', cls: 'catBtn' },
  { file: 'moments.module.css', cls: 'authorChip' },
  { file: 'moments.module.css', cls: 'segChip' },
  { file: 'retrieval.module.css', cls: 'fbBtn' },
] as const

/** 取某个类的主规则块（花括号配对；`.cls:hover` 等变体不算）。 */
function ruleBody(css: string, cls: string): string | null {
  // JS 的 RegExp 构造器**不支持 `(?m)` 内联标志**（会 SyntaxError），必须传 'm' flag。
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

/** 取规则块里某属性的值。 */
function prop(body: string, name: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(body)
  return m === null ? null : m[1]!.trim()
}

describe('P2 族 A 胶囊 chip：font-size 必须是令牌（零视觉变化的纪律收敛）', () => {
  const cache = new Map<string, string>()
  function cssOf(file: string): string {
    if (!cache.has(file)) {
      cache.set(file, stripComments(readFileSync(join(PANELS, file), 'utf-8')))
    }
    return cache.get(file)!
  }

  it('哨兵：13 个真 chip 都真实存在，且都真的是 pill 圆角', () => {
    expect(CHIPS.length, '点名表被删空').toBe(13)
    const missing: string[] = []
    const notPill: string[] = []
    for (const { file, cls } of CHIPS) {
      const body = ruleBody(cssOf(file), cls)
      if (body === null) { missing.push(`${file} .${cls}`); continue }
      const radius = prop(body, 'border-radius')
      if (radius !== 'var(--nm-r-pill)') notPill.push(`${file} .${cls}: ${radius ?? '<无>'}`)
    }
    expect(missing, `族 A 成员缺失（被删或改名）：\n  ${missing.join('\n  ')}`).toEqual([])
    // 圆角必须全是 pill —— 若有人把某个 chip 改成方角，它就不再是同一族，必须显式改表
    expect(notPill, `以下 chip 的圆角不再是 pill（要么改回，要么从表里移除并说明）：\n  ${notPill.join('\n  ')}`).toEqual([])
  })

  it('每个真 chip 的 font-size 必须是令牌，不得是裸值', () => {
    const bad: string[] = []
    for (const { file, cls } of CHIPS) {
      const body = ruleBody(cssOf(file), cls)
      if (body === null) { bad.push(`${file} .${cls}（找不到规则块）`); continue }
      const fs = prop(body, 'font-size')
      if (fs === null) { bad.push(`${file} .${cls}：缺 font-size`); continue }
      // 必须是 var(--nm-…)，且不许带 fallback 里的裸值兜底（那等于把裸值留了一半）
      if (!/^var\(--nm-[a-z0-9-]+\)$/.test(fs)) {
        bad.push(`${file} .${cls}：font-size = "${fs}"，必须是 var(--nm-…) 无 fallback`)
      }
    }
    expect(bad, `族 A 仍有裸字号：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反例自证：令牌定义的值必须与它替换掉的裸值完全一致（证明是零视觉变化）', () => {
    const theme = stripComments(readFileSync(THEME, 'utf-8'))
    const val = (tok: string): string | null => {
      const m = new RegExp(`${tok}\\s*:\\s*([^;]+)`).exec(theme)
      return m === null ? null : m[1]!.trim()
    }
    // 这两条是本轮的等价性前提：一旦有人把令牌值改了，本轮的「零视觉变化」就不成立，
    // 必须重新评估 —— 所以钉死它们。
    expect(val('--nm-fs-sm'), '--nm-fs-sm 不再是 12px ⇒ P2 的「零视觉变化」前提被破坏').toBe('12px')
    expect(val('--nm-dense-fs-sm'), '--nm-dense-fs-sm 不再是 11px ⇒ P2 的「零视觉变化」前提被破坏').toBe('11px')
  })
})
