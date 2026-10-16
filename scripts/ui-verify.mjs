/**
 * 界面真机验收：**一条命令跑完界面那一半的三项检查**。
 *
 * ## 为什么要有这个入口
 *
 * 「每一个用户界面」这条要求此前散在三个命令里，各有各的输出文件与退出码语义：
 *   · `npm run theme:live-audit`            —— 深浅主题一致性（17 个页签 computed style）
 *   · `npm run theme:live-audit -- --stress` —— 连点页签压力（门槛 3s，退出码 4）
 *   · `npm run ui:panel-audit`              —— 面板截图 + 留白表 + JS 错误
 * 分别记得跑哪一个、结果对不对，靠人；所以这里收成一个入口并**聚合退出码**。
 *
 * ## 范围（写清楚，免得被当成万能的）
 *
 * **不含** `npm run ui:accept` —— 那是 AI 问答 RAG 流水线的专项验收：它会接管
 * `llm.json` 指向本地 mock、并**清空向量库/反馈库**，运行前还必须关掉正在运行的应用。
 * 把它并进来会让"界面验收"带上破坏性副作用，所以刻意分开。
 *
 * **不含像素级视觉判断** —— 截图在本环境不可信（同一时刻截图显示骨架屏而 DOM 探针报
 * `nm-skel=0`，见已删除的 PERF-THEME-LEDGER 陷阱①，原文见 git 历史）。本入口产出截图供**人眼**复核，
 * 但不把"看起来对不对"自动化。
 *
 * ## 前置
 *
 * - `playwright` 可用（只驱动 Electron，无需下载浏览器）；
 * - 真实解密数据根存在（默认 `%APPDATA%/super-time-electron/wechat-data`）；
 * - 三个子脚本各自用**临时 profile**（`SUPERTIME_USER_DATA_DIR`），所以不会和正在运行的
 *   实例抢单实例锁；但**本入口是串行**执行的 —— 同时跑两个 Electron 会互相拖慢计时类判据
 *   （压力门禁比的是耗时），所以刻意不并行。
 *
 * 用法：`npm run ui:verify`
 * 退出码：0 = 三项全过；否则为第一个失败项的退出码（非 0）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 数一下当前有多少个 electron 进程。
 *
 * 为什么要它：2026-09-29 实测发现**我自己前几轮跑的真机脚本泄漏了 20 个 Electron 进程**
 * （累计 4978s CPU / 约 3.9GB 常驻），其中两个主进程分别烧掉 1739s 与 712s CPU。
 * 后果是这台机器上的**计时类判据全部被污染**：`ui:panel-audit` 每张截图从约 12s
 * 拉长到 **11 分钟**；清掉泄漏之后立刻恢复到 12s。
 * 所以这个入口在**开始时**和**结束时**各数一次，结束时不为 0 就告警。
 * @returns 进程数；数不出来返回 -1。
 */
function electronCount () {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8' })
  const n = Number.parseInt((r.stdout ?? '').trim(), 10)
  return Number.isNaN(n) ? -1 : n
}

/**
 * 依次执行的检查。
 *
 * ⚠️ **顺序有依赖**，别随手重排：
 *   · 第 1 步产出 `.tmp-e2e/theme-contrast.json` ⇒ 第 2 步（主题预算）靠它核对；
 *   · 第 3 步（`--stress`）产出 `.tmp-e2e/interactive-timings.json` ⇒ 第 4 步（交互预算）靠它核对。
 * 两个预算步骤**不做测量**，只把前一步落盘的数字与 `scripts/*-budget.json` 里的预算比对，
 * 所以它们很快（毫秒级），没有 `report`（产物就是那两份 JSON）。
 */
