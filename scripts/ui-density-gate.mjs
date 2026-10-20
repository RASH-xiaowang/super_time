#!/usr/bin/env node
/**
 * 密度差异门禁（Wave D3 收口）：比较两份 `scripts/ui-density-audit.mjs` 产出的密度 JSON，
 * 把「密度不新增/不恶化」变成可执行门禁。
 *
 * ## 用法
 *
 * ```bash
 * # 1) 两份 JSON 直接比（baseline 应为上一次验收基线，如 density-d2）
 * node scripts/ui-density-gate.mjs \
 *   --baseline=working/team/density/density-d2.json \
 *   --current=working/team/density/density-final.json
 *
 * # 2) 现场跑密度审计再比（只跑改动面板）
 * node scripts/ui-density-gate.mjs --baseline=working/team/density/density-d2.json --run --only=oplog,storage
 *
 * # 3) 出 Markdown 报告 / allowlist 放行已知项
 * node scripts/ui-density-gate.mjs --baseline=... --current=... --report=density-gate.md --allow=allow.json
 *
 * # 4) 不依赖 Electron/真实数据的自检
 * node scripts/ui-density-gate.mjs --selftest
 * ```
 *
 * ## 比较语义（按同一 `tab|viewport` 的指标逐项判定）
 *
 * 指标：`fixedRatio / headerH / toolbarH / statH / cardHdH / tableRowH / emptyRatio`
 * （值与目标取自审计 JSON 的 `cells[].metrics` / `cells[].target`）。
 *
 * - **新增超目标**：baseline 达标（或 baseline 无该格）→ current 超目标 ⇒ 阻塞（exit 2）；
 * - **恶化超阈值**：baseline 已超目标，current 比 baseline 更差且超过阈值 ⇒ 阻塞（exit 2）：
 *   `fixedRatio +2pp`、`headerH/toolbarH/statH/cardHdH +4px`、`tableRowH +2px`、`emptyRatio +5pp`；
 * - 已超目标但未进一步恶化 / 改善 / 缺口消失 ⇒ 仅提示（exit 0）；
 * - baseline 有、current 缺失的格 ⇒ 仅提示（exit 0）。
 *
 * ## 退出码
 *
 * - `0` 无阻塞新增/恶化；`2` 存在阻塞项；`3` 前置失败（文件缺失/JSON 坏/解析不到 cell/`--run` 子进程失败）；`1` 脚本 bug。
 *
 * 只读 JSON、只在 `working/**` 下写报告；不改源码/审计逻辑/基线 JSON。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT_SCRIPT = join(ROOT, 'scripts', 'ui-density-audit.mjs')
const EXIT = { OK: 0, BUG: 1, REGRESSION: 2, PRECONDITION: 3 }
const QUICK_VIEWPORTS = ['390x844', '1440x900']
const TABLE_ROW_RANGE = [28, 34]

/** 指标定义：worsen 为阻塞恶化阈值（百分比用 pp 小数，像素用 px）。 */
const METRICS = [
  { key: 'fixedRatio', label: '固定区占比', unit: 'pct', worsen: 0.02, targetKey: 'fixedRatio' },
  { key: 'headerH', label: '页头高度', unit: 'px', worsen: 4, targetKey: 'headerH' },
  { key: 'toolbarH', label: '筛选区高度', unit: 'px', worsen: 4, targetKey: 'toolbarMax' },
  { key: 'statH', label: '统计区高度', unit: 'px', worsen: 4, targetKey: 'statH' },
  { key: 'cardHdH', label: '卡片头高度', unit: 'px', worsen: 4, targetKey: 'cardHdH' },
  { key: 'tableRowH', label: '表格行高', unit: 'px', worsen: 2, range: TABLE_ROW_RANGE },
  { key: 'emptyRatio', label: '卡片空白率', unit: 'pct', worsen: 0.05, targetKey: 'emptyRatio' },
]

/** 前置条件错误（exit 3，不打印堆栈）。 */
class PreconditionError extends Error {}

