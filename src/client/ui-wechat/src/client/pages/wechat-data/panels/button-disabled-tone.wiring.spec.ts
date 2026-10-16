/**
 * R6 按钮禁用态统一（2026-09-28）。
 *
 * ── 为什么需要这条守卫 ──────────────────────────────────────────
 * `ui-primitives-shim/src/Button.module.css` 的模块注释里写着：
 *   「禁用态固定为 opacity .5 + cursor: not-allowed（此前各面板有 .4/.45/.5/.55/.6 五种）」
 * 但 R6 实测：面板里**仍有 4 个按钮类自己写了非 .5 的禁用态透明度**
 * （`.45` ×3 + `.32` ×1），且都不在同一条理由上。这条守卫把它们钉死。
 *
 * ── 为什么不是「所有按钮类都必须有 :disabled」 ────────────────────
 * R6 审计出 104 个按钮类没有 `:disabled` 规则，但**绝大多数是故意的**：
 *   · `searchHit` / `calDay` / `indexLetter` 这类是列表项/格子，压根不会被禁用；
 *   · `ask.send` / `session-ask.send` 只设 `cursor: default`，靠 `[data-busy]`
 *     的渐变表达「正在发送」——这是设计，不是遗漏；
 *   · `ai-model.profileDel` 用 `.3` 是**危险操作故意更弱**的表达。
 * 强行给它们加 `:disabled` 是假收敛（守卫会变成「逼人写死代码」）。
 * 所以本守卫只钉**已经声明了 `:disabled` 的那些类**：要么 `.5`，要么进豁免表并写理由。
 *
 * ── 为什么不管焦点环 ────────────────────────────────────────────
 * 元素级全局规则 `scifi-theme.css` §5 已覆盖全部 `<button>`
 * （`button:focus-visible { outline: 2px solid var(--nm-cyan); outline-offset: 2px }`），
 * 逐个类检查会**假阴性**（类规则集里没有，但那条全局规则生效）。
 * R5 的组件指南曾把「补焦点环」列为待办 —— 那是误判，已在指南里更正。
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 递归收集目录下的 .tsx（跳过 ui/ —— kit 自己的按钮在 shim 里）。 */
function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === 'ui' || e === 'node_modules') continue
      collectTsx(p, acc)
    } else if (e.endsWith('.tsx') && !e.endsWith('.spec.tsx')) {
      acc.push(p)
    }
  }
  return acc
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * R6 实测的禁用态豁免表 —— 每条例外都必须写明理由。
 * 键 = `<css 文件名>|<类名>`。**只许减不许增**。
 */
const DISABLED_OPACITY_ALLOW: ReadonlyMap<string, string> = new Map([
  // AI 模型配置卡的「删除该配置」按钮：基准态**本身就是 opacity: .5**（正常态半透明，
  // hover 才提到 1），禁用态降为 .3。这是「.5 → 1 → .3」的三级关系；
  // 强行改成 .5 会让禁用态与**正常态完全一样**，反而看不出被禁用 —— 是倒退。
  ['ai-model.module.css|profileDel', '基准态即 .5，hover 提 1，禁用 .3 构成三级；改 .5 会与正常态撞值'],
])

/** 合法的禁用态透明度：只认 .5。 */
const OK_OPACITY = new Set(['0.5', '.5'])

/** 本 spec 在 `wechat-data/panels/` 下；`wechat-data/` 是 panels 的上一层。 */
const WECHAT_DATA = join(HERE, '..')
const PANELS = HERE