const STEPS = [
  {
    name: '主题一致性（深/浅 computed style，17 个页签）',
    args: ['scripts/theme-live-audit.mjs'],
    report: '.tmp-e2e/theme-live-audit.txt',
  },
  {
    // 把上一步的逐面板对比度与预算核对。门槛与测量分离 ⇒ 改预算不动测量代码。
    name: '主题对比度预算（逐面板 × 深/浅，AA 4.5 + 已登记例外按棘轮）',
    args: ['scripts/theme-contrast-budget.mjs'],
  },
  {
    name: '连点页签压力（门槛 3s；退出码 4 = 出现未登记的慢面板）',
    args: ['scripts/theme-live-audit.mjs', '--stress'],
    report: '.tmp-e2e/theme-live-audit.txt',
  },
  {
    // `--stress` 自带的 3s 门槛抓不到"~520ms 涨到 2500ms"这种温水式退化；
    // 这一步用 1200ms 的紧预算补上（基线实测 504–554ms）。
    name: '交互式响应预算（点击→正文，默认 1200ms；已登记队尾面板除外）',
    args: ['scripts/interactive-budget.mjs'],
  },
  {
    name: '面板审计（截图 + 留白表 + JS 错误）',
    args: ['scripts/panel-audit.mjs'],
    report: '.tmp-e2e/panels/',
  },
]

const results = []
const before = electronCount()
console.log(`\n运行前 electron 进程数：${before < 0 ? '（数不出来）' : String(before)}`)
if (before > 5) {
  console.log('⚠️ 已经有多个 electron 在跑 ⇒ 本轮的**计时类判据（压力门禁）会被污染**。')
  console.log('   建议先清掉残留实例再跑（kill 掉旧的 electron），否则读数不可比。')
}
for (const step of STEPS) {
  const entry = step.args[0]
  console.log('\n' + '='.repeat(72))
  console.log('▶ ' + step.name)
  console.log('  node ' + step.args.join(' '))
  console.log('='.repeat(72))
  if (!existsSync(join(ROOT, entry))) {
    console.log(`!! 找不到脚本 ${entry} —— 跳过，并按失败计`)
    results.push({ ...step, code: 127 })
    continue
  }
  // stdio: 'inherit' —— 让子脚本直接往本终端输出（便于现场看进度），
  // 也给子进程一个真实 TTY 之外的普通管道；Electron 只需要 stdout 不被吞掉。
  const r = spawnSync(process.execPath, step.args, { cwd: ROOT, stdio: 'inherit' })
  const code = r.status === null ? 126 : r.status
  results.push({ ...step, code })
  console.log(`◀ ${step.name} ⇒ 退出码 ${String(code)}`)
}

console.log('\n' + '='.repeat(72))
console.log('界面真机验收汇总')
console.log('='.repeat(72))
for (const r of results) {
  const mark = r.code === 0 ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  code=${String(r.code).padEnd(4)} ${r.name}`)
}
// 只有"产生文件的步骤"才有 `report`；两个预算步骤不产文件（产物就是它读的那份 JSON），
// 所以要滤掉 undefined，否则汇总里会多打一行 "undefined"。
const reports = [...new Set(results.filter((r) => r.code === 0).map((r) => r.report).filter((p) => typeof p === 'string' && p !== ''))]
if (reports.length > 0) {
  console.log('\n产出：')
  for (const p of reports) console.log('  ' + p)
}
const failed = results.filter((r) => r.code !== 0)
const after = electronCount()
console.log(`\n运行后 electron 进程数：${after < 0 ? '（数不出来）' : String(after)}`)
// 泄漏判定只看**增量**：本入口自己会起 3 个 Electron 实例（三个子脚本各一个），
// 正常收尾后应当回落到运行前的水位。残留 = 子脚本没清干净。
if (after >= 0 && before >= 0 && after > before) {
  console.log(`⚠️ 疑似泄漏 ${String(after - before)} 个 electron 进程 —— 计时类判据下次会被污染。`)
  console.log('   排查方向：子脚本的 `_electron.launch()` 是否都有配对的 `app.close()`（含异常路径）。')
}
if (failed.length === 0) {
  console.log('\n全部通过。')
  console.log('注意：本入口**不判像素级视觉**（截图仅供人眼复核）—— 那一条仍需人工看一眼浅色界面。')
  process.exit(0)
}
console.log(`\n有 ${String(failed.length)} 项未通过：`)
for (const f of failed) console.log(`  code=${String(f.code)}  ${f.name}`)
process.exit(failed[0].code)
