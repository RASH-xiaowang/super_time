#!/usr/bin/env node
/**
 * 响应式差异门禁（Wave 4 收口）：比较两份 `scripts/responsive-audit.mjs` 产出的基线 JSON，
 * 把「响应式不新增问题」从人工比对变成可执行门禁。
 *
 * ## 用法
 *
 * ```bash
 * # 1) 两份已有 JSON 直接比（最常用：本地修完 / 发布前跑一次审计再比）
 * node scripts/ui-responsive-gate.mjs \
 *   --baseline=working/team/responsive/post-wave2.json \
 *   --current=working/team/responsive/gate-xxx.json
 *
 * # 2) 让门禁自己跑审计再比（只跑改动面板，2～20 秒）
 * node scripts/ui-responsive-gate.mjs --baseline=working/team/responsive/post-wave2.json \
 *   --run --only=monitor,ledger --quick
 *
 * # 3) PR 里只比 quick 视口 + 忽略已接受的新增（allowlist）
 * node scripts/ui-responsive-gate.mjs --baseline=... --current=... --quick --allow=gate-allow.json --report=out.md
 *
 * # 4) 不依赖真实数据/Electron 的脚本自检
 * node scripts/ui-responsive-gate.mjs --selftest
 * ```
 *
 * ## 问题身份键（跨运行稳定，**不含 rect / 数组顺序 / 运行时间**）
 *
 * `tab|viewport|rule|sub|选择器稳定前缀|文本指纹`
 *
 * - **选择器稳定前缀**：审计输出的选择器含 CSS Modules 哈希（`_moreRow_1tp7d_315`）。哈希会随
 *   CSS 重建变化，因此统一剥成 `_moreRow`；CSS 类名变化（真实结构改动）仍会被识别为新问题。
 * - **文本指纹**：只对「选择器末段无 class」的通用元素（`span`/`b`/`div`…）启用，且把数字/长
 *   hex 归一成 `#`（数据态变化如「好友94 → 好友232」不误报）。带稳定 class 的元素不参与文本，
 *   避免头像名/名单这类数据内容抖动。
 *
 * ## 比较结果
 *
 * - **新增**（current 有、baseline 没有）：未命中 allowlist ⇒ **exit 2**；
 * - **消失**（baseline 有、current 没有）：只提示（exit 0）——修复/数据变少的正常现象；
 * - **变化**（同一身份键的 severity 或条数变了）：只提示（exit 0）。
 *
 * ## 退出码
 *
 * - `0` 无阻塞新增（可能仍有消失/变化）；
 * - `2` 有新增问题且未被 allowlist 放行；
 * - `3` 前置失败：文件缺失/JSON 解析失败/解析不到 cell（防空转）/--run 的审计子进程失败；
 * - `1` 未预期异常（脚本 bug）。
 *
 * ## 约束
 *
 * 只读审计 JSON、只在 `working/**` 下写报告；不修改源码/检测逻辑/基线 JSON。
 * CI 上暂无真实数据，因此本门禁定位为「本地 + 发布前」手动/脚本门禁，不挂 CI job。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT_SCRIPT = join(ROOT, 'scripts', 'responsive-audit.mjs')
const QUICK_VIEWPORTS = ['390x844', '1280x800', '2560x1440']
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 }

/** 退出码（见文件头）。 */
const EXIT = { OK: 0, BUG: 1, NEW: 2, PRECONDITION: 3 }

/** 前置条件错误：缺文件/空跑/子进程失败（映射到 exit 3，不打印堆栈）。 */
class PreconditionError extends Error {}

// ── CLI 参数 ────────────────────────────────────────────────────────────────
/**
 * 解析 `--key=value` / `--key value` / `--flag`。
 * 同一 key 出现多次时保留最后一个（`--allow` 除外，见 main）。
 * @param {string[]} argv 参数数组。
 * @returns {Map<string, string|true>} 参数表。
 */
function parseArgs (argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next)
      i++
    } else {
      out.set(key, true)
    }
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const str = (key, def = '') => {
  const v = ARGS.get(key)
  return typeof v === 'string' ? v : def
}
const flag = (key) => ARGS.get(key) === true || ARGS.get(key) === 'true'

