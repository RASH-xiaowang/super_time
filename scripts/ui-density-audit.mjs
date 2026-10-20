#!/usr/bin/env node
/**
 * UI 密度审计（`docs/UI-DENSITY.md` §1 口径）：量化每个页签的「固定内容占比 / 空白率 / 表格行高 / 空洞卡」，
 * 产出可复跑的全站密度基线，供紧凑化改造（task-15）排序与验收。
 *
 * ## 用法
 * ```bash
 * npm run ui:density-audit                                   # 全量 38 tab × 1440×900 / 1280×800（≈3 分钟）
 * npm run ui:density-audit -- --quick                        # 只跑 390×844 / 1440×900 两档（快速迭代）
 * npm run ui:density-audit -- --only=monitor,ledger          # 只跑指定页签
 * npm run ui:density-audit -- --label=compact-v1             # 自定义输出 label
 * npm run ui:density-audit -- --no-shots                     # 不拍截图（默认只给超目标格拍，≤20 张）
 * node scripts/ui-density-audit.mjs --selftest               # 夹具自检（不依赖真实数据）
 * ```
 *
 * ## 测量口径（与 docs/UI-DENSITY.md §1 一致）
 * - `headerH`：面板第一个可见 header 元素高度（目标 1440 档 ≤44px / 1280 档 ≤48px）；
 * - `toolbarH`：可见 toolbar/filter 行高度之和（单行目标 ≤48、两行 ≤88）；
 * - `statH`：statGrid / kpis / statCard 并集高度（目标 ≤52px；`overview` 例外 ≤96px：8 张 KPI 卡 × 2 行）；
 * - `fixedRatio = (headerH+toolbarH+statH)/contentH`（1440 档目标 ≤20%，1280 档 ≤28%）；
 * - `emptyRatio`（D3 修正）：只统计**卡片内容区（`_cardBd_`）内的连续大块空白**——16px 采样找连通空白块，
 *   空白块需 ≥ 卡片内容宽 40% 且 ≥ 48px 高、内部无文本/媒体/交互/图表；背景/padding/卡片间距不计。
 *   D3 起补两条防伪影：① 卡内容盒先与**视口求交**（视口外卡不计入、`elementFromPoint` 为 null 的采样点跳过）；
 *   ② 图表/清单背景（canvas/svg/img/video，或 class token chart/plot/bars/graph/heat/calendar/list/rows/
 *   rail/track/grid 且有子元素）视为占用。
 *   `emptyRatioD2` 保留 D2 口径快照、`emptyRatioRaw` 保留旧的全内容区口径，均仅作对照。
 * - `tableRowH`：数据表 `tbody tr` 平均行高（目标 28–34px，无表为 null）；
 * - `hollowCards`：高度 >280px 且可见文本 <40 字符的卡片清单；
 * - `cardHdH`：卡片头平均高度（目标 ≤36px，附带指标）。
 *
 * 产物：`working/team/density/<label>.json` + `working/team/density-baseline.md` + `working/team/density/shots/*.jpg`。
 * 启动复用 `scripts/responsive-audit/setup.mjs` 的影子 profile（真实配置 + 真实数据根，绕开单实例锁）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  ROOT, EXE, parseTabs, slug, defaultLabel, sleep, gitHead, detectUserDataDir, seedProfile,
} from './responsive-audit/setup.mjs'

/**
 * 当前 git 信息（分支 / 短 hash / 是否 dirty），写入 JSON meta 便于基线追溯。
 * @returns {{branch: string, head: string, dirty: boolean}} git 信息。
 */
function gitInfo () {
  const run = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return '' } }
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    head: gitHead(),
    dirty: run(['status', '--porcelain']).length > 0,
  }
}

// ── 参数与常量 ─────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2)
const hasFlag = (name) => ARGV.includes(`--${name}`)
const opt = (name, fallback = '') => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const optInt = (name, fallback) => {
  const raw = opt(name, '')
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

const TOOL = 'ui-density-audit'
const VERSION = 3
const DEFAULT_VIEWPORTS = ['1440x900', '1280x800']
const QUICK_VIEWPORTS = ['390x844', '1440x900']
const GRID = 16
const HOLLOW_MIN_H = 280
const HOLLOW_MAX_TEXT = 40
const MAX_SHOTS = optInt('max-shots', 20)
const NO_SHOTS = hasFlag('no-shots')

/** 目标（docs/UI-DENSITY.md §1）；1440/1280 两档，其余档回退到 1440 档口径。 */
const TARGETS = {
  '1440x900': { fixedRatio: 0.20, headerH: 44, toolbarH: 48, toolbarMax: 88, statH: 52, emptyRatio: 0.35, cardHdH: 36 },
  '1280x800': { fixedRatio: 0.28, headerH: 48, toolbarH: 48, toolbarMax: 88, statH: 52, emptyRatio: 0.40, cardHdH: 36 },
  default: { fixedRatio: 0.28, headerH: 48, toolbarH: 48, toolbarMax: 88, statH: 52, emptyRatio: 0.40, cardHdH: 36 },
}

/** 按页签微调目标（2026-10-18）：overview 的 KPI 是 8 张 StatCard × 2 行 = 91.8px，
 * 单行 52px 口径不适用；只放宽该页签 statH（见 docs/UI-DENSITY.md §1），其余目标不变。 */
const TAB_TARGETS = { overview: { statH: 96 } }
const LABEL = opt('label', '')
const OUT_DIR = resolve(ROOT, opt('out', join('working', 'team', 'density')))
const REPORT_DIR = resolve(ROOT, opt('report-dir', join('working', 'team')))
const PROFILE_DIR = resolve(ROOT, opt('profile', join('.tmp-e2e', 'density-profile')))
const SHOTS_DIR = join(OUT_DIR, 'shots')
const VIEWPORTS = parseViewports()
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * 解析视口：`--viewports=WxH,...` > `--quick` > 默认两档。
 * @returns {Array<{label:string,w:number,h:number}>} 视口列表。
 */
function parseViewports () {
  const raw = opt('viewports', '')
  if (raw) {
    const out = []
    for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = piece.match(/^(\d+)x(\d+)$/)
      if (!m) { console.error(`[前置] 非法视口：${piece}`); process.exit(2) }
      out.push({ label: piece, w: Number(m[1]), h: Number(m[2]) })
    }
    return out
  }
  const labels = hasFlag('quick') ? QUICK_VIEWPORTS : DEFAULT_VIEWPORTS
  return labels.map((label) => {
    const m = label.match(/^(\d+)x(\d+)$/)
    return { label, w: Number(m[1]), h: Number(m[2]) }
  })
}

// ── 页面内测量函数（会被序列化进渲染进程；不得引用 Node 作用域）────────────
/**
 * 在渲染进程内测量一个页签的密度指标。
 * @param {object} payload `{scopeSelector, grid, hollowMinH, hollowMaxText}`。
 * @returns {object} 指标结果或 `{ok:false,error}`。
 */
