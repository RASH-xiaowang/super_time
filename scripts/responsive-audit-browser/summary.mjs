/**
 * 手机浏览器审计的汇总与打印（Wave 3 从入口文件机械拆出，输出格式未改）。
 *
 * @module scripts/responsive-audit-browser/summary
 */
import { RULE_ORDER } from '../responsive-audit/setup.mjs'

/**
 * 汇总手机浏览器专项观测（不并入五类规则，单独成表，避免改变与桌面基线的可比性）。
 * @param {Array<object>} cells
 */
 export function summarizeMobile (cells) {
  const ok = cells.filter((c) => !c.error && c.mobile)
  const out = {
    cells: ok.length,
    viewportFitCover: { cells: ok.filter((c) => c.mobile.hasViewportFitCover).length, total: ok.length },
    titlebarRemoved: { cells: ok.filter((c) => !c.mobile.titlebarPresent).length, total: ok.length },
    heightMismatch: [],
    tinyTargets: [],
    smallText: [],
    hoverOnlyRules: [],
    fixedBottom: [],
    horizontalScroll: [],
    shellMismatch: [],
  }
  for (const c of ok) {
    const m = c.mobile
    const diff = m.heights.html - m.viewport.vh
    if (Math.abs(diff) > 1) out.heightMismatch.push({ tab: c.tab, vp: c.viewport, htmlH: m.heights.html, vh: m.viewport.vh, diff })
    if (m.tinyTargets.count > 0) out.tinyTargets.push({ tab: c.tab, vp: c.viewport, count: m.tinyTargets.count, sample: m.tinyTargets.sample.slice(0, 3) })
    if (m.smallText.count > 0) out.smallText.push({ tab: c.tab, vp: c.viewport, count: m.smallText.count, sample: m.smallText.sample.slice(0, 2) })
    if (m.hoverOnly.ruleCount > 0) out.hoverOnlyRules.push({ tab: c.tab, vp: c.viewport, count: m.hoverOnly.ruleCount })
    if (m.fixedBottom.length > 0) out.fixedBottom.push({ tab: c.tab, vp: c.viewport, items: m.fixedBottom.slice(0, 3) })
    if (m.scroll.docScrollWidth > m.scroll.innerWidth + 1) out.horizontalScroll.push({ tab: c.tab, vp: c.viewport, docScrollWidth: m.scroll.docScrollWidth, innerWidth: m.scroll.innerWidth })
    const isLandscapePhone = m.viewport.vw > m.viewport.vh && m.viewport.vh <= 500
    if (isLandscapePhone && m.shell.bottomNav) out.shellMismatch.push({ tab: c.tab, vp: c.viewport, note: '横屏仍渲染移动底栏' })
    if (!isLandscapePhone && m.viewport.vw <= 560 && !m.shell.bottomNav && !m.shell.asideVisible) out.shellMismatch.push({ tab: c.tab, vp: c.viewport, note: '竖屏小视口既无底栏也无侧栏' })
  }
  return {
    ...out,
    // 去重后的规则级计数（同一 tab×视口可能多条样本）
    tinyTargetCells: out.tinyTargets.length,
    smallTextCells: out.smallText.length,
    hoverRuleCells: out.hoverOnlyRules.length,
    fixedBottomCells: out.fixedBottom.length,
    horizontalScrollCells: out.horizontalScroll.length,
    heightMismatchCells: out.heightMismatch.length,
    shellMismatchCells: out.shellMismatch.length,
  }
}

/**
 * 控制台：规则矩阵 + 手机专项摘要 + Top offenders。
 * @param {{summary:object, mobileSummary:object, cells:Array<object>, VIEWPORTS:Array<object>, durationMs:number, labels:object}} args
 */
 export function printBrowserSummary (args) {
  const { summary, mobileSummary, cells, VIEWPORTS, durationMs } = args
  console.log('─'.repeat(78))
  console.log(`完成：${cells.length} 格（${summary.tabs} tab × ${VIEWPORTS.length} 视口），用时 ${(durationMs / 1000).toFixed(1)}s`)
  for (const rule of RULE_ORDER) {
    const s = summary.byRule[rule]
    console.log(`  ${rule.padEnd(16)} 保留 ${String(s.issues).padStart(4)} 条（检出 ${String(s.detected).padStart(4)}）  涉及 ${String(s.tabs).padStart(2)} tab / ${String(s.cells).padStart(3)} 格`)
  }
  console.log('\n按视口 | 问题条数 | 有问题格子 / 总格')
  for (const vp of VIEWPORTS) {
    const s = summary.byViewport[vp.label]
    if (s) console.log(`  ${vp.label}  ${String(s.issues).padStart(4)} 条  ${s.cellsWithIssues}/${s.cells}`)
  }
  console.log('\n手机浏览器专项（原始观测，非五类规则）：')
  console.log(`  viewport-fit=cover 覆盖：${mobileSummary.viewportFitCover.cells}/${mobileSummary.viewportFitCover.total} 格`)
  console.log(`  标题栏已移除：${mobileSummary.titlebarRemoved.cells}/${mobileSummary.titlebarRemoved.total} 格`)
  for (const key of ['heightMismatch', 'tinyTargets', 'smallText', 'hoverOnlyRules', 'fixedBottom', 'horizontalScroll', 'shellMismatch']) {
    const n = mobileSummary[`${key}Cells`] ?? mobileSummary[key].length
    console.log(`  ${key.padEnd(16)} ${n} 格`)
  }
  if (summary.topOffenders.length === 0) {
    console.log('\nTop offenders：无（本次未检出五类布局问题）')
  } else {
    console.log('\nTop offenders（前 10）：')
    for (const [i, o] of summary.topOffenders.slice(0, 10).entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. [${o.rule}] ${o.tag}${o.cls ? '.' + o.cls.split(' ')[0] : ''}  ${o.count} 次 / ${o.tabs.length} tab  ${o.text ? `「${o.text}」` : ''}  最大 ${o.maxAmount || '—'}`)
    }
  }
}