/** 解析逗号分隔列表（去空/去重）。 */
function listArg (key) {
  return [...new Set(str(key, '').split(',').map((s) => s.trim()).filter(Boolean))]
}

// ── 身份键：选择器稳定前缀 + 文本指纹 ──────────────────────────────────────
/** CSS Modules 类名哈希：`_moreRow_1tp7d_315` → 稳定为 `_moreRow`。 */
const CSS_HASH_RE = /_([A-Za-z0-9-]+)_[a-z0-9]{4,10}_(\d+)/g

/**
 * 把选择器里的 CSS Modules 哈希剥掉，得到跨构建稳定的前缀。
 * @param {unknown} raw 原始选择器字符串。
 * @returns {string} 稳定选择器（最长 300 字符，避免异常长字符串撑爆报告）。
 */
function stableSelector (raw) {
  const s = typeof raw === 'string' ? raw : ''
  return s.replace(CSS_HASH_RE, '_$1').slice(0, 300)
}

/**
 * 选择器末段是否带 class（带 class 的元素用 class 身份即可，不掺数据文本）。
 * @param {string} sel 稳定选择器。
 * @returns {boolean} 末段是否含 class。
 */
function lastSegmentHasClass (sel) {
  const last = sel.split(' > ').pop() || ''
  const afterTag = last.includes('.') ? last : ''
  return afterTag.length > 0
}

/**
 * 文本指纹：仅用于「末段无 class」的通用元素，且做数据归一化。
 * 规则：压空白 → 长 hex/数字归一为 `#` → 截断。
 * @param {object} issue 审计 issue。
 * @returns {string} 指纹（带 class 的元素返回空串）。
 */
function textFingerprint (issue) {
  if (lastSegmentHasClass(stableSelector(issue.sel))) return ''
  const raw = issue.text || issue.hiddenText || issue.overlayText || ''
  if (!raw) return ''
  return String(raw)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/[A-Za-z]{12,}/g, '#')
    .slice(0, 24)
}

/** 计算一个 issue 的稳定身份键。 */
function issueKey (tab, viewport, issue) {
  return [
    tab,
    viewport,
    String(issue.rule || ''),
    String(issue.sub || ''),
    stableSelector(issue.sel),
    textFingerprint(issue),
  ].join('|')
}

// ── 审计 JSON 装载 ─────────────────────────────────────────────────────────
/**
 * 读取 JSON 文件（带前置错误信息）。
 * @param {string} path 绝对路径。
 * @param {string} label 报告用标签。
 * @returns {object} 解析后的 JSON。
 */
