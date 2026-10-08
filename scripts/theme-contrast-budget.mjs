/**
 * 主题一致性门禁（**真机**侧）：逐面板核对对比度数值。
 *
 * ## 它补的是哪个洞
 *
 * 主题一致性此前有两层，但**真机那一层是空的**：
 *   · `theme-contrast.guard.spec.ts`（离线）：算 **`--nm-*` 令牌自身**的 9 对 + 语义色 + 徽标 ——
 *     证明的是"这套令牌没问题"，**证明不了"面板真的用了这套令牌"**；
 *   · `wx-skin-contrast.guard.spec.ts`（离线）：补了 `--wx-*` 皮肤层，但同样是**静态解析 CSS**；
 *   · `theme-live-audit`（真机）：只打印"未随主题变化: N 个 / 对比度 <4.5: …"，
 *     **既不落盘也不进退出码** ⇒ 没有门禁。
 *
 * 本脚本拿真机落盘的 `theme-contrast.json`，逐面板核对：
 *   ① 每个面板的**背景是否随主题变化**（没变 = 主题覆盖失效，直接失败）；
 *   ② 每个面板在**两套主题下**的采样对比度是否达标（默认 AA 4.5），
 *      已登记的例外按**棘轮**只许不变差。
 *
 * ## 门槛口径（为什么"正文类"与"弱化文字"要分开）
 *
 * 取样从 2026-09-29 起升级为**多采样**：面板内所有可见文本按 `(color, 不透明祖先背景)`
 * 去重（上限 40 对），`contrast` = **除弱化文字（`--nm-text-3`）外的最低值**，
 * `worstAny` = 含弱化文字的最低值（诊断用，不进退出码）。
 *
 * 为什么要分开：深色端 `text-3`（弱化文字）实测 3.75，是仓库**早已记录并决策接受**的
 * （内容类文字改用 `--text-2`，不动令牌值）。混在一起的话门槛永远卡在 3.75，
 * "正文有没有掉到 AA 以下"就永远量不出来 —— 而那才是这一层真正要管的事。
 *
 * 用法：`npm run ui:theme-budget`
 * （前置：先跑 `npm run theme:live-audit -- --all-tabs` 产出 `theme-contrast.json`）
 * 缺登记 ≠ 通过：面板出现在测量里却不在例外表里、且不达标 ⇒ **报错**。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const MEASURED = join(ROOT, '.tmp-e2e', 'theme-contrast.json')
const BUDGET = join(ROOT, 'scripts', 'theme-contrast-budget.json')

if (!existsSync(MEASURED)) {
  console.error(`找不到测量结果 ${MEASURED}\n请先跑：npm run theme:live-audit`)
  process.exit(2)
}
if (!existsSync(BUDGET)) {
  console.error(`找不到预算文件 ${BUDGET}`)
  process.exit(2)
}

const measured = JSON.parse(readFileSync(MEASURED, 'utf8'))
const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
const AA = Number(budget.aaFloor ?? 4.5)
// 例外表：'面板|主题' → 允许的下限（棘轮）。键里带主题，因为同一个面板两套主题的取样点可能不同。
const exceptions = budget.exceptions ?? {}

console.log(`测量时间：${String(measured.generatedAt)}`)
console.log(`口径：${String(measured.metric)}`)
console.log(`AA 门槛 ${String(AA)}；例外 ${String(Object.keys(exceptions).length)} 条\n`)

let fail = 0
const rows = []
for (const p of measured.panels ?? []) {
  const label = String(p.label)
  // ① 背景必须随主题变化
  if (p.themeChanged !== true) {
    rows.push({ label, theme: '-', value: null, limit: null, verdict: '**背景未随主题变化**' })
    fail++
  }
  for (const theme of ['dark', 'light']) {
    const v = p[theme]?.contrast
    const key = `${label}|${theme}`
    const isExc = Object.prototype.hasOwnProperty.call(exceptions, key)
    const limit = isExc ? Number(exceptions[key]) : AA
    let verdict
    if (v === null || v === undefined) verdict = 'n/a（取样是半透明，未合成）'
    else if (v < limit) { verdict = `**低于门槛**（${v.toFixed(2)} < ${String(limit)}）`; fail++ } else verdict = isExc ? 'OK(例外)' : 'OK'
    // 反向检查：登记成例外、**却已经达标**（≥ AA）⇒ 该例外已无意义，必须删掉。
    // 为什么要有这条：例外表只会长不会短 ⇒ 久而久之门禁被"例外"掏空
    // （这正是"谁都别动那条规则"的由来）。第 83 轮实测确认过：不加这条，
    // 给一个实际 12.67 的面板登记 12.67 例外，脚本照样判 OK、退出码 0。
    if (isExc && v !== null && v !== undefined && v >= AA) {
      verdict = `**例外已无意义**（实测 ${v.toFixed(2)} ≥ AA ${String(AA)}）⇒ 请从 exceptions 里删掉这一条`
      fail++
    }
    rows.push({ label, theme, value: v === null || v === undefined ? null : v, any: p[theme]?.worstAny ?? null, limit, verdict })
  }
}

const measuredKeys = new Set()
for (const p of measured.panels ?? []) for (const t of ['dark', 'light']) measuredKeys.add(`${String(p.label)}|${t}`)
const stale = Object.keys(exceptions).filter((k) => !measuredKeys.has(k))

console.log('  面板        主题    正文对比   含弱化   门槛     判定')
for (const r of rows) {
  console.log(`  ${r.label.padEnd(10)} ${r.theme.padEnd(6)} ${(r.value === null ? 'n/a' : r.value.toFixed(2)).padStart(7)} ${(r.any === null || r.any === undefined ? 'n/a' : r.any.toFixed(2)).padStart(7)} ${(r.limit === null ? '-' : String(r.limit)).padStart(7)}   ${r.verdict}`)
}
if (stale.length > 0) {
  console.log(`\n  ⚠️ 例外表里登记但测量里没有（面板删了/改名了？）：${stale.join('、')}`)
  fail += stale.length
}
const values = rows.filter((r) => r.value !== null).map((r) => r.value)
const lowest = values.length > 0 ? Math.min(...values) : null
console.log(`\n  ${String(measured.panels?.length ?? 0)} 个面板 × 2 套主题；最低对比度 ${lowest === null ? '-' : lowest.toFixed(2)}；失败 ${String(fail)} 项`)
if (fail === 0) console.log('\n=== 全部达标（含已登记例外按棘轮）===')
else console.log(`\n=== ${String(fail)} 项不达标 ===`)
process.exit(fail === 0 ? 0 : 1)