// ── CLI 参数 ──────────────────────────────────────────────────────────────
/**
 * 解析 `--key=value` / `--key value` / `--flag`。
 * @param {string[]} argv 参数。
 * @returns {Map<string,string|true>} 参数表。
 */
function parseArgs (argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) { out.set(a.slice(2, eq), a.slice(eq + 1)); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out.set(key, next); i++ } else out.set(key, true)
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))
const str = (key, def = '') => { const v = ARGS.get(key); return typeof v === 'string' ? v : def }
const flag = (key) => ARGS.get(key) === true || ARGS.get(key) === 'true'
const listArg = (key) => [...new Set(str(key, '').split(',').map((s) => s.trim()).filter(Boolean))]
const slug = (s) => String(s).replace(/[^\w.-]+/g, '_')

// ── 数值格式化 / 目标 / 超目标判定 ───────────────────────────────────────
/**
 * 按指标单位格式化数值（百分比显示 2 位）。
 * @param {object} metric 指标定义。
 * @param {number|null} v 数值。
 * @returns {string} 展示文本。
 */
function fmt (metric, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (metric.unit === 'pct') return `${(v * 100).toFixed(1)}%`
  return `${Math.round(v * 10) / 10}px`
}

/**
 * 读取某格某指标的目标值。
 * @param {object} cell 审计 cell。
 * @param {object} metric 指标定义。
 * @returns {number|Array<number>|null} 目标。
 */
function targetOf (cell, metric) {
  if (metric.range) return metric.range
  const t = cell.target || {}
  const v = t[metric.targetKey]
  return typeof v === 'number' ? v : null
}

/**
 * 判断指标是否超目标。
 * @param {object} metric 指标定义。
 * @param {number} value 当前值。
 * @param {number|Array<number>|null} target 目标。
 * @returns {boolean|null} 超目标 true；达标 false；目标未知 null。
 */
function isBreach (metric, value, target) {
  if (value === null || value === undefined || target === null) return null
  if (Array.isArray(target)) return value < target[0] || value > target[1]
  return value > target
}

// ── 文档装载 / 防空转 ─────────────────────────────────────────────────────
/**
 * 读取 JSON（带前置错误）。
 * @param {string} path 路径。
 * @param {string} label 标签。
 * @returns {object} JSON。
 */