function readJson (path, label) {
  if (!existsSync(path)) throw new PreconditionError(`${label} 不存在：${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new PreconditionError(`${label} 不是合法 JSON：${path}（${e.message}）`)
  }
}

/**
 * 从审计 JSON 收集可比较的问题身份键。
 *
 * 防空转：解析不到任何 cell 视为前置失败（否则「没扫到 ⇒ 0 新增」是假绿）。
 * @param {object} doc 审计 JSON。
 * @param {object} opts `{label, tabs, viewports}` 过滤条件。
 * @returns {object} `{label, cells, issues, errors, keys, meta, summary}`。
 */
function collectIssues (doc, opts = {}) {
  const label = opts.label || 'audit'
  if (!doc || typeof doc !== 'object') throw new PreconditionError(`${label}: JSON 不是对象`)
  if (!Array.isArray(doc.cells)) {
    throw new PreconditionError(`${label}: 找不到 cells 数组（schema 不匹配？拒绝把空跑当 0 新增）`)
  }
  const tabs = opts.tabs?.length ? new Set(opts.tabs) : null
  const viewports = opts.viewports?.length ? new Set(opts.viewports) : null
  const keys = new Map()
  let cells = 0
  let issues = 0
  let errors = 0
  for (const cell of doc.cells) {
    if (!cell || typeof cell !== 'object') continue
    const tab = String(cell.tab || '')
    const viewport = String(cell.viewport || '')
    if (tabs && !tabs.has(tab)) continue
    if (viewports && !viewports.has(viewport)) continue
    cells++
    if (cell.error) errors++
    const list = Array.isArray(cell.result?.issues) ? cell.result.issues : []
    for (const issue of list) {
      if (!issue || typeof issue !== 'object') continue
      issues++
      const key = issueKey(tab, viewport, issue)
      const hit = keys.get(key)
      if (hit) {
        hit.count++
        continue
      }
      keys.set(key, {
        key,
        tab,
        viewport,
        rule: String(issue.rule || ''),
        sub: String(issue.sub || ''),
        tag: String(issue.tag || ''),
        selector: stableSelector(issue.sel),
        text: textFingerprint(issue),
        severity: String(issue.severity || 'low'),
        amount: issue.amount ?? issue.overlapPct ?? null,
        count: 1,
      })
    }
  }
  if (cells === 0) {
    throw new PreconditionError(`${label}: 解析不到可比 cell（原始 ${doc.cells.length} 个 cell 被过滤为空）——拒绝把空跑当 0 新增`)
  }
  return { label, cells, issues, errors, keys, meta: doc.meta || {}, summary: doc.summary || {} }
}

// ── allowlist ──────────────────────────────────────────────────────────────
/**
 * 把 allow 规则转成统一结构。
 * @param {unknown} item 字符串模式或对象。
 * @param {number} index 序号（报告用）。
 * @returns {object} `{raw, reason, fields}`。
 */
function normalizeAllowItem (item, index) {
  if (typeof item === 'string') {
    return { raw: item, reason: `allow#${index + 1}`, fields: { key: item } }
  }
  if (!item || typeof item !== 'object') throw new PreconditionError(`allow[${index}] 不是字符串或对象`)
  const known = ['tab', 'viewport', 'rule', 'sub', 'selector', 'text', 'key']
  const fields = {}
  for (const k of known) if (typeof item[k] === 'string') fields[k] = item[k]
  if (Object.keys(fields).length === 0) {
    throw new PreconditionError(`allow[${index}] 没有任何可匹配字段（支持 ${known.join('/')}）`)
  }
  return { raw: JSON.stringify(item), reason: String(item.reason || `allow#${index + 1}`), fields }
}

/**
 * 读取 allowlist JSON（`{allow:[...]}` 或直接数组）。
 * @param {string} path 文件路径（空则返回空列表）。
 * @returns {object[]} 归一化规则。
 */
function loadAllowlist (path) {
  if (!path) return []
  const doc = readJson(path, 'allowlist')
  const list = Array.isArray(doc) ? doc : doc?.allow
  if (!Array.isArray(list)) throw new PreconditionError(`allowlist 需为数组或 { allow: [...] }：${path}`)
  return list.map(normalizeAllowItem)
}

/**
 * glob（`*`/`?`）或子串匹配：含通配符按整串 glob，否则按子串。
 * @param {string} value 被匹配值。
 * @param {string} pattern 模式。
 * @returns {boolean} 是否命中。
 */
function matchPattern (value, pattern) {
  const v = String(value)
  const p = String(pattern)
  if (!/[*?]/.test(p)) return v.includes(p)
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(v)
}

/**
 * 判断某个新增问题是否被 allowlist 放行。
 * @param {object} item 新增问题。
 * @param {object[]} rules 归一化 allow 规则。
 * @returns {object|null} 命中的规则或 null。
 */
function firstAllowMatch (item, rules) {
  for (const rule of rules) {
    const fields = rule.fields
    let ok = true
    for (const [field, pattern] of Object.entries(fields)) {
      if (!matchPattern(item[field] ?? '', pattern)) { ok = false; break }
    }
    if (ok) return rule
  }
  return null
}

// ── 比较 ───────────────────────────────────────────────────────────────────
/**
 * 比较两份审计结果。
 * @param {object} base collectIssues 结果（baseline）。
 * @param {object} cur collectIssues 结果（current）。
 * @param {object} opts `{allowRules}`。
 * @returns {object} `{base, cur, blocking, allowed, gone, changed}`。
 */