function DENSITY_PAGE (payload) {
  const doc = document.documentElement
  const vw = innerWidth
  const vh = innerHeight
  const grid = payload.grid || 16
  const hollowMinH = payload.hollowMinH || 280
  const hollowMaxText = payload.hollowMaxText || 40
  const round = (n) => Math.round(n * 10) / 10
  const rectOf = (el) => el.getBoundingClientRect()
  const cs = (el) => getComputedStyle(el)
  const isVisible = (el, r) => {
    if (!r || r.width < 1 || r.height < 1) return false
    const c = cs(el)
    if (c.display === 'none' || c.visibility === 'hidden') return false
    if (Number(c.opacity || '1') < 0.05) return false
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false
    return true
  }
  const selectorPath = (el) => {
    const parts = []
    let n = el
    let d = 0
    while (n && n.nodeType === 1 && n !== document.body && d < 6) {
      let s = n.tagName.toLowerCase()
      const id = n.getAttribute('id')
      if (id) s += '#' + id
      const cls = (n.getAttribute('class') || '').split(/\s+/).filter(Boolean)
      if (cls.length) s += '.' + cls.slice(0, 2).join('.')
      parts.unshift(s)
      n = n.parentElement
      d++
    }
    return parts.join(' > ').slice(0, 220)
  }
  const hasDirectText = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue
      const t = (node.textContent || '').trim()
      if (t.length > 1) return true
    }
    return false
  }

  // 1) 作用域：弹窗 > 面板 shell > 面板根 > main
  let scope = null
  if (payload.scopeSelector) {
    scope = document.querySelector(payload.scopeSelector)
  } else {
    const dialog = document.querySelector('[role="dialog"]')
    if (dialog) {
      const dr = rectOf(dialog)
      if (isVisible(dialog, dr) && dr.height >= 200) scope = dialog
    }
    if (!scope) {
      const cands = [...document.querySelectorAll('[class*="_panelShell_"], main [class*="_panel_"], main')]
      const visible = cands
        .map((el) => ({ el, r: rectOf(el) }))
        .filter(({ el, r }) => isVisible(el, r) && r.height >= 280 && r.width >= 480 && el.tagName.toLowerCase() !== 'main')
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
      if (visible.length) scope = visible[0].el
      else {
        const main = document.querySelector('main')
        if (main) scope = main
      }
    }
  }
  if (!scope) return { ok: false, error: 'scope-not-found' }
  const sRect = rectOf(scope)
  if (!isVisible(scope, sRect)) return { ok: false, error: 'scope-not-visible' }
  const contentH = round(sRect.height)
  const contentW = round(sRect.width)
  const within = (el, r, minW = 0.4) => r.width >= sRect.width * minW && r.top >= sRect.top - 1 && r.bottom <= sRect.bottom + 600

  // 2) headerH：第一个可见 header-ish 元素
  const headerSelectors = ['[class*="_panelHeader_"]', '[class*="_dialogHd_"]', '[class*="_panelHead_"]', 'header']
  let headerH = 0
  let headerSel = ''
  let headerEl = null
  for (const sel of headerSelectors) {
    const el = [...scope.querySelectorAll(sel)].find((node) => {
      const r = rectOf(node)
      return isVisible(node, r) && within(node, r) && r.height >= 16 && r.top <= sRect.top + sRect.height * 0.35
    })
    if (el) {
      headerH = round(rectOf(el).height)
      headerSel = selectorPath(el)
      headerEl = el
      break
    }
  }
  const headerBottom = sRect.top + headerH

  // 3) toolbarH：显式 toolbar/filter 行；没有则启发式找「含输入/按钮、位于滚动体之前」的行
  const dedupe = (els) => els.filter((el) => !els.some((other) => other !== el && other.contains(el)))
  const explicitToolbar = dedupe([...scope.querySelectorAll('[class*="_toolbar_"], [class*="_filterBar_"], [class*="_filterRow_"]')]
    .filter((el) => { const r = rectOf(el); return isVisible(el, r) && within(el, r) && r.height >= 20 }))
  let toolbarEls = explicitToolbar
  if (toolbarEls.length === 0) {
    const rows = []
    for (const el of scope.querySelectorAll('div, form, section')) {
      if (headerEl && (el === headerEl || el.contains(headerEl) || headerEl.contains(el))) continue
      if (el.matches('[class*="_panelHeader_"], header')) continue
      const r = rectOf(el)
      if (!isVisible(el, r) || r.height < 24 || r.height > 96 || r.width < sRect.width * 0.55) continue
      if (r.top < headerBottom - 2) continue
      if (r.top > sRect.top + sRect.height * 0.5) continue
      const controls = el.querySelectorAll('input, select, textarea, button').length
      const inputs = el.querySelectorAll('input, select, textarea').length
      if (inputs === 0 && controls < 2) continue
      rows.push({ el, r })
    }
    const chosen = []
    for (const row of rows.sort((a, b) => a.r.top - b.r.top)) {
      if (chosen.some((c) => c.r.top <= row.r.top && c.r.bottom >= row.r.bottom)) continue
      if (chosen.some((c) => Math.abs(c.r.top - row.r.top) < 4)) continue
      chosen.push(row)
      if (chosen.length >= 3) break
    }
    toolbarEls = chosen.map((c) => c.el)
  }
  let toolbarH = 0
  let toolbarRows = []
  for (const el of toolbarEls) {
    const r = rectOf(el)
    if (r.height < 8) continue
    toolbarH += r.height
    toolbarRows.push({ selector: selectorPath(el), h: round(r.height) })
  }
  toolbarH = round(toolbarH)

  // 4) statH：statGrid/kpis/statCard 的纵向区间并集
  const statEls = [...scope.querySelectorAll('[class*="_statGrid_"], [class*="_kpis_"], [class*="_statCard_"], [class*="_statRow_"]')]
    .filter((el) => { const r = rectOf(el); return isVisible(el, r) && r.width > 0 })
  const intervals = statEls
    .map((el) => rectOf(el))
    .map((r) => [Math.max(r.top, sRect.top), Math.min(r.bottom, sRect.bottom)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])
  let statH = 0
  let cur = null
  for (const [a, b] of intervals) {
    if (!cur) cur = [a, b]
    else if (a <= cur[1] + 1) cur[1] = Math.max(cur[1], b)
    else { statH += cur[1] - cur[0]; cur = [a, b] }
  }
  if (cur) statH += cur[1] - cur[0]
  statH = round(statH)

  // 5) fixedRatio
  const fixedH = round(headerH + toolbarH + statH)
  const fixedRatio = contentH > 0 ? Math.round((fixedH / contentH) * 1000) / 1000 : 0

  // 6) emptyRatioRaw：旧口径（保留对照）——内容区 16px 网格 + 向上 ≤4 层占用判定。
  //    它把 padding/gap/卡片留白都算空白，绝对值偏高；D2 起只作对照，不参与目标达成判定。
  const MEDIA = new Set(['img', 'canvas', 'svg', 'video', 'picture'])
  const CONTROL = new Set(['input', 'button', 'select', 'textarea', 'a'])
  const isOccupiedAt = (x, y) => {
    const hit = document.elementFromPoint(x, y)
    if (!hit || hit === doc) return false
    let el = hit
    for (let d = 0; d <= 4 && el; d++) {
      const tag = el.tagName ? el.tagName.toLowerCase() : ''
      if (MEDIA.has(tag) || CONTROL.has(tag)) return true
      if (hasDirectText(el)) return true
      el = el.parentElement
    }
    return false
  }
  const step = grid
  let total = 0
  let occupied = 0
  const maxSamples = 6000
  const x0 = sRect.left + 8
  const y0 = sRect.top + 8
  const x1 = Math.min(sRect.right, vw) - 4
  const y1 = Math.min(sRect.bottom, vh) - 4
  for (let y = y0; y < y1 && total < maxSamples; y += step) {
    for (let x = x0; x < x1 && total < maxSamples; x += step) {
      total++
      if (isOccupiedAt(x, y)) occupied++
    }
  }
  const emptyRatioRaw = total > 0 ? Math.round(((total - occupied) / total) * 1000) / 1000 : 0

  // 6b) emptyRatio：两种口径并列（D3 修正 + D2 快照对照）
  //   emptyRatio    = D3 修正：卡内容盒与**视口求交**后采样；elementFromPoint 为 null 的采样点**跳过**
  //                   （不算空白）；图表/清单背景（canvas/svg/img/video 或 class token + 有子元素）视为占用；
  //   emptyRatioD2  = D2 口径快照：整卡内容盒采样、不做视口求交与图表豁免（保留与 density-d2 的对比；
  //                   视口外卡片会整卡被算空白的伪影即来源于此）；
  //   emptyRatioRaw = 旧口径：整个内容区 16px 网格空白率（padding/gap 也算空白）。
  const CARD_CELL = 16
  const num = (v) => Number.parseFloat(v) || 0
  const cardBds = [...scope.querySelectorAll('[class*="_cardBd_"]')].filter((el) => {
    const r = rectOf(el)
    return isVisible(el, r) && r.width > 80 && r.height > 40
  })
  /** 连通空白块统计：grid 值 -1=占用/障碍，0=空白未访问；只统计 bbox ≥ 内容宽 40% 且高 ≥48px 的块。 */
  const collectBlocks = (grid, cols, rows, contentW, clip) => {
    const out = { blocks: 0, area: 0, samples: [] }
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false))
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        if (grid[ry][cx] !== 0 || seen[ry][cx]) continue
        const stack = [[ry, cx]]
        seen[ry][cx] = true
        let count = 0
        let minR = ry; let maxR = ry; let minC = cx; let maxC = cx
        while (stack.length) {
          const [cy, cc] = stack.pop()
          count++
          if (cy < minR) minR = cy
          if (cy > maxR) maxR = cy
          if (cc < minC) minC = cc
          if (cc > maxC) maxC = cc
          for (const [ny, nc] of [[cy - 1, cc], [cy + 1, cc], [cy, cc - 1], [cy, cc + 1]]) {
            if (ny < 0 || nc < 0 || ny >= rows || nc >= cols) continue
            if (seen[ny][nc] || grid[ny][nc] !== 0) continue
            seen[ny][nc] = true
            stack.push([ny, nc])
          }
        }
        const bboxW = (maxC - minC + 1) * CARD_CELL
        const bboxH = (maxR - minR + 1) * CARD_CELL
        // 空白块接触视口裁剪边 ⇒ 块可能延伸到视口外，不能算「完整可见的大块空白」（滚动位置伪影）。
        const touchClip = clip && ((clip.top && minR === 0) || (clip.bottom && maxR === rows - 1) ||
          (clip.left && minC === 0) || (clip.right && maxC === cols - 1))
        if (!touchClip && bboxW >= contentW * 0.4 && bboxH >= 48) {
          out.blocks++
          out.area += count * CARD_CELL * CARD_CELL
          if (out.samples.length < 10) out.samples.push({ w: round(bboxW), h: round(bboxH), area: count * CARD_CELL * CARD_CELL })
        }
      }
    }
    return out
  }
  // 图表/清单背景豁免（D3）：媒体标签；或 class token 命中图表/清单容器且内部有子元素。
  // 只看卡片内容区之内的祖先（到 cardBd 为止），避免外层布局 `_cardGrid_` 把整卡误豁免。
  const CHART_TOKEN = /(chart|plot|bars?|graph|heat|calendar|list|rows?|rail|track|grid)/
  const isChartContainer = (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (MEDIA.has(tag)) return true
    const cls = typeof el.className === 'string' ? el.className : ''
    return !!cls && CHART_TOKEN.test(cls.toLowerCase()) && el.children.length > 0
  }
  /** D3 占用判定：命中元素及 ≤3 层祖先；null（视口外/被裁剪）返回 null=跳过采样。 */
  const isOccupiedD3 = (x, y, bd) => {
    const hit = document.elementFromPoint(x, y)
    if (!hit || hit === doc) return null
    let el = hit
    for (let d = 0; el && d <= 3; d++) {
      const tag = el.tagName ? el.tagName.toLowerCase() : ''
      if (MEDIA.has(tag) || CONTROL.has(tag)) return true
      if (el !== bd && isChartContainer(el)) return true
      if (hasDirectText(el)) return true
      if (el === bd || el === bd.parentElement) break
      el = el.parentElement
    }
    return false
  }

  let d2Area = 0
  let d2Blank = 0
  let d2Blocks = 0
  let fixArea = 0
  let fixBlank = 0
  let fixBlocks = 0
  let visibleCards = 0
  const emptyBlocksSample = []
  for (const bd of cardBds) {
    const r = rectOf(bd)
    const c = cs(bd)
    const left = r.left + num(c.paddingLeft) + num(c.borderLeftWidth)
    const right = r.right - num(c.paddingRight) - num(c.borderRightWidth)
    const top = r.top + num(c.paddingTop) + num(c.borderTopWidth)
    const bottom = r.bottom - num(c.paddingBottom) - num(c.borderBottomWidth)
    const w = right - left
    const h = bottom - top
    if (w < 32 || h < 16) continue
    // D2 快照：整卡内容盒（不裁剪视口、不做图表豁免）——保留伪影用于三口径对比
    const colsD = Math.max(1, Math.floor(w / CARD_CELL))
    const rowsD = Math.max(1, Math.floor(h / CARD_CELL))
    const gridD = Array.from({ length: rowsD }, () => new Array(colsD).fill(-1))
    for (let ry = 0; ry < rowsD; ry++) {
      for (let cx = 0; cx < colsD; cx++) {
        const occupied = isOccupiedAt(left + CARD_CELL / 2 + cx * CARD_CELL, top + CARD_CELL / 2 + ry * CARD_CELL)
        gridD[ry][cx] = occupied ? -1 : 0
      }
    }
    const d2 = collectBlocks(gridD, colsD, rowsD, w)
    d2Area += w * h
    d2Blank += d2.area
    d2Blocks += d2.blocks
    // D3 修正：内容盒 ∩ 视口；卡片不在视口内 ⇒ 不计入分母（否则 elementFromPoint=null 会被当成空白）
    const ix0 = Math.max(left, 0)
    const ix1 = Math.min(right, vw)
    const iy0 = Math.max(top, 0)
    const iy1 = Math.min(bottom, vh)
    const iw = ix1 - ix0
    const ih = iy1 - iy0
    if (iw < 24 || ih < 12) continue
    visibleCards++
    const cols = Math.max(1, Math.floor(iw / CARD_CELL))
    const rows = Math.max(1, Math.floor(ih / CARD_CELL))
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(-1))
    let sampled = 0
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        const occupied = isOccupiedD3(ix0 + CARD_CELL / 2 + cx * CARD_CELL, iy0 + CARD_CELL / 2 + ry * CARD_CELL, bd)
        if (occupied === null) continue // null 不算空白：保持 -1（障碍），也不计入分母
        sampled++
        grid[ry][cx] = occupied ? -1 : 0
      }
    }
    const fix = collectBlocks(grid, cols, rows, w, {
      top: top < 0, bottom: bottom > vh, left: left < 0, right: right > vw,
    })
    fixArea += sampled * CARD_CELL * CARD_CELL
    fixBlank += fix.area
    fixBlocks += fix.blocks
    for (const s of fix.samples) {
      if (emptyBlocksSample.length < 10) emptyBlocksSample.push({ card: selectorPath(bd), ...s })
    }
  }
  const emptyRatio = fixArea > 0 ? Math.round(Math.min(1, fixBlank / fixArea) * 1000) / 1000 : 0
  const emptyRatioD2 = d2Area > 0 ? Math.round(Math.min(1, d2Blank / d2Area) * 1000) / 1000 : 0

  // 7) tableRowH：数据行平均高度
  const rowEls = [...scope.querySelectorAll('[class*="_table_"] tbody tr, table tbody tr')]
    .filter((tr) => { const r = rectOf(tr); return isVisible(tr, r) && r.height >= 8 })
  const tableRowH = rowEls.length
    ? Math.round((rowEls.reduce((sum, tr) => sum + rectOf(tr).height, 0) / rowEls.length) * 10) / 10
    : null

  // 8) hollowCards：高度 >280 且可见文本 <40 字符的卡片（只看最外层卡片，避免嵌套重复计数）
  const cardEls = [...scope.querySelectorAll('[class*="_card_"]')]
    .filter((el) => {
      const cls = el.getAttribute('class') || ''
      if (!/(^|\s)_card_[A-Za-z0-9_-]+/.test(cls)) return false
      const r = rectOf(el)
      return isVisible(el, r) && r.width > 120
    })
    .filter((el) => !el.parentElement?.closest('[class*="_card_"]'))
  const hollowCards = []
  let cardHdSum = 0
  let cardHdCount = 0
  const cardHdEls = [...scope.querySelectorAll('[class*="_cardHd_"]')].filter((el) => { const r = rectOf(el); return isVisible(el, r) && r.height > 0 })
  for (const el of cardHdEls) { cardHdSum += rectOf(el).height; cardHdCount++ }
  for (const el of cardEls) {
    const r = rectOf(el)
    if (r.height <= hollowMinH) continue
    // 有媒体/图表（img/canvas/svg/video）的卡不算「空洞」：它们的内容不是文字。
    if (el.querySelector('canvas, svg, img, video')) continue
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
    if (text.length >= hollowMaxText) continue
    hollowCards.push({ selector: selectorPath(el), height: round(r.height), textLen: text.length, text: text.slice(0, 40) })
    if (hollowCards.length >= 30) break
  }

  return {
    ok: true,
    contentH,
    contentW,
    scope: { selector: selectorPath(scope), top: round(sRect.top) },
    headerH,
    headerSelector: headerSel,
    toolbarH,
    toolbarRows,
    statH,
    fixedH,
    fixedRatio,
    emptyRatio,
    emptyRatioD2,
    emptyRatioRaw,
    emptyRatioCards: cardBds.length,
    emptyRatioCardsVisible: visibleCards,
    emptyBlocks: fixBlocks,
    emptyBlocksD2: d2Blocks,
    emptyCardArea: Math.round(fixArea),
    emptyBlankArea: Math.round(fixBlank),
    emptyBlocksSample,
    samples: total,
    tableRowH,
    tableRows: rowEls.length,
    cardHdH: cardHdCount ? round(cardHdSum / cardHdCount) : null,
    hollowCards,
    hollowCount: hollowCards.length,
    counts: { toolbarRows: toolbarRows.length, statEls: statEls.length, cardEls: cardEls.length, emptySamples: total },
  }
}