function readJson (path, label) {
  if (!existsSync(path)) throw new PreconditionError(`${label} 不存在：${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
    throw new PreconditionError(`${label} 不是合法 JSON：${path}（${e.message}）`)
  }
}

/**
 * 收集 `tab|viewport` → cell（含指标/目标）。
 * 防空转：解析不到任何可用 cell 视为前置失败（否则「没扫到 ⇒ 无回归」是假绿）。
 * @param {object} doc 密度审计 JSON。
 * @param {object} opts `{label,tabs,viewports}`。
 * @returns {{label:string, cells:Map<string,object>, cellCount:number, errors:number, meta:object}} 结果。
 */
function collectCells (doc, opts = {}) {
  const label = opts.label || 'density'
  if (!doc || typeof doc !== 'object') throw new PreconditionError(`${label}: JSON 不是对象`)
  if (!Array.isArray(doc.cells)) throw new PreconditionError(`${label}: 找不到 cells 数组（schema 不匹配？拒绝把空跑当无回归）`)
  const tabs = opts.tabs?.length ? new Set(opts.tabs) : null
  const viewports = opts.viewports?.length ? new Set(opts.viewports) : null
  const cells = new Map()
  let errors = 0
  for (const c of doc.cells) {
    if (!c || typeof c !== 'object') continue
    const tab = String(c.tab || '')
    const viewport = String(c.viewport || '')
    if (tabs && !tabs.has(tab)) continue
    if (viewports && !viewports.has(viewport)) continue
    if (c.error) { errors++; continue }
    if (!c.metrics || typeof c.metrics !== 'object') continue
    cells.set(`${tab}|${viewport}`, {
      tab,
      viewport,
      metrics: c.metrics,
      target: c.target || doc.meta?.thresholds?.targets?.[viewport] || null,
      pass: c.pass || null,
    })
  }
  if (cells.size === 0) {
    throw new PreconditionError(`${label}: 解析不到可用 cell（原始 ${doc.cells.length} 个被过滤/失败）——拒绝把空跑当无回归`)
  }
  return { label, cells, cellCount: cells.size, errors, meta: doc.meta || {}, summary: doc.summary || {} }
}

// ── allowlist ─────────────────────────────────────────────────────────────
/** glob（`*`/`?`）或子串匹配。 */
function matchPattern (value, pattern) {
  const v = String(value)
  const p = String(pattern)
  if (!/[*?]/.test(p)) return v.includes(p)
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(v)
}

/**
 * 读取 allowlist（数组或 `{allow:[...]}`）。条目支持 `{tab,viewport,metric,reason}` 或字符串。
 * @param {string} path 文件路径（空返回 []）。
 * @returns {object[]} 规则。
 */
function loadAllowlist (path) {
  if (!path) return []
  const doc = readJson(path, 'allowlist')
  const list = Array.isArray(doc) ? doc : doc?.allow
  if (!Array.isArray(list)) throw new PreconditionError(`allowlist 需为数组或 { allow: [...] }：${path}`)
  return list.map((item, i) => {
    if (typeof item === 'string') return { fields: { key: item }, reason: `allow#${i + 1}`, raw: item }
    if (!item || typeof item !== 'object') throw new PreconditionError(`allow[${i}] 不是字符串或对象`)
    const fields = {}
    for (const k of ['tab', 'viewport', 'metric', 'key']) if (typeof item[k] === 'string') fields[k] = item[k]
    if (Object.keys(fields).length === 0) throw new PreconditionError(`allow[${i}] 需含 tab/viewport/metric 至少一个`)
    return { fields, reason: String(item.reason || `allow#${i + 1}`), raw: JSON.stringify(item) }
  })
}

/** 判断一个阻塞项是否命中 allowlist。 */
function allowHit (item, rules) {
  for (const rule of rules) {
    let ok = true
    for (const [field, pat] of Object.entries(rule.fields)) {
      const val = field === 'metric' ? item.metric : item[field]
      if (!matchPattern(val ?? '', pat)) { ok = false; break }
    }
    if (ok) return rule
  }
  return null
}

// ── 比较核心 ──────────────────────────────────────────────────────────────
/**
 * 比较两份采集结果，返回阻塞/放行/提示三类清单。
 * @param {object} base collectCells（baseline）。
 * @param {object} cur collectCells（current）。
 * @param {object} opts `{allowRules, thresholdOverrides}`。
 * @returns {object} 比较结果。
 */