function compareRuns (base, cur, opts = {}) {
  const allowRules = opts.allowRules || []
  const blocking = []
  const allowed = []
  for (const item of cur.keys.values()) {
    if (base.keys.has(item.key)) continue
    const rule = firstAllowMatch(item, allowRules)
    if (rule) allowed.push({ ...item, allowReason: rule.reason })
    else blocking.push(item)
  }
  blocking.sort(compareSeverityThenKey)
  allowed.sort(compareSeverityThenKey)
  const gone = [...base.keys.values()].filter((item) => !cur.keys.has(item.key)).sort(compareSeverityThenKey)
  const changed = []
  for (const item of cur.keys.values()) {
    const before = base.keys.get(item.key)
    if (!before) continue
    const sevChanged = SEVERITY_RANK[item.severity] !== SEVERITY_RANK[before.severity]
    if (sevChanged || item.count !== before.count) {
      changed.push({ ...item, baselineSeverity: before.severity, baselineCount: before.count })
    }
  }
  changed.sort(compareSeverityThenKey)
  return { base, cur, blocking, allowed, gone, changed }
}

/** 排序：严重度降序，再按身份键。 */
function compareSeverityThenKey (a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
  return d !== 0 ? d : String(a.key).localeCompare(String(b.key))
}

/**
 * 由比较结果决定退出码。
 * @param {object} report compareRuns 结果。
 * @returns {number} 退出码（0 无阻塞新增 / 2 有阻塞新增）。
 */
function decideExit (report) {
  return report.blocking.length > 0 ? EXIT.NEW : EXIT.OK
}

// ── 输出：控制台 + Markdown 报告 ────────────────────────────────────────────
/** 单条问题的短描述（控制台用）。 */
function shortIssue (item) {
  const text = item.text ? `「${item.text}」` : ''
  return `[${item.severity}] ${item.tab}@${item.viewport} ${item.rule}/${item.sub || '-'} ${item.selector}${text}`
}

/**
 * 打印控制台摘要。
 * @param {object} report 比较结果。
 * @param {object} meta `{baselinePath, currentPath, scope, reportPath}`。
 * @returns {void}
 */
function printConsole (report, meta) {
  const { base, cur } = report
  console.log('\n── 响应式差异门禁 ──')
  console.log(`基线：${meta.baselinePath}`)
  console.log(`  label=${base.meta.label || '-'}  tab=${base.meta.tabsRun?.length ?? '?'}  cell=${base.cells}  问题=${base.issues}  失败格=${base.errors}`)
  console.log(`当前：${meta.currentPath}`)
  console.log(`  label=${cur.meta.label || '-'}  tab=${cur.meta.tabsRun?.length ?? '?'}  cell=${cur.cells}  问题=${cur.issues}  失败格=${cur.errors}`)
  console.log(`范围：${meta.scope}`)
  console.log(`新增（阻塞）：${report.blocking.length}    新增（allowlist 放行）：${report.allowed.length}`)
  console.log(`消失：${report.gone.length}    变化（仅提示）：${report.changed.length}`)
  for (const item of report.blocking.slice(0, 30)) console.log(`  ✗ ${shortIssue(item)}`)
  if (report.blocking.length > 30) console.log(`  … 其余 ${report.blocking.length - 30} 条见报告`)
  for (const item of report.allowed.slice(0, 10)) console.log(`  ~ allow[${item.allowReason}] ${shortIssue(item)}`)
  if (report.allowed.length > 10) console.log(`  … 其余 ${report.allowed.length - 10} 条放行见报告`)
  if (report.gone.length) console.log(`  （消失属于修复/数据变少，仅提示：前 3 条 ${report.gone.slice(0, 3).map((i) => `${i.tab}@${i.viewport}:${i.rule}`).join(' / ')}）`)
  const pass = report.blocking.length === 0
  console.log(`\n结论：${pass ? 'PASS（无阻塞新增）' : `FAIL（新增 ${report.blocking.length} 条未放行问题）`}`)
  if (meta.reportPath) console.log(`报告：${meta.reportPath}`)
}