// ── 汇总 / Markdown ───────────────────────────────────────────────────────
/** 取某视口档 + 页签的目标值（页签可覆盖，见 TAB_TARGETS）。 */
function targetOf (viewport, tab) {
  return { ...(TARGETS[viewport] || TARGETS.default), ...TAB_TARGETS[tab] }
}

/**
 * 目标达成情况。
 * @param {object} cell 单格结果（含 metrics）。
 * @returns {object} 各目标布尔 + 总达成。
 */
function checkTargets (cell) {
  const t = targetOf(cell.viewport, cell.tab)
  const m = cell.metrics || {}
  const pass = {
    fixedRatio: m.fixedRatio <= t.fixedRatio,
    headerH: m.headerH <= t.headerH,
    toolbarH: m.toolbarH <= t.toolbarMax,
    statH: m.statH <= t.statH,
    emptyRatio: m.emptyRatio <= t.emptyRatio,
    tableRowH: m.tableRowH === null || (m.tableRowH >= 28 && m.tableRowH <= 34),
    cardHdH: m.cardHdH === null || m.cardHdH <= t.cardHdH,
  }
  pass.all = Object.values(pass).every(Boolean)
  return pass
}

/**
 * 汇总统计与 TopN 排名。
 * @param {object[]} cells 全部格子。
 * @param {object[]} tabs 页签清单。
 * @returns {object} summary。
 */