function compareCells (base, cur, opts = {}) {
  const allowRules = opts.allowRules || []
  const blocking = []
  const allowed = []
  const warnings = []
  const improvements = []
  const disappear = []
  const pushBlocking = (item) => {
    const rule = allowHit(item, allowRules)
    if (rule) allowed.push({ ...item, allowReason: rule.reason })
    else blocking.push(item)
  }
  for (const [key, c] of cur.cells) {
    const b = base.cells.get(key)
    if (!b) {
      // baseline 没有这一格（新 tab/新视口）：只要当前有超目标就按新增阻塞；全达标则仅提示
      for (const metric of METRICS) {
        const value = c.metrics[metric.key]
        const target = targetOf(c, metric)
        if (isBreach(metric, value, target) === true) {
          pushBlocking({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: null, current: value, target, kind: 'new-cell-breach', reason: 'baseline 无该格，current 首次出现超目标' })
        }
      }
      continue
    }
    for (const metric of METRICS) {
      const value = c.metrics[metric.key]
      const before = b.metrics[metric.key]
      const target = targetOf(c, metric)
      const curBreach = isBreach(metric, value, target)
      const baseBreach = isBreach(metric, before, targetOf(b, metric) ?? target)
      if (curBreach === true) {
        if (baseBreach === false) {
          pushBlocking({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'new-breach', reason: 'baseline 达标 → current 超目标' })
        } else if (baseBreach === true && typeof value === 'number' && typeof before === 'number') {
          const delta = metric.unit === 'pct' ? (value - before) : (value - before)
          if (delta > metric.worsen) {
            pushBlocking({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'worsened', reason: `已超目标且恶化 ${fmtDelta(metric, delta)} > 阈值 ${fmtDelta(metric, metric.worsen)}` })
          } else {
            warnings.push({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'still-breach', reason: `已超目标，未进一步恶化（${fmtDelta(metric, delta)}）` })
          }
        } else {
          warnings.push({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'still-breach', reason: '已超目标（baseline 数据缺失，无法判定恶化）' })
        }
      } else if (curBreach === false && baseBreach === true) {
        improvements.push({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'improved', reason: '由超目标转为达标' })
      } else if (curBreach === false && baseBreach === false && typeof value === 'number' && typeof before === 'number' && value < before - 1e-9 && metric.unit === 'pct') {
        warnings.push({ tab: c.tab, viewport: c.viewport, metric: metric.key, label: metric.label, unit: metric.unit, baseline: before, current: value, target, kind: 'improved-value', reason: '数值改善（仍达标）' })
      }
    }
  }
  for (const [key, b] of base.cells) if (!cur.cells.has(key)) disappear.push({ tab: b.tab, viewport: b.viewport })
  return { base, cur, blocking, allowed, warnings, improvements, disappear }
}

/** 恶化差值展示。 */
function fmtDelta (metric, delta) {
  if (metric.unit === 'pct') return `${(delta * 100).toFixed(1)}pp`
  return `${Math.round(delta * 10) / 10}px`
}

/** 由比较结果决定退出码。 */
const decideExit = (report) => (report.blocking.length > 0 ? EXIT.REGRESSION : EXIT.OK)

// ── 输出 ─────────────────────────────────────────────────────────────────
/** 控制台摘要。 */
function printConsole (report, meta) {
  const { base, cur } = report
  console.log('\n── 密度差异门禁 ──')
  console.log(`基线：${meta.baselinePath}`)
  console.log(`  label=${base.meta.label || '-'}  cell=${base.cellCount}  失败格=${base.errors}`)
  console.log(`当前：${meta.currentPath}`)
  console.log(`  label=${cur.meta.label || '-'}  cell=${cur.cellCount}  失败格=${cur.errors}`)
  console.log(`范围：${meta.scope}`)
  console.log(`阻塞（新增超目标/恶化）：${report.blocking.length}    allowlist 放行：${report.allowed.length}`)
  console.log(`仅提示：已超未恶化 ${report.warnings.length} / 改善 ${report.improvements.length} / 缺失格 ${report.disappear.length}`)
  for (const it of report.blocking.slice(0, 40)) {
    console.log(`  ✗ [${it.kind}] ${it.tab}@${it.viewport} ${it.metric}(${it.label}) ${fmt({ unit: it.unit }, it.baseline)} → ${fmt({ unit: it.unit }, it.current)}  目标 ${Array.isArray(it.target) ? it.target.join('–') : fmt({ unit: it.unit }, it.target)}`)
  }
  if (report.blocking.length > 40) console.log(`  … 其余 ${report.blocking.length - 40} 条见报告`)
  for (const it of report.allowed.slice(0, 10)) console.log(`  ~ allow[${it.allowReason}] ${it.tab}@${it.viewport} ${it.metric}: ${it.reason}`)
  for (const it of report.improvements.slice(0, 10)) console.log(`  ✓ 改善 ${it.tab}@${it.viewport} ${it.metric}: ${fmt({ unit: it.unit }, it.baseline)} → ${fmt({ unit: it.unit }, it.current)}`)
  const pass = report.blocking.length === 0
  console.log(`\n结论：${pass ? 'PASS（无阻塞新增/恶化）' : `FAIL（${report.blocking.length} 条阻塞）`}`)
  if (meta.reportPath) console.log(`报告：${meta.reportPath}`)
}

