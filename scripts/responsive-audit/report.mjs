/**
 * 响应式审计 · 基线汇总与 Markdown 生成。
 *
 * 从 `scripts/responsive-audit.mjs` **机械拆出**：`buildSummary`（逐格 → 统计/Top offenders）
 * 与 `buildBaselineMarkdown`（生成 `working/team/responsive-baseline.md`）。
 * 输出格式/排序权重与原文件一致；唯一改动是把对入口级 `TABS` 变量的引用换成
 * `meta.tabsRun`（两者在入口里本就相等，拆分后消除跨模块闭包）。
 *
 * @module scripts/responsive-audit/report
 */
import { RULE_ORDER, RULE_CN, SEVERITY_WEIGHT, RULE_WEIGHT } from './setup.mjs'

// ══════════════════════════════════════════════════════════════════════════
// 汇总：Top offenders / 分类统计 / tab×视口矩阵
// ══════════════════════════════════════════════════════════════════════════
/**
 * 从逐格结果汇总基线统计。
 * @param {Array<object>} cellList 逐格结果。
 * @param {Array<{tab:string,label:string,hidden:boolean}>} tabList 页签清单（保持源码顺序）。
 * @param {Array<{label:string}>} vpList 视口清单。
 * @returns {object} summary。
 */
export function buildSummary (cellList, tabList, vpList) {
  const byRule = {}
  for (const rule of RULE_ORDER) byRule[rule] = { issues: 0, detected: 0, tabs: new Set(), cells: 0, truncated: 0 }
  const byViewport = {}
  for (const vp of vpList) byViewport[vp.label] = { issues: 0, cells: 0, cellsWithIssues: 0 }
  const byTab = {}
  for (const t of tabList) byTab[t.tab] = { label: t.label, hidden: t.hidden, issues: 0, cells: 0, byViewport: {}, errors: 0 }
  const offenders = new Map()

  for (const cell of cellList) {
    const vp = byViewport[cell.viewport]
    if (!vp) continue
    vp.cells++
    const tabStat = byTab[cell.tab]
    if (tabStat) { tabStat.cells++; tabStat.byViewport[cell.viewport] = cell.total ?? 0 }
    if (cell.error) { if (tabStat) tabStat.errors++; continue }
    if (cell.total > 0) vp.cellsWithIssues++
    vp.issues += cell.total ?? 0
    if (tabStat) tabStat.issues += cell.total ?? 0
    const result = cell.result
    if (!result) continue
    for (const rule of RULE_ORDER) {
      const list = result.issues.filter((i) => i.rule === rule)
      if (list.length === 0) continue
      byRule[rule].issues += list.length
      byRule[rule].cells++
      byRule[rule].tabs.add(cell.tab)
      byRule[rule].detected += result.counts?.detected?.[rule] ?? list.length
      byRule[rule].truncated += result.counts?.truncated?.[rule] ?? 0
    }
    for (const issue of result.issues) {
      // 归并键：规则 + 元素身份（标签/首个类名/选择器路径）。**不含文本**：
      // 同一条列表里的每行（「a爸」「房东」…）是同一类缺陷，按行拆开会把 Top offenders 刷满。
      const key = `${issue.rule}|${issue.sub}|${issue.tag}|${(issue.cls || '').split(' ')[0] ?? ''}|${(issue.sel || '').slice(0, 120)}`
      let o = offenders.get(key)
      if (!o) {
        o = {
          key, rule: issue.rule, sub: issue.sub, tag: issue.tag, id: issue.id, cls: issue.cls,
          sel: issue.sel, text: issue.text, count: 0, tabs: new Set(), viewports: new Set(),
          maxSeverity: 'low', maxAmount: 0, samples: [],
        }
        offenders.set(key, o)
      }
      o.count++
      o.tabs.add(cell.tab)
      o.viewports.add(cell.viewport)
      if (SEVERITY_WEIGHT[issue.severity] > SEVERITY_WEIGHT[o.maxSeverity]) o.maxSeverity = issue.severity
      if (Number(issue.amount) > o.maxAmount) o.maxAmount = Number(issue.amount)
      if (o.samples.length < 3) o.samples.push({ tab: cell.tab, viewport: cell.viewport, rect: issue.rect })
    }
  }

  const topOffenders = [...offenders.values()]
    .map((o) => {
      const score = o.count * (RULE_WEIGHT[o.rule] ?? 10) * SEVERITY_WEIGHT[o.maxSeverity]
      return {
        ...o,
        tabs: [...o.tabs],
        viewports: [...o.viewports],
        // 隐藏类问题若只在部分视口出现 → 是「响应式隐藏」（窄屏把内容藏了）；
        // 所有视口都隐藏 → 更像是状态性的隐藏（如未激活的折叠区），两者修法不同。
        responsiveHidden: o.rule === 'hidden' && o.viewports.size < vpList.length,
        score,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)

  const ruleOut = {}
  for (const rule of RULE_ORDER) {
    ruleOut[rule] = {
      issues: byRule[rule].issues,
      detected: byRule[rule].detected,
      cells: byRule[rule].cells,
      tabs: byRule[rule].tabs.size,
      tabList: [...byRule[rule].tabs],
      truncated: byRule[rule].truncated,
    }
  }
  return {
    cells: cellList.length,
    cellsWithIssues: cellList.filter((c) => (c.total ?? 0) > 0).length,
    cellsWithErrors: cellList.filter((c) => c.error).length,
    issuesTotal: cellList.reduce((s, c) => s + (c.total ?? 0), 0),
    tabs: tabList.length,
    viewports: vpList.length,
    byRule: ruleOut,
    byViewport,
    byTab,
    topOffenders,
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Markdown 基线
// ══════════════════════════════════════════════════════════════════════════
/**
 * 生成 `responsive-baseline.md`。
 * @param {{meta:object, summary:object, cells:Array<object>}} doc 基线 JSON 文档。
 * @returns {string} Markdown 文本。
 */
export function buildBaselineMarkdown (doc) {
  const { meta, summary } = doc
  const L = []
  const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—')
  L.push('# 响应式审计基线（38 tab × 6 视口）')
  L.push('')
  L.push(`> 本文件由 \`scripts/responsive-audit.mjs\` 自动生成，请勿手改；重跑命令见 \`working/team/responsive-audit.md\`。`)
  L.push('')
  L.push('## 运行信息')
  L.push('')
  L.push('| 项 | 值 |')
  L.push('|---|---|')
  L.push(`| 生成时间 | ${meta.at}（耗时 ${(meta.durationMs / 1000).toFixed(1)}s） |`)
  L.push(`| label | \`${meta.label}\` |`)
  L.push(`| 分支 / 提交 | \`${meta.git}\` |`)
  L.push(`| Electron / Node / Playwright | ${meta.electron} / ${meta.node} / ${meta.playwright} |`)
  L.push(`| 页签 | ${meta.tabsRun.length} / ${meta.tabsParsed}（hidden ${meta.tabsRun.filter((t) => t.hidden).length} 个，经深链进入） |`)
  L.push(`| 视口 | ${meta.viewports.map((v) => `${v.label}`).join(' / ')} |`)
  L.push(`| 真实 profile | \`${meta.userDataSource}\` |`)
  L.push(`| 真实数据根 | \`${meta.dataRoot || '（未确定）'}\` |`)
  L.push(`| 首启闸门 | ${meta.profileGates === 'seeded' ? '复制真实状态（无调试横幅）' : '⚠ 回退 SKIP_ONBOARDING（界面含调试横幅）'} |`)
  L.push(`| 截图 | ${meta.screenshots} 张（\`working/team/responsive/shots/\`） |`)
  L.push('')
  L.push('## 检测口径')
  L.push('')
  L.push('| 规则 | 判据（阈值） |')
  L.push('|---|---|')
  L.push(`| ① 文档横向溢出 | \`documentElement.scrollWidth > innerWidth + ${meta.thresholds.docOverflowPx}\` |`)
  L.push(`| ② 元素越界 | \`rect.right > innerWidth + ${meta.thresholds.viewportOverflowPx}\` 或 \`rect.left < -${meta.thresholds.viewportOverflowPx}\`；排除横向可滚容器内与被祖先裁住的内容，只报最外层元凶 |`)
  L.push(`| ③ 裁切 | X：\`scrollWidth−clientWidth > ${meta.thresholds.clipPx}\` 且 overflow-x∈visible/hidden/clip（visible 需真的露出祖先盒子）；Y：仅 hidden/clip。排除 auto/scroll、表单控件、line-clamp/ellipsis（有意截断不计）、content-visibility:auto、纯装饰层、纯图片缩略图容器 |`)
  L.push(`| ④ 遮挡 | fixed/sticky 且 z-index>0 的**实际可绘制**覆盖层（checkVisibility + 祖先 overflow 裁剪链判定）∩ **实际可绘制**的可交互/文本元素 ≥ ${Math.round(meta.thresholds.occlusionOverlapPct * 100)}% 面积，且目标中心 \`elementFromPoint\` 命中的是该覆盖层（归因到真正命中的那层）；位于滚动视口外的内容不计；顶部/底部/粘性 chrome 若滚动到底可移出则不计 |`)
  L.push('| ⑤ 有文本不可见 | 直接文本非空但自身/祖先 display:none、visibility:hidden、零尺寸或 opacity:0；排除 aria-hidden / sr-only / 标题栏与侧栏 / nav 导航 / opacity:0 的 1-2 字符装饰 |')
  L.push('')
  L.push('## 总览')
  L.push('')
  L.push(`- 格子：**${summary.cells}**（${summary.tabs} tab × ${summary.viewports} 视口），失败格 ${summary.cellsWithErrors}`)
  L.push(`- 有问题的格子：**${summary.cellsWithIssues}**（${pct(summary.cellsWithIssues, summary.cells)}）`)
  L.push(`- 问题条数（去重后保留）：**${summary.issuesTotal}**`)
  L.push('')
  L.push('| 规则 | 保留条数 | 检出条数（截断前） | 涉及 tab | 涉及格子 | 被截断条数 |')
  L.push('|---|---:|---:|---:|---:|---:|')
  for (const rule of RULE_ORDER) {
    const s = summary.byRule[rule]
    L.push(`| ${RULE_CN[rule]} | ${s.issues} | ${s.detected} | ${s.tabs} | ${s.cells} | ${s.truncated} |`)
  }
  L.push('')
  L.push('### 按视口')
  L.push('')
  L.push('| 视口 | 问题条数 | 有问题格子 | 格子数 | 占比 |')
  L.push('|---|---:|---:|---:|---:|')
  for (const vp of meta.viewports) {
    const s = summary.byViewport[vp.label]
    if (!s) continue
    L.push(`| ${vp.label} | ${s.issues} | ${s.cellsWithIssues} | ${s.cells} | ${pct(s.cellsWithIssues, s.cells)} |`)
  }
  L.push('')
  L.push('## tab × 视口问题数矩阵')
  L.push('')
  L.push('`0` = 该格无问题；`·` = 未跑；`ERR` = 该格执行失败。数字为该格保留的问题条数（含 low）。')
  L.push('')
  const header = ['#', 'tab', '页签', ...meta.viewports.map((v) => v.label), '合计']
  L.push(`| ${header.join(' | ')} |`)
  L.push(`|${header.map((h, i) => (i === 0 ? '---:' : i === 1 || i === 2 ? '---' : '---:')).join('|')}|`)
  for (const [i, t] of meta.tabsRun.entries()) {
    const st = summary.byTab[t.tab]
    if (!st) continue
    const cols = meta.viewports.map((v) => {
      const cell = doc.cells.find((c) => c.tab === t.tab && c.viewport === v.label)
      if (!cell) return '·'
      if (cell.error) return 'ERR'
      return String(cell.total ?? 0)
    })
    L.push(`| ${i + 1} | \`${t.tab}\`${t.hidden ? ' †' : ''} | ${t.label} | ${cols.join(' | ')} | ${st.issues} |`)
  }
  L.push('')
  L.push('† = 侧栏不渲染（hidden），通过深链/父面板分段到达；同一 tab 与父 tab 的视图可能重合（见「路由别名」）。')
  L.push('')
  L.push('## Top offenders（前 10）')
  L.push('')
  L.push('排序分 = 出现次数 × 规则权重（①100 ②60 ③40 ④30 ⑤20）× 最高严重度（high 3 / medium 2 / low 1）。')
  L.push('')
  if (summary.topOffenders.length === 0) {
    L.push('_本次没有检出问题（或全部被排除规则过滤）。_')
  } else {
    L.push('| # | 规则 | 元素 | 文本 | 次数 | 涉及 tab | 出现视口 | 最高严重度 | 最大溢出 |')
    L.push('|---:|---|---|---|---:|---:|---|---:|---:|')
    for (const [i, o] of summary.topOffenders.slice(0, 10).entries()) {
      const el = `\`${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(' ')[0] : ''}\``
      const tabs = o.tabs.length <= 4 ? o.tabs.map((t) => `\`${t}\``).join(' ') : `${o.tabs.slice(0, 4).map((t) => `\`${t}\``).join(' ')} 等 ${o.tabs.length} 个`
      L.push(`| ${i + 1} | ${RULE_CN[o.rule] ?? o.rule} | ${el} | ${o.text ? `「${o.text.replace(/\|/g, '\\|').slice(0, 28)}」` : '—'} | ${o.count} | ${tabs} | ${o.viewports.join(' / ')} | ${o.maxSeverity} | ${o.maxAmount || '—'} |`)
    }
  }
  L.push('')
  L.push('### 各规则 Top 5（按出现次数）')
  L.push('')
  for (const rule of RULE_ORDER) {
    const list = summary.topOffenders.filter((o) => o.rule === rule).slice(0, 5)
    L.push(`#### ${RULE_CN[rule]}`)
    L.push('')
    if (list.length === 0) {
      L.push('_无。_')
    } else {
      for (const [i, o] of list.entries()) {
        const responsive = o.responsiveHidden ? `；仅 ${o.viewports.length}/${summary.viewports} 个视口隐藏（响应式隐藏）` : ''
        L.push(`${i + 1}. \`${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(' ')[0] : ''}\` — ${o.count} 次 / ${o.tabs.length} tab${responsive}；${o.text ? `文本「${o.text.slice(0, 32)}」；` : ''}选择器：\`${o.sel.slice(0, 150)}\`${o.maxAmount ? `；最大溢出 ${o.maxAmount}px` : ''}`)
      }
    }
    L.push('')
  }
  // 路由别名：多个 tab 落到同一面板外壳（同一 dialog / 同一 MergedSections / KbShell 等）。
  L.push('## 同外壳 tab（落到同一面板外壳，不同分段/深链入口）')
  L.push('')
  const sigMap = new Map()
  for (const cell of doc.cells) {
    if (cell.viewport !== meta.viewports[0].label || !cell.result) continue
    const sig = cell.result.resolved.signature
    if (!sigMap.has(sig)) sigMap.set(sig, [])
    sigMap.get(sig).push(cell.tab)
  }
  const aliasGroups = [...sigMap.values()].filter((g) => g.length > 1)
  if (aliasGroups.length === 0) {
    L.push('_无：每个 tab 都解析到了不同视图。_')
  } else {
    for (const g of aliasGroups) L.push(`- ${g.map((t) => `\`${t}\``).join(' = ')}`)
    L.push('')
    L.push('> 这些 tab 在应用里落到同一个面板外壳（不同分段 / dialog 分节 / 深链入口），基线里数值相近属预期；')
    L.push('> 分段内部的真实内容可能不同，修复时仍需各自复测。')
  }
  L.push('')
  L.push('## 执行失败格')
  L.push('')
  const errCells = doc.cells.filter((c) => c.error)
  if (errCells.length === 0) L.push('_无。_')
  else for (const c of errCells) L.push(`- \`${c.tab}\` @ ${c.viewport}：${c.error}`)
  L.push('')
  L.push('## 局限')
  L.push('')
  for (const lim of meta.limitations) L.push(`- ${lim}`)
  L.push('- 每个 tab 只测初次进入的默认状态；重查询面板（资金统计、年度报告等）在快照时可能仍在后台统计，此时读到的是「加载态布局」，重跑一次可确认。')
  L.push('- 报告里的「问题条数」是**保留条数**；超过每格每类 15 条的会被截断（见上表「被截断条数」），JSON 中 `counts.truncated` 有记录。')
  L.push('')
  return L.join('\n')
}