function buildSummary (cells, tabs) {
  const ok = cells.filter((c) => !c.error && c.metrics)
  const ranking = (key, n = 15) => ok
    .map((c) => ({ tab: c.tab, viewport: c.viewport, value: c.metrics[key] }))
    .filter((x) => typeof x.value === 'number')
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
  const byTab = {}
  for (const tab of tabs) byTab[tab.tab] = { label: tab.label, hidden: tab.hidden, cells: 0, fixedRatioMax: 0, emptyRatioMax: 0, emptyRatioD2Max: 0, emptyRatioRawMax: 0, hollowCount: 0, breaches: 0 }
  for (const c of ok) {
    const agg = byTab[c.tab]
    if (!agg) continue
    agg.cells++
    agg.fixedRatioMax = Math.max(agg.fixedRatioMax, c.metrics.fixedRatio)
    agg.emptyRatioMax = Math.max(agg.emptyRatioMax, c.metrics.emptyRatio)
    agg.emptyRatioD2Max = Math.max(agg.emptyRatioD2Max, c.metrics.emptyRatioD2)
    agg.emptyRatioRawMax = Math.max(agg.emptyRatioRawMax, c.metrics.emptyRatioRaw)
    agg.hollowCount += c.metrics.hollowCount || 0
    if (!checkTargets(c).all) agg.breaches++
  }
  const breachCells = ok.filter((c) => !checkTargets(c).all)
  return {
    cells: cells.length,
    cellsWithErrors: cells.filter((c) => c.error).length,
    cellsMeasured: ok.length,
    breachCells: breachCells.length,
    tabs: tabs.length,
    viewports: VIEWPORTS.map((v) => v.label),
    targets: TARGETS,
    byTab,
    rankings: {
      fixedRatio: ranking('fixedRatio'),
      emptyRatio: ranking('emptyRatio'),
      emptyRatioD2: ranking('emptyRatioD2'),
      emptyRatioRaw: ranking('emptyRatioRaw'),
      headerH: ranking('headerH'),
      toolbarH: ranking('toolbarH'),
      statH: ranking('statH'),
      hollowCount: ranking('hollowCount'),
    },
  }
}

/**
 * 防空转：一次全量审计里至少要有一个成功测量的 cell，否则「0 超目标」是假绿。
 * @param {object[]} list 全部格子。
 * @returns {number} 成功测量的格子数。
 */
