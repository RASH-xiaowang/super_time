/**
 * 交互式响应预算门禁：核对「点击 → 正文出现」是否退化。
 *
 * ## 为什么需要它（而不是靠 `theme-live-audit --stress` 自己的门槛）
 *
 * `--stress` 的门槛是 **3000ms**，而基线实测 **503–548ms** —— 那是**有意留 5.8× 余量给慢机器**的，
 * 所以 **退化到 2900ms 它也不会报**。那个门槛管的是"有没有出现 60 秒级队列积压"，
 * **不管"~520ms 涨到 2500ms"这种温水式退化**。
 *
 * 这个脚本补上后者：拿 `theme-live-audit --stress` 落盘的 `interactive-timings.json`，
 * 按 **`interactive-budget.json`** 里逐面板登记的预算核对。
 *
 * ## 设计上的两个刻意选择
 *
 * 1. **门槛与测量分离**：测量在 `theme-live-audit.mjs`（会开真实 Electron），
 *    门槛是一个 PDF 可读的 JSON。改预算不用碰测量代码，审查也只看那一份 diff。
 * 2. **缺登记 ≠ 通过**：某个面板出现在测量结果里、却不在预算里 ⇒ **报错**。
 *    否则新增一个面板会自动获得"免检"资格（这正是"新页面没人管"的常见来源）。
 *
 * 用法：`npm run ui:interactive-budget`
 * （前置：先跑 `npm run theme:live-audit -- --stress` 产出 timings 文件）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TIMINGS = join(ROOT, '.tmp-e2e', 'interactive-timings.json')
const BUDGET = join(ROOT, 'scripts', 'interactive-budget.json')

if (!existsSync(TIMINGS)) {
  console.error(`找不到测量结果 ${TIMINGS}\n请先跑：npm run theme:live-audit -- --stress`)
  process.exit(2)
}
if (!existsSync(BUDGET)) {
  console.error(`找不到预算文件 ${BUDGET}`)
  process.exit(2)
}

const measured = JSON.parse(readFileSync(TIMINGS, 'utf8'))
const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
const known = budget.knownSlow ?? {}
const defaults = budget.defaults ?? {}

console.log(`测量时间：${String(measured.generatedAt)}`)
console.log(`口径：${String(measured.metric)}\n`)

let fail = 0
const rows = []
for (const p of measured.panels ?? []) {
  const label = String(p.label)
  const ms = Number(p.clickToContentMs)
  const isKnown = Object.prototype.hasOwnProperty.call(known, label)
  // 预算优先级：该面板的显式登记 > knownSlow 里的登记 > defaults
  const limitRaw = isKnown
    ? known[label]
    : Object.prototype.hasOwnProperty.call(defaults, label) ? defaults[label] : budget.defaultMs
  const limit = Number(limitRaw)
  let verdict
  if (!Number.isFinite(limit)) { verdict = '**未登记预算**'; fail++ } else if (ms < 0) { verdict = '**超时未出**'; fail++ } else if (ms > limit) { verdict = `**超预算**（${String(ms)} > ${String(limit)}）`; fail++ } else verdict = 'OK'
  rows.push({ label, ms, limit, verdict, registeredSlow: isKnown })
}

// 反向检查：预算里登记了、测量里没有 ⇒ 面板被删/改名了，预算是陈的
const measuredLabels = new Set((measured.panels ?? []).map((p) => String(p.label)))
const stale = Object.keys(known).filter((k) => !measuredLabels.has(k))

rows.sort((a, b) => b.ms - a.ms)
console.log('  面板        点击→正文      预算      判定')
for (const r of rows) {
  console.log(`  ${r.label.padEnd(10)} ${String(r.ms).padStart(9)}ms ${String(r.limit).padStart(9)}ms   ${r.verdict}`)
}

if (stale.length > 0) {
  console.log(`\n  ⚠️ 预算里登记但测量里没有（面板删了/改名了？）：${stale.join('、')}`)
  fail += stale.length
}
// 汇总只统计"未登记为已知慢"的面板 —— 把已知 60s 的队列积压算进"最慢"会让这一行失去意义
// （第一版就是这么错的：印出"最慢（达标者中）= 60191ms"，看着像有严重问题）。
const normal = rows.filter((r) => !r.registeredSlow && r.verdict === 'OK')
const slowest = normal.length > 0 ? normal[0] : null
const fastest = normal.length > 0 ? normal[normal.length - 1] : null
console.log(`\n  ${rows.length} 个面板（其中 ${String(rows.length - normal.length)} 个登记为已知慢）；失败 ${String(fail)} 项`)
if (slowest !== null && fastest !== null) {
  console.log(`  未登记为已知慢的 ${String(normal.length)} 个：${String(fastest.ms)}–${String(slowest.ms)}ms（离散 ${String(slowest.ms - fastest.ms)}ms）`)
}
if (fail === 0) console.log(`\n=== 全部在预算内（默认 ${String(budget.defaultMs)}ms）===`)
else console.log(`\n=== ${String(fail)} 项超预算 ===`)
process.exit(fail === 0 ? 0 : 1)