/** Markdown 转义。 */
const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * 生成 Markdown 报告。
 * @param {object} report 比较结果。
 * @param {object} meta 元信息。
 * @returns {string} markdown。
 */
function buildMarkdown (report, meta) {
  const { base, cur } = report
  const pass = report.blocking.length === 0
  const L = []
  L.push('# 密度差异门禁报告')
  L.push('')
  L.push(`> 由 \`scripts/ui-density-gate.mjs\` 生成（${new Date().toISOString()}）。命令：\`${meta.command}\``)
  L.push('')
  L.push(`## 结论：${pass ? 'PASS' : 'FAIL'}`)
  L.push('')
  L.push('| 项 | 值 |')
  L.push('|---|---|')
  L.push(`| 基线 | \`${meta.baselinePath}\`（label=${mdCell(base.meta.label || '-')}，cell=${base.cellCount}） |`)
  L.push(`| 当前 | \`${meta.currentPath}\`（label=${mdCell(cur.meta.label || '-')}，cell=${cur.cellCount}） |`)
  L.push(`| 比较范围 | ${mdCell(meta.scope)} |`)
  L.push(`| 阻塞（新增超目标/恶化） | **${report.blocking.length}** |`)
  L.push(`| allowlist 放行 | ${report.allowed.length} |`)
  L.push(`| 仅提示（已超未恶化） | ${report.warnings.length} |`)
  L.push(`| 改善 | ${report.improvements.length} |`)
  L.push(`| current 缺失格 | ${report.disappear.length} |`)
  L.push('')
  L.push('## 阻塞项')
  L.push('')
  if (report.blocking.length === 0) L.push('无。')
  else {
    L.push('| # | 类型 | tab | 视口 | 指标 | 基线 | 当前 | 目标 | 说明 |')
    L.push('|---:|---|---|---|---|---:|---:|---:|---|')
    report.blocking.forEach((it, i) => {
      const target = Array.isArray(it.target) ? it.target.join('–') : fmt({ unit: it.unit }, it.target)
      L.push(`| ${i + 1} | ${it.kind} | \`${mdCell(it.tab)}\` | ${it.viewport} | ${it.metric}/${it.label} | ${fmt({ unit: it.unit }, it.baseline)} | **${fmt({ unit: it.unit }, it.current)}** | ${target} | ${mdCell(it.reason)} |`)
    })
  }
  L.push('')
  L.push('## allowlist 放行')
  L.push('')
  if (report.allowed.length === 0) L.push('无。')
  else {
    L.push('| # | 原因 | tab | 视口 | 指标 | 基线→当前 |')
    L.push('|---:|---|---|---|---|---|')
    report.allowed.forEach((it, i) => L.push(`| ${i + 1} | ${mdCell(it.allowReason)} | \`${mdCell(it.tab)}\` | ${it.viewport} | ${it.metric} | ${fmt({ unit: it.unit }, it.baseline)}→${fmt({ unit: it.unit }, it.current)} |`))
  }
  L.push('')
  L.push('## 仅提示：已超目标但未恶化')
  L.push('')
  if (report.warnings.length === 0) L.push('无。')
  else {
    L.push('| tab | 视口 | 指标 | 基线→当前 | 目标 |')
    L.push('|---|---|---|---:|---:|')
    for (const it of report.warnings.slice(0, 100)) L.push(`| \`${mdCell(it.tab)}\` | ${it.viewport} | ${it.metric} | ${fmt({ unit: it.unit }, it.baseline)}→${fmt({ unit: it.unit }, it.current)} | ${Array.isArray(it.target) ? it.target.join('–') : fmt({ unit: it.unit }, it.target)} |`)
    if (report.warnings.length > 100) L.push(`| … | | | 其余 ${report.warnings.length - 100} 条 | |`)
  }
  L.push('')
  L.push('## 改善 / 缺失格')
  L.push('')
  if (report.improvements.length === 0 && report.disappear.length === 0) L.push('无。')
  else {
    for (const it of report.improvements.slice(0, 80)) L.push(`- ✓ \`${it.tab}@${it.viewport}\` ${it.metric}: ${fmt({ unit: it.unit }, it.baseline)} → ${fmt({ unit: it.unit }, it.current)}（${it.reason}）`)
    for (const it of report.disappear.slice(0, 80)) L.push(`- ⚠ \`${it.tab}@${it.viewport}\` 在 current 中缺失（仅提示）`)
  }
  L.push('')
  L.push('## 口径与阈值')
  L.push('')
  L.push('- 比较同一 `tab|viewport` 的 7 个指标；目标取自审计 JSON 的 `cells[].target`。')
  L.push('- 阻塞规则：baseline 达标→current 超目标；或已超目标且恶化超过阈值（fixedRatio +2pp、headerH/toolbarH/statH/cardHdH +4px、tableRowH +2px、emptyRatio +5pp）。')
  L.push('- 已超目标但未恶化、改善、current 缺失格：仅提示（exit 0）。')
  L.push('- 必须用真实数据机器产出 current；CI 无真实数据，暂不挂 CI job。')
  L.push('')
  return L.join('\n')
}