function assertMeasured (list) {
  const ok = list.filter((c) => c && c.metrics && !c.error)
  if (ok.length === 0) throw new Error('防空转：没有任何成功测量的 cell（布局解析失败/全错误），拒绝产出基线')
  return ok.length
}

/** markdown 单元格转义。 */
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * 生成密度基线 Markdown（按 fixedRatio 降序 + 目标达成标记）。
 * @param {object} jsonDoc 完整 JSON。
 * @returns {string} markdown。
 */
function buildBaselineMarkdown (jsonDoc) {
  const { meta, summary, cells } = jsonDoc
  const L = []
  L.push('# UI 密度基线（38 页签 × 2 档，按 fixedRatio 降序）')
  L.push('')
  L.push('> 由 `scripts/ui-density-audit.mjs` 自动生成，请勿手改；口径见 `docs/UI-DENSITY.md` §1，说明见 `working/team/density-audit.md`。')
  L.push('')
  L.push('## 运行信息')
  L.push('')
  L.push('| 项 | 值 |')
  L.push('|---|---|')
  L.push(`| 生成时间 | ${meta.at}（耗时 ${(meta.durationMs / 1000).toFixed(1)}s） |`)
  L.push(`| label | \`${meta.label}\` |`)
  L.push(`| 分支 / 提交 | \`${meta.git.branch}\` / \`${meta.git.head}\`${meta.git.dirty ? '（dirty）' : ''} |`)
  L.push(`| Electron / Node / Playwright | ${meta.electron} / ${meta.node} / ${meta.playwright} |`)
  L.push(`| 页签 | ${meta.tabsRun.length} / ${meta.tabsParsed}（hidden ${meta.tabsRun.filter((t) => t.hidden).length} 个，经深链进入） |`)
  L.push(`| 视口 | ${meta.viewports.map((v) => v.label).join(' / ')} |`)
  L.push(`| 数据根 | \`${meta.dataRoot}\` |`)
  L.push(`| 截图 | ${meta.screenshots} 张（\`working/team/density/shots/\`） |`)
  L.push('')
  L.push('## 指标口径与目标')
  L.push('')
  L.push('| 指标 | 说明 | 目标 1440×900 | 目标 1280×800 |')
  L.push('|---|---|---:|---:|')
  L.push('| `fixedRatio` | (headerH+toolbarH+statH)/contentH | ≤20% | ≤28% |')
  L.push('| `headerH` | 面板首个可见 header 高度 | ≤44px | ≤48px |')
  L.push('| `toolbarH` | 可见筛选行高度之和 | ≤48px（两行 ≤88） | 同左 |')
  L.push('| `statH` | statGrid/kpis/statCard 并集高度 | ≤52px | ≤52px（`overview` 例外 ≤96px：8 张 KPI × 2 行） |')
  L.push('| `emptyRatio` | **D3 修正口径**：卡片内容区（`_cardBd_`，扣 padding/border）与**视口求交**后采样；`elementFromPoint=null` 的采样点跳过（不算空白）；图表/清单背景（canvas/svg/img/video 或 class token chart/plot/bars/graph/heat/calendar/list/rows/rail/track/grid 且有子元素）视为占用；空白块 = 宽 ≥ 卡片内容宽 40% 且高 ≥ 48px | ≤35% | ≤40% |')
  L.push('| `emptyRatioD2` | D2 口径快照（对照）：整卡内容盒采样、不做视口求交与图表豁免（视口外卡会被整卡算空白的伪影即来源于此） | —（不参与判定） | — |')
  L.push('| `emptyRatioRaw` | 旧口径（对照）：内容区 16px 网格 + 向上 4 层占用判定，padding/gap 也算空白 | —（不参与判定） | — |')
  L.push('| `tableRowH` | 数据行平均行高 | 28–34px | 28–34px |')
  L.push('| `cardHdH` | 卡片头平均高度（附带） | ≤36px | ≤36px |')
  L.push('')
  L.push('## 总览')
  L.push('')
  L.push(`- 格子：**${summary.cells}**（失败 ${summary.cellsWithErrors}）`)
  L.push(`- 超目标格子：**${summary.breachCells}** / ${summary.cellsMeasured}`)
  L.push('')
  const sorted = cells
    .filter((c) => !c.error && c.metrics)
    .slice()
    .sort((a, b) => b.metrics.fixedRatio - a.metrics.fixedRatio || b.metrics.emptyRatio - a.metrics.emptyRatio)
  L.push('## fixedRatio 降序（Top 60）')
  L.push('')
  L.push('| # | 页签 | 视口 | headerH | toolbarH | statH | fixedRatio | emptyRatio | emptyRatioD2 | emptyRatioRaw | tableRowH | 目标 |')
  L.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  sorted.slice(0, 60).forEach((c, i) => {
    const m = c.metrics
    const pass = checkTargets(c)
    const marks = Object.entries(pass).filter(([k]) => k !== 'all').map(([k, v]) => `${v ? '✅' : '❌'}${k}`).join(' ')
    L.push(`| ${i + 1} | \`${md(c.tab)}\` | ${c.viewport} | ${m.headerH} | ${m.toolbarH} | ${m.statH} | **${(m.fixedRatio * 100).toFixed(1)}%** | ${(m.emptyRatio * 100).toFixed(1)}% | ${(m.emptyRatioD2 * 100).toFixed(1)}% | ${(m.emptyRatioRaw * 100).toFixed(1)}% | ${m.tableRowH ?? '—'} | ${pass.all ? '✅' : '⚠️'} ${marks} |`)
  })
  if (sorted.length > 60) L.push(`| … | 其余 ${sorted.length - 60} 格见 JSON | | | | | | | | | | |`)
  L.push('')
  L.push('## 各指标 Top 10')
  L.push('')
  for (const [key, title] of [['fixedRatio', '固定区占比'], ['emptyRatio', '空白率（D3 修正口径）'], ['emptyRatioD2', '空白率（D2 对照）'], ['emptyRatioRaw', '空白率（旧口径对照）'], ['headerH', '页头高度'], ['toolbarH', '筛选区高度'], ['statH', '统计区高度'], ['hollowCount', '空洞卡数量']]) {
    L.push(`### ${title} \`${key}\``)
    L.push('')
    const rows = summary.rankings[key] || []
    if (rows.length === 0) { L.push('无。'); L.push(''); continue }
    L.push('| # | 页签 | 视口 | 值 |')
    L.push('|---:|---|---|---:|')
    rows.slice(0, 10).forEach((r, i) => L.push(`| ${i + 1} | \`${md(r.tab)}\` | ${r.viewport} | ${key === 'fixedRatio' || key.startsWith('emptyRatio') ? (r.value * 100).toFixed(1) + '%' : r.value} |`))
    L.push('')
  }
  const hollow = cells.filter((c) => !c.error && c.metrics?.hollowCount > 0)
  L.push('## 空洞卡（hollowCards，高度>280 且文本<40）')
  L.push('')
  if (hollow.length === 0) L.push('无。')
  else {
    L.push('| 页签 | 视口 | 数量 | 示例 |')
    L.push('|---|---|---:|---|')
    for (const c of hollow.slice(0, 20)) L.push(`| \`${md(c.tab)}\` | ${c.viewport} | ${c.metrics.hollowCount} | \`${md(c.metrics.hollowCards[0]?.selector || '')}\` ${md(c.metrics.hollowCards[0]?.text || '')} |`)
  }
  L.push('')
  L.push('## 执行失败格')
  L.push('')
  const failed = cells.filter((c) => c.error)
  if (failed.length === 0) L.push('无。')
  else for (const c of failed.slice(0, 20)) L.push(`- \`${c.tab}@${c.viewport}\`：${md(c.error)}`)
  L.push('')
  L.push('## 局限')
  L.push('')
  L.push('- **D3 口径**：`emptyRatio` 只统计卡片内容区（`_cardBd_`，扣 padding/border）与视口求交后的连续空白块（宽 ≥40% 内容宽 且 高 ≥48px）；视口外卡片不计入、`elementFromPoint=null` 的采样点跳过；图表/清单背景按容器豁免。`emptyRatioD2`（D2 快照）与 `emptyRatioRaw`（旧全内容区）仅作对照，不参与判定。')
  L.push('- 空间采样启发式：16px 采样 + 4 邻接连通分量，按「文本/媒体/交互/图表容器」判占用；无 `_cardBd_` 的面板 `emptyRatio=0`（见 `emptyRatioCards` / `emptyRatioCardsVisible`）。')
  L.push('- 图表容器判定依赖 class token（chart/plot/bars/graph/heat/calendar/list/rows/rail/track/grid）且有子元素；纯色 div 画的可视化若 class 不含这些 token 仍可能被计为空白。')
  L.push('- `headerH/toolbarH/statH` 依赖类名约定（`_panelHeader_`/`_toolbar_`/`_statGrid_` 等）；没有显式 toolbar 时会用「含输入/按钮的行」启发式，个别面板可能少算/多算。')
  L.push('- 只测「初次进入的默认状态」：弹层/展开态/滚动后不覆盖；数据不同（空态/满态）会显著影响 emptyRatio 与 hollowCards。')
  L.push('')
  return L.join('\n')
}