describe('R6 按钮禁用态统一：已声明 :disabled 的类必须用 .5', () => {
  const tsx = collectTsx(PANELS)

  /** 收集被 button 元素引用的类（alias → css 文件名 映射后）。 */
  function collectedButtonClasses(): Map<string, Set<string>> {
    const used = new Map<string, Set<string>>()
    for (const f of tsx) {
      const src = stripComments(readFileSync(f, 'utf-8'))
      // import css from './x.module.css' —— alias 可能是 css / kitCss / regionCss …
      const mods = [...src.matchAll(/import\s+(\w+)\s+from\s+'([^']*\.module\.css)'/g)]
      if (mods.length === 0) continue
      const alias2file = new Map(mods.map(m => [m[1]!, basename(m[2]!)]))
      // 只扫 <button …> 开标签
      for (const m of src.matchAll(/<button\b[^>]*>/g)) {
        const cm = /className=(\{[^}]*\}|"[^"]*")/.exec(m[0])
        if (!cm) continue
        for (const ref of cm[1]!.matchAll(/(\w+)\.(\w+)/g)) {
          const file = alias2file.get(ref[1]!)
          if (!file) continue
          if (!used.has(file)) used.set(file, new Set())
          used.get(file)!.add(ref[2]!)
        }
      }
    }
    return used
  }

  it('确实扫到了按钮类（哨兵：名单与计数缺一不可，否则下面的判据全是恒真）', () => {
    const used = collectedButtonClasses()
    const total = [...used.values()].reduce((n, s) => n + s.size, 0)
    /*
     * ── 为什么用「抽样点名」而不是纯数字下限 ─────────────────────────
     * 首版只写了 `total >= 80`。R6 变异 M6 把下限改成 `1`，守卫**照样绿**
     * —— 因为实际值是 139，下限形同虚设。而真正会发生的塌陷（某文件按钮被
     * 整体改写成 `<div>`）只会让总数从 139 掉到 107，也越不过 80。
     * 所以：数字下限留作粗筛，**真正的哨兵是下面这份抽样点名** ——
     * 塌陷一定发生在某个具体文件上，点名比计数敏感得多。
     */
    expect(total, `只扫到 ${total} 个按钮类，扫描逻辑可能已失效`).toBeGreaterThanOrEqual(80)
    expect(used.size, `只扫到 ${used.size} 个 module.css`).toBeGreaterThanOrEqual(20)

    // 抽样点名：这几个文件/类必须被扫到（覆盖 R6 实测中出问题的那几处）
    const MUST = [
      ['ask-history.module.css', 'dangerBtn'],   // R6 改过的野值
      ['ai-model.module.css', 'profileDel'],     // R6 的豁免项
      ['retrieval.module.css', 'fbBtn'],         // R6 改过的野值
      ['export-history.module.css', 'opBtn'],    // R6 改过的野值
      ['graph.module.css', 'miniBtn'],           // 不同文件的对照项
    ]
    const missing = MUST
      .filter(([f, c]) => !used.get(f!)?.has(c!))
      .map(([f, c]) => `${f} .${c}`)
    expect(missing, `扫描面塌陷，以下按钮类没被扫到：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('每个已声明 :disabled 的按钮类，opacity 必须是 .5（例外须登记）', () => {
    const used = collectedButtonClasses()
    const bad: string[] = []
    let checked = 0
    for (const [file, classes] of used) {
      const cssPath = join(PANELS, file)
      let css: string
      try { css = stripComments(readFileSync(cssPath, 'utf-8')) } catch { continue }
      for (const cls of classes) {
        // 该类的全部规则块（含 .cls:hover 等变体）
        const rules = [...css.matchAll(new RegExp(`\\.${cls}([^{,]*)\\{([^}]*)\\}`, 'g'))]
        for (const r of rules) {
          if (!r[1]!.includes(':disabled')) continue
          checked += 1
          const om = /opacity\s*:\s*([^;]+);/.exec(r[2]!)
          if (!om) continue          // 只设 cursor 的（如 ask.send）—— 合法
          const v = om[1]!.trim()
          if (OK_OPACITY.has(v)) continue
          if (DISABLED_OPACITY_ALLOW.has(`${file}|${cls}`)) continue
          bad.push(`${file}  .${cls}:disabled { opacity: ${v} }`)
        }
      }
    }
    expect(checked, `一条 :disabled 都没扫到，扫描逻辑可能已失效`).toBeGreaterThanOrEqual(10)
    expect(bad, `以下类的禁用态透明度不是 .5 且未登记例外：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('豁免表不得腐化（登记的例外必须真实存在且确实非 .5）', () => {
    const used = collectedButtonClasses()
    const stale: string[] = []
    for (const key of DISABLED_OPACITY_ALLOW.keys()) {
      const [file, cls] = key.split('|') as [string, string]
      if (!used.get(file)?.has(cls)) { stale.push(`${key}（类已不被 button 引用）`); continue }
      const cssPath = join(PANELS, file)
      let css: string
      try { css = stripComments(readFileSync(cssPath, 'utf-8')) } catch { stale.push(`${key}（文件读不到）`); continue }
      const rules = [...css.matchAll(new RegExp(`\\.${cls}([^{,]*)\\{([^}]*)\\}`, 'g'))]
      const dis = rules.filter(r => r[1]!.includes(':disabled'))
      const stillBad = dis.some(r => {
        const om = /opacity\s*:\s*([^;]+);/.exec(r[2]!)
        return om !== null && !OK_OPACITY.has(om[1]!.trim())
      })
      if (!stillBad) stale.push(`${key}（已统一为 .5，该删条目了）`)
    }
    expect(stale, `豁免表腐化：\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('全局焦点环必须覆盖 button（R5 误判的更正：这条已存在，别再加一遍）', () => {
    const theme = readFileSync(join(WECHAT_DATA, 'scifi-theme.css'), 'utf-8')
    const s = stripComments(theme)
    expect(s, '全局 button:focus-visible 规则丢失').toMatch(/button:focus-visible\s*,/)
    expect(s, '焦点环样式被改写').toContain('outline: 2px solid var(--nm-cyan)')
  })
})