// ── --run：spawn 密度审计 ────────────────────────────────────────────────
/**
 * 调审计脚本跑一次 current，返回 JSON 路径。
 * @param {object} opts `{only,quick,viewports,out,reportDir,label}`。
 * @returns {string} JSON 绝对路径。
 */
function runAudit (opts) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const label = opts.label || `density-gate-${stamp}`
  const outDir = resolve(ROOT, opts.out || join('working', 'team', 'density'))
  const reportDir = resolve(ROOT, opts.reportDir || join('working', 'team', 'density', 'gate-runs'))
  const args = [AUDIT_SCRIPT, `--label=${label}`, `--out=${outDir}`, `--report-dir=${reportDir}`, '--no-shots']
  if (opts.only) args.push(`--only=${opts.only}`)
  if (opts.quick) args.push('--quick')
  if (opts.viewports) args.push(`--viewports=${opts.viewports}`)
  console.log(`\n[--run] ${process.execPath} ${args.join(' ')}`)
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (res.error) throw new PreconditionError(`审计子进程无法启动：${res.error.message}`)
  if (res.status !== 0) throw new PreconditionError(`审计子进程失败（exit ${res.status}）；--run 需要本机真实数据与 Electron`)
  const jsonPath = join(outDir, `${slug(label)}.json`)
  if (!existsSync(jsonPath)) throw new PreconditionError(`审计子进程未产出预期 JSON：${jsonPath}`)
  return jsonPath
}

// ── 自检 ─────────────────────────────────────────────────────────────────
/** 构造最小密度 JSON。 */
function makeDoc (label, cells) {
  return { meta: { tool: 'ui-density-audit', version: 3, label }, cells }
}
/** 构造 cell（可指定若干指标值；未给出的指标取达标默认值）。 */
function makeCell (tab, viewport, metrics = {}) {
  const vpTarget = viewport === '1280x800'
    ? { fixedRatio: 0.28, headerH: 48, toolbarH: 48, toolbarMax: 88, statH: 52, emptyRatio: 0.4, cardHdH: 36 }
    : { fixedRatio: 0.2, headerH: 44, toolbarH: 48, toolbarMax: 88, statH: 52, emptyRatio: 0.35, cardHdH: 36 }
  const baseMetrics = { fixedRatio: 0.1, headerH: 30, toolbarH: 0, statH: 0, cardHdH: 30, tableRowH: null, emptyRatio: 0.1, ...metrics }
  return { tab, viewport, error: null, target: vpTarget, metrics: baseMetrics }
}

/**
 * 内置夹具自检：新增超目标 / 恶化 / 未恶化提示 / 改善 / allowlist / 新格 / 缺失格 / 防空转。
 * @returns {boolean} 全部通过。
 */