/** Markdown 表格行转义。 */
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
  L.push('# 响应式差异门禁报告')
  L.push('')
  L.push(`> 由 \`scripts/ui-responsive-gate.mjs\` 生成（${new Date().toISOString()}）。命令：\`${meta.command}\``)
  L.push('')
  L.push(`## 结论：${pass ? 'PASS' : 'FAIL'}`)
  L.push('')
  L.push('| 项 | 值 |')
  L.push('|---|---|')
  L.push(`| 基线 | \`${meta.baselinePath}\`（label=${mdCell(base.meta.label || '-')}，cell=${base.cells}，问题=${base.issues}） |`)
  L.push(`| 当前 | \`${meta.currentPath}\`（label=${mdCell(cur.meta.label || '-')}，cell=${cur.cells}，问题=${cur.issues}） |`)
  L.push(`| 比较范围 | ${mdCell(meta.scope)} |`)
  L.push(`| 新增（阻塞） | **${report.blocking.length}** |`)
  L.push(`| 新增（allowlist 放行） | ${report.allowed.length} |`)
  L.push(`| 消失（仅提示） | ${report.gone.length} |`)
  L.push(`| 变化（severity/条数，仅提示） | ${report.changed.length} |`)
  L.push('')
  L.push('## 新增问题（阻塞）')
  L.push('')
  if (report.blocking.length === 0) {
    L.push('无。')
  } else {
    L.push('| # | 严重度 | tab | 视口 | 规则 | 选择器（稳定前缀） | 文本指纹 |')
    L.push('|---:|---|---|---|---|---|---|')
    report.blocking.forEach((item, i) => {
      L.push(`| ${i + 1} | ${item.severity} | \`${mdCell(item.tab)}\` | ${mdCell(item.viewport)} | ${item.rule}/${mdCell(item.sub || '-')} | \`${mdCell(item.selector)}\` | ${mdCell(item.text || '-')} |`)
    })
  }
  L.push('')
  L.push('## allowlist 放行')
  L.push('')
  if (report.allowed.length === 0) {
    L.push('无。')
  } else {
    L.push('| # | 原因 | 严重度 | tab | 视口 | 规则 | 选择器 | 文本指纹 |')
    L.push('|---:|---|---|---|---|---|---|---|')
    report.allowed.forEach((item, i) => {
      L.push(`| ${i + 1} | ${mdCell(item.allowReason)} | ${item.severity} | \`${mdCell(item.tab)}\` | ${mdCell(item.viewport)} | ${item.rule}/${mdCell(item.sub || '-')} | \`${mdCell(item.selector)}\` | ${mdCell(item.text || '-')} |`)
    })
  }
  L.push('')
  L.push('## 消失（仅提示：修复/数据变少）')
  L.push('')
  if (report.gone.length === 0) {
    L.push('无。')
  } else {
    for (const item of report.gone.slice(0, 200)) L.push(`- [${item.severity}] \`${item.tab}@${item.viewport}\` ${item.rule}/${item.sub || '-'} \`${item.selector}\``)
    if (report.gone.length > 200) L.push(`- … 其余 ${report.gone.length - 200} 条`)
  }
  L.push('')
  L.push('## 变化（仅提示）')
  L.push('')
  if (report.changed.length === 0) {
    L.push('无。')
  } else {
    L.push('| tab | 视口 | 规则 | 变化 |')
    L.push('|---|---|---|---|')
    for (const item of report.changed.slice(0, 100)) {
      const delta = []
      if (item.baselineSeverity !== item.severity) delta.push(`${item.baselineSeverity}→${item.severity}`)
      if (item.baselineCount !== item.count) delta.push(`条数 ${item.baselineCount}→${item.count}`)
      L.push(`| \`${mdCell(item.tab)}\` | ${mdCell(item.viewport)} | ${item.rule}/${mdCell(item.sub || '-')} | ${mdCell(delta.join('；'))} |`)
    }
    if (report.changed.length > 100) L.push(`| … | | | 其余 ${report.changed.length - 100} 条 |`)
  }
  L.push('')
  L.push('## 口径与局限')
  L.push('')
  L.push('- 身份键 = `tab|viewport|rule|sub|选择器稳定前缀|文本指纹`，不含 rect/顺序/时间，数据态抖动不误报；CSS Modules 哈希已剥离。')
  L.push('- 新增即阻塞（exit 2）；消失/变化只提示；条数增加算「变化」不算新增（同一身份键）。')
  L.push('- 必须用**真实数据机器**先跑 `npm run ui:responsive-audit` 产出 current；CI 无真实数据，暂不挂 CI job。')
  L.push('- `--quick` 只比较 390×844 / 1280×800 / 2560×1440；`--only` 限定 tab；两者都会缩小「消失」的参照面。')
  L.push('- allowlist 只放行新增，不隐藏消失/变化；每条须有 reason，便于季度清理。')
  L.push('')
  return L.join('\n')
}