// ── 启动与遍历 ─────────────────────────────────────────────────────────────
const LABEL_FINAL = LABEL || defaultLabel()
const JSON_PATH = join(OUT_DIR, `${slug(LABEL_FINAL)}.json`)
const BASELINE_MD = join(REPORT_DIR, 'density-baseline.md')

const srcUserData = resolve(ROOT, opt('user-data', '') || detectUserDataDir())
const profile = seedProfile(PROFILE_DIR, srcUserData)
const launchEnv = { ...process.env, SUPERTIME_USER_DATA_DIR: PROFILE_DIR }
delete launchEnv.ELECTRON_RUN_AS_NODE
if (profile.gates !== 'seeded') launchEnv.SUPERTIME_SKIP_ONBOARDING = '1'

const TABS_ALL = parseTabs()
const TABS = ONLY.length ? TABS_ALL.filter((t) => ONLY.includes(t.tab)) : TABS_ALL
if (TABS.length === 0) { console.error('[前置] --only 过滤后没有可跑的页签'); process.exit(2) }

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(SHOTS_DIR, { recursive: true })
mkdirSync(resolve(ROOT, '.tmp-e2e'), { recursive: true })
console.log(`${TOOL}  v${VERSION}`)
console.log(`label=${LABEL_FINAL}  tab=${TABS.length}/${TABS_ALL.length}  视口=${VIEWPORTS.map((v) => v.label).join(' / ')}`)
console.log(`真实 profile：${srcUserData}`)
console.log(`临时 profile：${PROFILE_DIR}`)
console.log(`  数据根：${profile.dataRoot}`)
console.log(`  首启闸门：${profile.gates === 'seeded' ? '已复制真实状态（无调试横幅）' : '回退 SKIP_ONBOARDING'}`)

const { _electron } = await import('playwright')
let app = null
let fatal = null
const cells = []
let shotsTaken = 0
const consoleErrors = []