function runSelftest () {
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`) }
  const collect = (doc, label) => collectCells(doc, { label })
  const okCell = makeCell('annual', '1440x900')
  const baseDoc = makeDoc('fixture-base', [okCell, makeCell('ledger', '1440x900', { fixedRatio: 0.1 })])
  const base = collect(baseDoc, 'fixture-base')

  {
    const cur = collect(makeDoc('same', [okCell, makeCell('ledger', '1440x900', { fixedRatio: 0.1 })]), 'same')
    const r = compareCells(base, cur)
    check('相同输入无阻塞（exit 0）', r.blocking.length === 0 && decideExit(r) === EXIT.OK)
  }
  {
    const cur = collect(makeDoc('new-breach', [makeCell('annual', '1440x900', { fixedRatio: 0.5 })]), 'new-breach')
    const r = compareCells(base, cur)
    check('新增超目标 → 阻塞 / exit 2', r.blocking.length >= 1 && r.blocking.some((x) => x.metric === 'fixedRatio' && x.kind === 'new-breach') && decideExit(r) === EXIT.REGRESSION, `blocking=${r.blocking.length}`)
  }
  {
    const b = collect(makeDoc('base-breach', [makeCell('annual', '1440x900', { fixedRatio: 0.35 })]), 'base-breach')
    const cur = collect(makeDoc('worse', [makeCell('annual', '1440x900', { fixedRatio: 0.42 })]), 'worse')
    const r = compareCells(b, cur)
    check('已超目标且恶化超阈值 → 阻塞 / exit 2', r.blocking.some((x) => x.metric === 'fixedRatio' && x.kind === 'worsened') && decideExit(r) === EXIT.REGRESSION, `blocking=${r.blocking.length}`)
  }
  {
    const b = collect(makeDoc('base-breach', [makeCell('annual', '1440x900', { fixedRatio: 0.35 })]), 'base-breach')
    const cur = collect(makeDoc('slight', [makeCell('annual', '1440x900', { fixedRatio: 0.36 })]), 'slight')
    const r = compareCells(b, cur)
    check('已超目标但未恶化超阈值 → 仅提示 / exit 0', r.blocking.length === 0 && r.warnings.some((x) => x.metric === 'fixedRatio' && x.kind === 'still-breach') && decideExit(r) === EXIT.OK)
  }
  {
    const b = collect(makeDoc('base-breach', [makeCell('annual', '1440x900', { emptyRatio: 0.6 })]), 'base-breach')
    const cur = collect(makeDoc('fixed', [makeCell('annual', '1440x900', { emptyRatio: 0.2 })]), 'fixed')
    const r = compareCells(b, cur)
    check('改善（超目标→达标）→ 提示 / exit 0', r.blocking.length === 0 && r.improvements.some((x) => x.metric === 'emptyRatio') && decideExit(r) === EXIT.OK)
  }
  {
    const cur = collect(makeDoc('allow', [makeCell('annual', '1440x900', { fixedRatio: 0.5 })]), 'allow')
    const allow = [{ fields: { tab: 'annual', metric: 'fixedRatio' }, reason: 'fixture allow', raw: '{}' }]
    const r = compareCells(base, cur, { allowRules: allow })
    check('allowlist 放行新增 → exit 0 / 放行 1', r.blocking.length === 0 && r.allowed.length === 1 && decideExit(r) === EXIT.OK)
  }
  {
    const b = collect(makeDoc('no-cell', [okCell]), 'no-cell')
    const cur = collect(makeDoc('new-cell', [okCell, makeCell('newtab', '1440x900', { headerH: 60 })]), 'new-cell')
    const r = compareCells(b, cur)
    check('baseline 无该格且 current 超目标 → 阻塞', r.blocking.some((x) => x.tab === 'newtab' && x.kind === 'new-cell-breach') && decideExit(r) === EXIT.REGRESSION)
  }
  {
    const b = collect(makeDoc('has-cell', [okCell, makeCell('gone', '1440x900')]), 'has-cell')
    const cur = collect(makeDoc('cell-gone', [okCell]), 'cell-gone')
    const r = compareCells(b, cur)
    check('current 缺失格 → 仅提示 / exit 0', r.disappear.length === 1 && r.blocking.length === 0 && decideExit(r) === EXIT.OK)
  }
  {
    let thrown = null
    try { collectCells({ meta: {} }, { label: 'empty' }) } catch (e) { thrown = e }
    check('防空转：无 cells 抛前置错误', thrown instanceof PreconditionError)
    let thrown2 = null
    try { collectCells(makeDoc('filtered', [makeCell('annual', '1440x900')]), { label: 'filtered', tabs: ['ledger'] }) } catch (e) { thrown2 = e }
    check('防空转：过滤后 0 cell 抛前置错误', thrown2 instanceof PreconditionError)
  }
  {
    const b = collect(makeDoc('table-base', [makeCell('ledger', '1440x900', { tableRowH: 36 })]), 'table-base')
    const cur = collect(makeDoc('table-cur', [makeCell('ledger', '1440x900', { tableRowH: 40 })]), 'table-cur')
    const r = compareCells(b, cur)
    check('tableRowH 超出 28–34 区间且恶化 → 阻塞', r.blocking.some((x) => x.metric === 'tableRowH') && decideExit(r) === EXIT.REGRESSION, `blocking=${r.blocking.length}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n自检结果：${failed.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败 ${failed.map((c) => c.name).join(', ')}`}`)
  return failed.length === 0
}