// ── --run：spawn 审计脚本 ──────────────────────────────────────────────────
/** 与审计脚本一致的 label→文件名 slug。 */
const slug = (s) => String(s).replace(/[^\w.-]+/g, '_')

/**
 * 调用审计脚本跑一次 current（子进程），返回 JSON 路径。
 * @param {object} opts `{only, quick, viewports, out, reportDir, label, shots}`。
 * @returns {string} 产出的 JSON 绝对路径。
 */
function runAudit (opts) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const label = opts.label || `gate-${stamp}`
  const outDir = resolve(ROOT, opts.out || join('working', 'team', 'responsive'))
  const reportDir = resolve(ROOT, opts.reportDir || join('working', 'team', 'responsive', 'gate-runs'))
  const args = [AUDIT_SCRIPT, `--label=${label}`, `--out=${outDir}`, `--report-dir=${reportDir}`]
  if (opts.only) args.push(`--only=${opts.only}`)
  if (opts.quick) args.push('--quick')
  if (opts.viewports) args.push(`--viewports=${opts.viewports}`)
  if (!opts.shots) args.push('--no-shots')
  console.log(`\n[--run] ${process.execPath} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (res.error) throw new PreconditionError(`审计子进程无法启动：${res.error.message}`)
  if (res.status !== 0) throw new PreconditionError(`审计子进程失败（exit ${res.status}）；--run 需要本机真实数据与 Electron`)
  const jsonPath = join(outDir, `${slug(label)}.json`)
  if (!existsSync(jsonPath)) throw new PreconditionError(`审计子进程未产出预期 JSON：${jsonPath}`)
  return jsonPath
}

// ── 自检 ───────────────────────────────────────────────────────────────────
/** 构造最小审计 JSON（selftest 用）。 */
function makeDoc (label, cells) {
  const issues = cells.reduce((n, c) => n + (c.result?.issues?.length || 0), 0)
  return { meta: { label, at: new Date().toISOString() }, summary: { cells: cells.length, issuesTotal: issues }, cells }
}

/** 构造 cell。 */
const makeCell = (tab, viewport, issues) => ({ tab, viewport, error: null, result: { issues } })

/** 构造 issue。 */
const makeIssue = (over = {}) => ({
  rule: 'clipped',
  sub: 'y-clip',
  severity: 'low',
  tag: 'div',
  id: '',
  cls: '_moreRow_1tp7d_315',
  sel: 'div._board_1tp7d_387 > div._moreRow_1tp7d_315',
  text: '',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  amount: 3,
  ...over,
})

/**
 * 用内存夹具验证「新增 / 消失 / allowlist / 防空转」各路径。
 * @returns {boolean} 全部通过为 true。
 */
function runSelftest () {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`)
  }
  const baseIssue = makeIssue()
  const baseDoc = makeDoc('fixture-base', [
    makeCell('annual', '390x844', [baseIssue]),
    makeCell('monitor', '390x844', [makeIssue({ rule: 'hidden', sub: 'display-none', severity: 'medium', tag: 'button', cls: '_railToggle_1hrzk_343', sel: 'div._stage_1hrzk_100 > button._railToggle_1hrzk_343', text: '⚙ 参数' })]),
  ])
  const collectBase = collectIssues(baseDoc, { label: 'fixture-base' })

  // 1) 相同输入 → 无新增、无消失
  {
    const cur = collectIssues(makeDoc('fixture-same', baseDoc.cells), { label: 'fixture-same' })
    const report = compareRuns(collectBase, cur)
    check('相同输入无新增/无消失', report.blocking.length === 0 && report.gone.length === 0 && decideExit(report) === 0)
  }
  // 2) CSS Modules 哈希漂移（真实重建）→ 同一身份键，不误报
  {
    const rebuilt = makeDoc('fixture-rebuild', [
      makeCell('annual', '390x844', [makeIssue({ cls: '_moreRow_9zzz9_901', sel: 'div._board_9zzz9_777 > div._moreRow_9zzz9_901' })]),
      makeCell('monitor', '390x844', [makeIssue({ rule: 'hidden', sub: 'display-none', severity: 'medium', tag: 'button', cls: '_railToggle_9zzz9_901', sel: 'div._stage_9zzz9_777 > button._railToggle_9zzz9_901', text: '⚙ 参数' })]),
    ])
    const report = compareRuns(collectBase, collectIssues(rebuilt, { label: 'fixture-rebuild' }))
    check('CSS 哈希漂移不误报', report.blocking.length === 0 && report.gone.length === 0)
  }
  // 3) 数据文本漂移（通用 span 的好友数变化）→ 文本指纹归一，不误报
  {
    const chat = (n) => makeDoc(`fixture-chat-${n}`, [makeCell('chats', '390x844', [makeIssue({ rule: 'hidden', sub: 'display-none', severity: 'low', tag: 'span', cls: '', sel: 'div._sidebar_1phmn_10 > span', text: `好友${n}` })])])
    const report = compareRuns(collectIssues(chat(94), { label: 'chat94' }), collectIssues(chat(232), { label: 'chat232' }))
    check('数据文本漂移不误报（好友94→好友232）', report.blocking.length === 0)
  }
  // 4) 新增问题 → exit 2
  {
    const curDoc = makeDoc('fixture-new', [
      baseDoc.cells[0],
      makeCell('monitor', '390x844', []),
      makeCell('ledger', '390x844', [makeIssue({ rule: 'occluded', sub: 'intercepted', severity: 'high', tag: 'button', cls: '_headBtn_7h5w0_231', sel: 'div._card_7h5w0_12 > button._headBtn_7h5w0_231', text: '打开完整会话' })]),
    ])
    const report = compareRuns(collectBase, collectIssues(curDoc, { label: 'fixture-new' }))
    check('新增问题 → exit 2', report.blocking.length === 1 && decideExit(report) === 2)
  }
  // 5) 消失问题 → exit 0 + 消失提示
  {
    const curDoc = makeDoc('fixture-gone', [makeCell('annual', '390x844', [])])
    const report = compareRuns(collectBase, collectIssues(curDoc, { label: 'fixture-gone' }))
    check('消失问题只提示（exit 0）', report.blocking.length === 0 && report.gone.length >= 1 && decideExit(report) === 0)
  }
  // 6) allowlist 放行新增 → exit 0 + 放行计数
  {
    const curDoc = makeDoc('fixture-allow', [baseDoc.cells[0], makeCell('monitor', '390x844', []), makeCell('ledger', '390x844', [makeIssue({ rule: 'occluded', sub: 'intercepted', severity: 'high', tag: 'button', cls: '_headBtn_7h5w0_231', sel: 'div._card_7h5w0_12 > button._headBtn_7h5w0_231', text: '打开完整会话' })])])
    const allow = [normalizeAllowItem({ tab: 'ledger', rule: 'occluded', selector: '*_headBtn*', reason: 'known' }, 0)]
    const report = compareRuns(collectBase, collectIssues(curDoc, { label: 'fixture-allow' }), { allowRules: allow })
    check('allowlist 放行新增 → exit 0', report.blocking.length === 0 && report.allowed.length === 1 && decideExit(report) === 0)
  }
  // 7) 防空转：解析不到 cell 必须前置失败（exit 3 语义）
  {
    let thrown = null
    try {
      collectIssues({ meta: {} }, { label: 'fixture-empty' })
    } catch (e) { thrown = e }
    check('防空转：无 cells 抛前置错误', thrown instanceof PreconditionError)
    let thrown2 = null
    try {
      collectIssues(makeDoc('fixture-filtered', [makeCell('annual', '390x844', [])]), { label: 'fixture-filtered', tabs: ['ledger'] })
    } catch (e) { thrown2 = e }
    check('防空转：过滤后 0 cell 抛前置错误', thrown2 instanceof PreconditionError)
  }
  // 8) --only / --quick 过滤生效
  {
    const doc = makeDoc('fixture-filter', [makeCell('annual', '390x844', [baseIssue]), makeCell('annual', '768x1024', [baseIssue]), makeCell('ledger', '390x844', [])])
    const only = collectIssues(doc, { label: 'only', tabs: ['annual'] })
    const quick = collectIssues(doc, { label: 'quick', viewports: QUICK_VIEWPORTS })
    check('--only/--quick 过滤生效', only.cells === 2 && quick.cells === 2)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n自检结果：${failed.length === 0 ? `${results.length}/${results.length} 通过` : `失败 ${failed.map((r) => r.name).join(', ')}`}`)
  return failed.length === 0
}

// ── main ───────────────────────────────────────────────────────────────────
/**
 * 入口。
 * @returns {number} 退出码。
 */
function main () {
  if (flag('selftest')) return runSelftest() ? EXIT.OK : EXIT.BUG
  const baselinePath = resolve(ROOT, str('baseline', ''))
  const only = listArg('only')
  const quick = flag('quick')
  const viewports = quick ? QUICK_VIEWPORTS : listArg('viewports')
  if (!baselinePath || baselinePath === ROOT) throw new PreconditionError('缺少 --baseline=<audit.json>')
  const allowRules = loadAllowlist(str('allow', ''))

  let currentPath = resolve(ROOT, str('current', ''))
  const run = flag('run')
  if (run && str('current', '')) throw new PreconditionError('--run 与 --current 只能二选一')
  if (!run && !str('current', '')) throw new PreconditionError('缺少 --current=<audit.json>（或使用 --run 现场跑审计）')
  if (run) {
    currentPath = runAudit({
      only: only.join(','),
      quick,
      viewports: str('viewports', ''),
      out: str('out', ''),
      reportDir: str('report-dir', ''),
      label: str('label', ''),
      shots: flag('shots'),
    })
  }

  const scope = [only.length ? `only=${only.join(',')}` : '全部 tab', quick ? 'quick 视口（390/1280/2560）' : (viewports.length ? `视口=${viewports.join(',')}` : '全部视口')].join(' · ')
  const base = collectIssues(readJson(baselinePath, '基线'), { label: '基线', tabs: only, viewports })
  const cur = collectIssues(readJson(currentPath, '当前'), { label: '当前', tabs: only, viewports })
  const report = compareRuns(base, cur, { allowRules })
  const reportPath = str('report', '') ? resolve(ROOT, str('report', '')) : ''
  const meta = {
    baselinePath,
    currentPath,
    scope,
    reportPath,
    command: `node scripts/ui-responsive-gate.mjs ${process.argv.slice(2).join(' ')}`,
  }
  printConsole(report, meta)
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, buildMarkdown(report, meta), 'utf8')
    console.log(`（Markdown 报告已写入 ${reportPath}）`)
  }
  if (cur.errors > 0) console.log(`⚠ 当前基线有 ${cur.errors} 个执行失败格（error 字段），这些格不会贡献身份键，请先确认审计本身跑通。`)
  return decideExit(report)
}

try {
  const code = main()
  process.exitCode = code
} catch (e) {
  if (e instanceof PreconditionError) {
    console.error(`\n[前置失败] ${e.message}`)
    console.error('提示：先 `npm run ui:responsive-audit` 产出真实数据基线 JSON，或检查 --baseline/--current 路径。')
    process.exitCode = EXIT.PRECONDITION
  } else {
    console.error('\n[gate 内部错误]', e?.stack ?? e)
    process.exitCode = EXIT.BUG
  }
}