try {
  app = await _electron.launch({ executablePath: EXE, args: [ROOT], cwd: ROOT, env: launchEnv })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  await win.waitForLoadState('domcontentloaded')

  const waitShell = (timeout = 45000) => win.waitForFunction(() => {
    const aside = document.querySelector('aside')
    const navBtn = aside && [...aside.querySelectorAll('button')]
      .some((b) => ((b.getAttribute('title') || '') + (b.textContent || '')).includes('数据总览'))
    return !!(navBtn || document.querySelector('nav[aria-label="主导航"]') || document.querySelector('[role="dialog"]'))
  }, null, { timeout })

  await waitShell()
  await app.evaluate(({ BrowserWindow }) => {
    const bw = BrowserWindow.getAllWindows()[0]
    if (!bw) return
    if (bw.isMaximized()) bw.unmaximize()
    bw.setMinimumSize(320, 480)
  })
  const setViewport = (vp) => app.evaluate(({ BrowserWindow }, size) => {
    const bw = BrowserWindow.getAllWindows()[0]
    if (!bw) return
    if (bw.isMaximized()) bw.unmaximize()
    bw.setMinimumSize(320, 480)
    bw.setContentSize(size.w, size.h)
  }, { w: vp.w, h: vp.h })

  /** 深链进入页签（写 hash → reload），等 shell + 文本稳定。 */
  const goto = async (tab) => {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await win.evaluate((t) => { location.hash = `#${t}` }, tab)
        await win.reload({ waitUntil: 'domcontentloaded' })
        await waitShell()
        return attempt
      } catch (e) { lastErr = e; await sleep(700) }
    }
    throw lastErr ?? new Error('goto 失败')
  }
  /** 等待页面「落定」：文本长度连续 3×250ms 不变，最短 1.2s、最长 5s。 */
  const waitSettled = async () => {
    const t0 = Date.now()
    let prev = -1
    let stable = 0
    while (Date.now() - t0 < 5000) {
      await sleep(250)
      const len = await win.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().length)
      if (len === prev) stable++
      else stable = 0
      prev = len
      if (Date.now() - t0 >= 1200 && stable >= 2) return Date.now() - t0
    }
    return Date.now() - t0
  }

  mkdirSync(SHOTS_DIR, { recursive: true })
  const started = Date.now()
  const payload = { grid: GRID, hollowMinH: HOLLOW_MIN_H, hollowMaxText: HOLLOW_MAX_TEXT }
  const getTargets = (vpLabel, tab) => targetOf(vpLabel, tab)

  // ── --selftest：注入确定性 DOM 夹具，断言指标口径与防空转 ──────────────────
  if (hasFlag('selftest')) {
    await setViewport({ w: 1440, h: 900, label: 'selftest' })
    await sleep(300)
    await win.evaluate(() => {
      for (const el of document.querySelectorAll('[id^="density-fixture"]')) el.remove()
      document.body.insertAdjacentHTML('beforeend', [
        '<div id="density-fixture" style="position:absolute;left:0;top:0;width:760px;height:640px;background:#fff;color:#000;z-index:1">',
        '<div class="_panelHeader_fixture_1" style="height:44px;display:flex;align-items:center">Fixture 标题</div>',
        '<div class="_toolbar_fixture_1" style="height:48px;display:flex;gap:8px;align-items:center"><input style="height:28px;width:200px"><button style="height:28px">查询</button></div>',
        '<div class="_statGrid_fixture_1" style="height:52px;display:flex;gap:8px;align-items:center"><span>会话 1,234</span><span>消息 5,678</span><span>导出 9</span></div>',
        '<table class="_table_fixture_1" style="width:100%;border-collapse:collapse"><tbody>',
        '<tr style="height:30px"><td style="padding:6px 10px">行一</td></tr>',
        '<tr style="height:30px"><td style="padding:6px 10px">行二</td></tr>',
        '<tr style="height:30px"><td style="padding:6px 10px">行三</td></tr>',
        '</tbody></table>',
        '<div style="height:100px"></div>',
        '<section class="_card_fixture_1" style="height:300px;border:1px solid #ccc;padding:12px;box-sizing:border-box">'
          + '<div class="_cardBd_fixture_1" style="height:100%;box-sizing:border-box;padding:12px;border:1px solid #ddd"><span>短</span></div>'
          + '</section>',
        '</div>',
        // D2 新口径负向夹具：padding 很大但内容（svg 图表）铺满 → 新口径应≈0 空白（旧口径会把 padding 算进去）。
        '<div id="density-fixture-full" style="position:absolute;left:400px;top:0;width:360px;height:300px;background:#fff;color:#000;z-index:2">'
          + '<section class="_card_fixtureFull_1" style="width:100%;height:100%;box-sizing:border-box;padding:12px">'
          + '<div class="_cardBd_fixtureFull_1" style="height:100%;box-sizing:border-box;padding:40px;border:1px solid #ddd">'
          + '<svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="0" y="0" width="100" height="100" fill="#bbb"></rect></svg>'
          + '</div></section></div>',
        // D2 新口径正向夹具：卡片内容区里只有一行小字 → 应识别出大块空白。
        '<div id="density-fixture-blank" style="position:absolute;left:800px;top:0;width:360px;height:300px;background:#fff;color:#000;z-index:2">'
          + '<section class="_card_fixtureBlank_1" style="width:100%;height:100%;box-sizing:border-box;padding:12px">'
          + '<div class="_cardBd_fixtureBlank_1" style="height:100%;box-sizing:border-box;padding:12px;border:1px solid #ddd"><span>一行内容</span></div>'
          + '</section></div>',
        // D3 负向夹具 ①：卡片只有底部一小条在视口内（卡顶 y=-260），大部分采样点在视口外 → 修正口径
        // 与视口求交后可见高度 32px<48 不构成空白块（=0）；D2 快照把视口外 null 采样当空白，保留伪影。
        '<div id="density-fixture-offscreen" style="position:absolute;left:1200px;top:0;width:200px;height:320px;background:#fff;color:#000;z-index:2">'
          + '<section class="_card_fixtureOff_1" style="position:absolute;left:0;top:-260px;width:200px;height:300px;box-sizing:border-box;padding:8px">'
          + '<div class="_cardBd_fixtureOff_1" style="height:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd"></div>'
          + '</section></div>',
        // D3 负向夹具 ②：卡内是 CSS div 画的柱状图（无文本/无媒体标签）→ 图表容器豁免，修正口径不算空白。
        '<div id="density-fixture-chart" style="position:absolute;left:0;top:660px;width:360px;height:220px;background:#fff;color:#000;z-index:3">'
          + '<section class="_card_fixtureChart_1" style="width:100%;height:100%;box-sizing:border-box;padding:8px">'
          + '<div class="_cardBd_fixtureChart_1" style="height:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd">'
          + '<div class="_bars_fixtureChart_1" style="display:flex;align-items:flex-end;gap:4px;height:100%">'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:60%;background:#456"></div>'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:90%;background:#456"></div>'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:40%;background:#456"></div>'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:75%;background:#456"></div>'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:55%;background:#456"></div>'
          + '<div class="_bar_fixtureChart_1" style="flex:1;height:85%;background:#456"></div>'
          + '</div></div></section></div>',
      ].join(''))
    })
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const fixPayload = { scopeSelector: '#density-fixture', grid: GRID, hollowMinH: HOLLOW_MIN_H, hollowMaxText: HOLLOW_MAX_TEXT }
    const fix = await win.evaluate(DENSITY_PAGE, fixPayload)
    const missing = await win.evaluate(DENSITY_PAGE, { ...fixPayload, scopeSelector: '#density-fixture-not-exist' })
    const blankFix = await win.evaluate(DENSITY_PAGE, { ...fixPayload, scopeSelector: '#density-fixture-blank' })
    const fullFix = await win.evaluate(DENSITY_PAGE, { ...fixPayload, scopeSelector: '#density-fixture-full' })
    const offFix = await win.evaluate(DENSITY_PAGE, { ...fixPayload, scopeSelector: '#density-fixture-offscreen' })
    const chartFix = await win.evaluate(DENSITY_PAGE, { ...fixPayload, scopeSelector: '#density-fixture-chart' })
    const checks = []
    const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`) }
    check('夹具可测（scope 解析）', fix?.ok === true)
    if (fix?.ok) {
      check('contentH=640', Math.abs(fix.contentH - 640) <= 1, `contentH=${fix.contentH}`)
      check('headerH=44', Math.abs(fix.headerH - 44) <= 1, `headerH=${fix.headerH}`)
      check('toolbarH=48', Math.abs(fix.toolbarH - 48) <= 2, `toolbarH=${fix.toolbarH}`)
      check('statH=52', Math.abs(fix.statH - 52) <= 2, `statH=${fix.statH}`)
      check('fixedRatio=0.225±0.02', Math.abs(fix.fixedRatio - 0.225) <= 0.02, `fixedRatio=${fix.fixedRatio}`)
      check('tableRowH 在 28–34 目标区间', fix.tableRowH !== null && fix.tableRowH >= 28 && fix.tableRowH <= 34, `tableRowH=${fix.tableRowH}`)
      check('emptyRatio≥0.5（卡片内大块空白可识别）', fix.emptyRatio >= 0.5, `emptyRatio=${fix.emptyRatio}`)
      check('旧口径 emptyRatioRaw 仍保留', typeof fix.emptyRatioRaw === 'number', `emptyRatioRaw=${fix.emptyRatioRaw}`)
      check('hollowCards≥1（300px/短文本卡）', fix.hollowCount >= 1 && fix.hollowCards[0].height > HOLLOW_MIN_H, JSON.stringify(fix.hollowCards[0] || null))
    }
    check('负向：padding 大但内容满 ⇒ 新 emptyRatio≈0（padding 不计）',
      fullFix?.ok === true && fullFix.emptyRatio <= 0.05,
      `ratio=${fullFix?.emptyRatio} cards=${fullFix?.emptyRatioCards}`)
    check('负向：同夹具旧口径 emptyRatioRaw 明显更高（对照口径保留）',
      fullFix?.ok === true && fullFix.emptyRatioRaw > fullFix.emptyRatio + 0.15,
      `raw=${fullFix?.emptyRatioRaw} vs new=${fullFix?.emptyRatio}`)
    check('正向：卡片内一行小字 ⇒ 新 emptyRatio≥0.5 且识别到空白块',
      blankFix?.ok === true && blankFix.emptyRatio >= 0.5 && blankFix.emptyBlocks >= 1,
      `ratio=${blankFix?.emptyRatio} blocks=${blankFix?.emptyBlocks}`)
    // D3 负向夹具：视口外卡（修正不算空白、D2 快照保留伪影）与 CSS 柱状图卡（图表容器豁免）。
    check('负向：视口外卡片不计入空白色（修正=0；D2 快照仍>0）',
      offFix?.ok === true && offFix.emptyRatio === 0 && offFix.emptyRatioCards >= 1 && offFix.emptyRatioD2 >= 0.3,
      `fix=${offFix?.emptyRatio} d2=${offFix?.emptyRatioD2} cards=${offFix?.emptyRatioCards}`)
    check('负向：CSS div 柱状图卡不算空白（修正≤0.05；D2 快照仍>0.3）',
      chartFix?.ok === true && chartFix.emptyRatio <= 0.05 && chartFix.emptyRatioD2 >= 0.3,
      `fix=${chartFix?.emptyRatio} d2=${chartFix?.emptyRatioD2}`)
    check('scope 缺失返回错误（防空转）', missing?.ok === false && /scope-not-found/.test(missing?.error || ''), String(missing?.error))
    let antiOk = false
    try { assertMeasured([]) } catch (e) { antiOk = e instanceof Error && e.message.includes('防空转') }
    check('assertMeasured([]) 抛防空转错误', antiOk)
    await win.evaluate(() => { for (const el of document.querySelectorAll('[id^="density-fixture"]')) el.remove() })
    await app.close()
    app = null
    const failed = checks.filter((c) => !c.ok)
    console.log(`\n自检结果：${failed.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败 ${failed.map((c) => c.name).join(', ')}`}`)
    process.exit(failed.length === 0 ? 0 : 1)
  }

  for (const [tabIndex, tabInfo] of TABS.entries()) {
    await goto(tabInfo.tab)
    await waitSettled()
    for (const vp of VIEWPORTS) {
      const t0 = Date.now()
      await setViewport(vp)
      await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await sleep(320)
      let result = null
      let error = null
      try {
        result = await win.evaluate(DENSITY_PAGE, payload)
        if (!result || result.ok === false) { error = result?.error || 'measure-failed'; result = null }
      } catch (e) { error = String(e?.message ?? e) }
      const cell = {
        tab: tabInfo.tab,
        label: tabInfo.label,
        hidden: tabInfo.hidden,
        viewport: vp.label,
        requested: { w: vp.w, h: vp.h },
        actual: await win.evaluate(() => ({ w: innerWidth, h: innerHeight })),
        elapsedMs: Date.now() - t0,
        error,
        metrics: result,
      }
      cell.target = getTargets(vp.label, tabInfo.tab)
      cell.pass = result ? checkTargets(cell) : null
      const breach = result && (!cell.pass.all || result.hollowCount > 0)
      if (breach && !NO_SHOTS && shotsTaken < MAX_SHOTS) {
        try {
          const shot = join(SHOTS_DIR, `${slug(LABEL_FINAL)}-${tabInfo.tab}-${vp.label}.jpg`)
          await win.screenshot({ type: 'jpeg', quality: 70, path: shot })
          cell.screenshot = shot
          shotsTaken++
        } catch { /* 截图失败不影响度量 */ }
      }
      cells.push(cell)
    }
    const row = cells.filter((c) => c.tab === tabInfo.tab)
    const maxFixed = Math.max(...row.filter((c) => c.metrics).map((c) => c.metrics.fixedRatio), 0)
    const breaches = row.filter((c) => c.pass && !c.pass.all).length
    console.log(`[${String(tabIndex + 1).padStart(2, '0')}/${TABS.length}] ${tabInfo.tab.padEnd(16)} fixedRatioMax=${(maxFixed * 100).toFixed(1)}%  超目标=${breaches}/${row.length}  hollow=${row.reduce((n, c) => n + (c.metrics?.hollowCount || 0), 0)}`)
  }

  const durationMs = Date.now() - started
  assertMeasured(cells) // 防空转：0 个成功测量的格子直接报错，不写基线
  const summary = buildSummary(cells, TABS)
  const electronVersion = await win.evaluate(() => navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || '?')
  let playwrightVersion = '?'
  try { playwrightVersion = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8')).version } catch {}
  const meta = {
    tool: TOOL,
    version: VERSION,
    label: LABEL_FINAL,
    at: new Date().toISOString(),
    durationMs,
    git: gitInfo(),
    node: process.version,
    electron: electronVersion,
    playwright: playwrightVersion,
    root: ROOT,
    dataRoot: profile.dataRoot,
    userDataSource: srcUserData,
    profileDir: PROFILE_DIR,
    profileGates: profile.gates,
    viewports: VIEWPORTS,
    tabsParsed: TABS_ALL.length,
    tabsRun: TABS.map((t) => ({ tab: t.tab, label: t.label, hidden: t.hidden })),
    thresholds: { grid: GRID, hollowMinH: HOLLOW_MIN_H, hollowMaxText: HOLLOW_MAX_TEXT, targets: TARGETS, tabTargets: TAB_TARGETS },
    screenshots: shotsTaken,
    consoleErrors: consoleErrors.slice(0, 30),
    limitations: [
      'D3 口径：emptyRatio 只统计卡片内容区（_cardBd_，扣除 padding/border）与视口求交后「宽≥40% 内容宽 且 高≥48px」的连续空白块；视口外卡片不计入、elementFromPoint=null 的采样点跳过、图表/清单背景按容器豁免。emptyRatioD2（D2 快照）与 emptyRatioRaw（旧全内容区）仅作对照。',
      'emptyRatio 用 16px 采样 + 4 邻接连通分量判空白；图表容器判定依赖 class token（chart/plot/bars/graph/heat/calendar/list/rows/rail/track/grid）且有子元素，纯色 div 可视化若 class 不含这些 token 仍可能被计为空白。无 _cardBd_ 的面板 emptyRatio=0（见 emptyRatioCards/emptyRatioCardsVisible）。',
      'headerH/toolbarH/statH 依赖类名约定（_panelHeader_/_toolbar_/_statGrid_ 等）；无显式 toolbar 时用「含输入/按钮的行」启发式。',
      '只测「初次进入的默认状态」：弹层/展开态/滚动后不覆盖；数据空/满会显著影响 emptyRatio 与 hollowCards。',
    ],
  }
  const jsonDoc = { meta, summary, cells }
  mkdirSync(dirname(JSON_PATH), { recursive: true })
  const tmp = `${JSON_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(jsonDoc, null, 2), 'utf8')
  renameSync(tmp, JSON_PATH)
  writeFileSync(BASELINE_MD, buildBaselineMarkdown(jsonDoc), 'utf8')

  console.log('─'.repeat(78))
  console.log(`完成：${cells.length} 格（${TABS.length} tab × ${VIEWPORTS.length} 视口），用时 ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`  超目标格子 ${summary.breachCells} / ${summary.cellsMeasured}；空洞卡 ${cells.reduce((n, c) => n + (c.metrics?.hollowCount || 0), 0)} 个`)
  console.log(`  fixedRatio Top5：${summary.rankings.fixedRatio.slice(0, 5).map((r) => `${r.tab}@${r.viewport}=${(r.value * 100).toFixed(1)}%`).join('  ')}`)
  console.log(`\nJSON 基线：${JSON_PATH}`)
  console.log(`Markdown 基线：${BASELINE_MD}`)
  if (shotsTaken) console.log(`截图：${SHOTS_DIR}（${shotsTaken} 张）`)
} catch (e) {
  fatal = e
  console.error('\n[fatal]', e?.message ?? e)
  if (e?.stack) console.error(String(e.stack).split('\n').slice(0, 6).join('\n'))
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
}

if (fatal) process.exitCode = String(fatal.message).includes('未能进入主界面') ? 3 : 1