// ── main ─────────────────────────────────────────────────────────────────
/**
 * 入口。
 * @returns {number} 退出码。
 */
function main () {
  if (flag('selftest')) return runSelftest() ? EXIT.OK : EXIT.BUG
  const baselinePath = str('baseline', '')
  if (!baselinePath) throw new PreconditionError('缺少 --baseline=<density.json>')
  const only = listArg('only')
  const quick = flag('quick')
  const viewports = quick ? QUICK_VIEWPORTS : listArg('viewports')
  const allowRules = loadAllowlist(str('allow', ''))
  const run = flag('run')
  let currentPath = str('current', '')
  if (run && currentPath) throw new PreconditionError('--run 与 --current 只能二选一')
  if (!run && !currentPath) throw new PreconditionError('缺少 --current=<density.json>（或使用 --run 现场跑审计）')
  if (run) {
    currentPath = runAudit({
      only: only.join(','),
      quick,
      viewports: str('viewports', ''),
      out: str('out', ''),
      reportDir: str('report-dir', ''),
      label: str('label', ''),
    })
  }
  const scope = [only.length ? `only=${only.join(',')}` : '全部 tab', quick ? 'quick 视口（390/1440）' : (viewports.length ? `视口=${viewports.join(',')}` : '全部视口')].join(' · ')
  const basePath = resolve(ROOT, baselinePath)
  const curPath = run ? resolve(ROOT, currentPath) : resolve(ROOT, currentPath)
  const base = collectCells(readJson(basePath, '基线'), { label: '基线', tabs: only, viewports })
  const cur = collectCells(readJson(curPath, '当前'), { label: '当前', tabs: only, viewports })
  const report = compareCells(base, cur, { allowRules })
  const reportPath = str('report', '') ? resolve(ROOT, str('report', '')) : ''
  const meta = { baselinePath: basePath, currentPath: curPath, scope, reportPath, command: `node scripts/ui-density-gate.mjs ${process.argv.slice(2).join(' ')}` }
  printConsole(report, meta)
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, buildMarkdown(report, meta), 'utf8')
    console.log(`（Markdown 报告已写入 ${reportPath}）`)
  }
  if (cur.errors > 0) console.log(`⚠ 当前基线有 ${cur.errors} 个执行失败格，结论可能不完整。`)
  return decideExit(report)
}

try {
  process.exitCode = main()
} catch (e) {
  if (e instanceof PreconditionError) {
    console.error(`\n[前置失败] ${e.message}`)
    console.error('提示：先 `npm run ui:density-audit` 产出真实数据基线 JSON，或检查 --baseline/--current 路径。')
    process.exitCode = EXIT.PRECONDITION
  } else {
    console.error('\n[density-gate 内部错误]', e?.stack ?? e)
    process.exitCode = EXIT.BUG
  }
}
