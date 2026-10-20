/**
 * 响应式审计 · 页面内五类检测（`AUDIT_PAGE`）。
 *
 * 从 `scripts/responsive-audit.mjs` **机械拆出**，检测规则与阈值一字未改。
 *
 * ⚠️ 本函数会被 Playwright `page.evaluate` **序列化进渲染进程**执行，函数体内不能引用
 * Node 作用域的任何变量（DOM / `getComputedStyle` / `elementFromPoint` 都在函数内部取）。
 * 因此本模块除这一个函数外不引入任何依赖。
 *
 * @module scripts/responsive-audit/detector
 */

// ── 页面内审计函数（会被序列化进渲染进程执行，不能引用 Node 作用域）──────
/**
 * 在渲染进程里跑一遍五类检测。
 * @param {{tol:number,maxPerRule:number}} payload 阈值。
 * @returns {object} 该 tab×视口的检测结果。
 */
export function AUDIT_PAGE (payload) {
  const { tol = 2, maxPerRule = 15, overlapPct = 0.25, visualPct = 0.5 } = payload
  const vw = window.innerWidth
  const vh = window.innerHeight
  const doc = document.documentElement
  const body = document.body
  const issues = []
  const detected = { 'doc-overflow': 0, 'out-of-viewport': 0, clipped: 0, occluded: 0, hidden: 0 }
  const ruleTruncated = {}
  const stats = {
    scanned: 0, rendered: 0, fixed: 0, sticky: 0, scrollX: 0, scrollY: 0,
    dialog: false, interactive: 0, overlays: 0, escapedOcclusion: 0, intentionalTruncation: 0,
  }

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT',
    'BR', 'WBR', 'OPTION', 'OPTGROUP', 'DATALIST', 'SOURCE', 'TRACK', 'PARAM', 'COL', 'COLGROUP',
    'HTML', 'BODY',
  ])
  const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'PROGRESS', 'METER'])
  /** 应用自身的「导航类 chrome」：折叠/收起属于有意设计，不算业务内容被隐藏或裁切。 */
  const CHROME_SEL = '#titlebar, aside, nav[aria-label="主导航"]'
  const SVG_NS = 'http://www.w3.org/2000/svg'

  const inTestBanner = (el) => {
    try { return !!(el.closest && el.closest('#test-mode-banner')) } catch { return false }
  }

  // 当前「真正在看的那一层」：设置类页签以 dialog 形式打开时，背景按设计被遮罩盖住，
  // 只审计弹窗内部；否则审计整个 body。
  const pickDialog = () => {
    let best = null
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      const r = d.getBoundingClientRect()
      if (r.width < 200 || r.height < 200 || r.bottom <= 0 || r.right <= 0) continue
      const cs = getComputedStyle(d)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const area = r.width * r.height
      if (!best || area > best.area) best = { el: d, area }
    }
    return best ? best.el : null
  }
  const dialog = pickDialog()
  const scopeRoot = dialog ?? body
  stats.dialog = !!dialog

  // 样式按需取（一遍 getComputedStyle 对几千节点太贵；只在需要时缓存）。
  const csCache = new Map()
  const cs = (el) => {
    let c = csCache.get(el)
    if (!c) { c = getComputedStyle(el); csCache.set(el, c) }
    return c
  }
  const rectCache = new Map()
  const rectOf = (el) => {
    let r = rectCache.get(el)
    if (!r) { r = el.getBoundingClientRect(); rectCache.set(el, r) }
    return r
  }

  /** 直接文本（只认直接子文本节点；`innerText` 会把整棵子树算进来）。 */
  const directText = (el) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const v = typeof el.value === 'string' ? el.value.trim() : ''
      if (v) return v
      const ph = el.getAttribute('placeholder')
      return ph ? ph.trim() : ''
    }
    let out = ''
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue
      const t = n.textContent.replace(/\s+/g, ' ').trim()
      if (t) out += t
    }
    return out
  }
  const INTERACTIVE_SEL = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'
  const isInteractive = (el) => {
    try { return !!el.closest(INTERACTIVE_SEL) } catch { return false }
  }
  const isZeroRect = (r) => Math.abs(r.width) < 0.5 && Math.abs(r.height) < 0.5
  const isRendered = (el, r, c) =>
    c.display !== 'none' && c.visibility !== 'hidden' && c.visibility !== 'collapse' &&
    !isZeroRect(r) && Number.parseFloat(c.opacity || '1') > 0.02

  /** 元素选择器路径（类名截断，够定位即可）。 */
  const selectorPath = (el) => {
    const parts = []
    let n = el
    let depth = 0
    while (n && n !== body && depth < 5) {
      let s = n.tagName.toLowerCase()
      if (n.id) s += `#${n.id}`
      const cls = (n.getAttribute && n.getAttribute('class')) ? n.getAttribute('class') : ''
      const clsPart = cls.split(/\s+/).filter(Boolean).slice(0, 2)
        .map((c) => `.${c.replace(/[^\w-]/g, '_').slice(0, 28)}`).join('')
      parts.unshift(s + clsPart)
      n = n.parentElement
      depth++
    }
    return parts.join(' > ').slice(0, 200)
  }

  const identity = (el) => {
    const r = rectOf(el)
    const c = cs(el)
    const cls = (el.getAttribute && el.getAttribute('class')) ? el.getAttribute('class') : ''
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: cls.split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, 120),
      sel: selectorPath(el),
      text: (directText(el) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      rect: {
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      },
      position: c.position,
      zIndex: c.zIndex,
    }
  }

  /** 加入问题清单（按严重度截断，避免 JSON 爆炸；detected 记录真实检出数）。 */
  const add = (rule, sub, el, extra, severity) => {
    detected[rule] = (detected[rule] ?? 0) + 1
    issues.push({ rule, sub, severity, ...identity(el), ...extra })
  }
  const capRule = (rule) => {
    const list = issues.filter((i) => i.rule === rule)
    if (list.length <= maxPerRule) return
    ruleTruncated[rule] = list.length - maxPerRule
    const keep = new Set(
      list.slice()
        .sort((a, b) => (SEVERITY_WEIGHT_IN(b.severity) - SEVERITY_WEIGHT_IN(a.severity)) || Number(b.amount ?? 0) - Number(a.amount ?? 0))
        .slice(0, maxPerRule),
    )
    for (let i = issues.length - 1; i >= 0; i--) {
      if (issues[i].rule === rule && !keep.has(issues[i])) issues.splice(i, 1)
    }
  }
  // 页面内也需要一份严重度权重（Node 侧的常量不会随函数序列化进渲染进程）。
  const SEVERITY_WEIGHT_IN = (s) => (s === 'high' ? 3 : s === 'medium' ? 2 : 1)

  const intersects = (a, b) => {
    const x1 = Math.max(a.left, b.left)
    const y1 = Math.max(a.top, b.top)
    const x2 = Math.min(a.right, b.right)
    const y2 = Math.min(a.bottom, b.bottom)
    if (x2 <= x1 || y2 <= y1) return 0
    return (x2 - x1) * (y2 - y1)
  }

  // ── 收集元素基础信息 ────────────────────────────────────────────────
  const records = []
  for (const el of scopeRoot.querySelectorAll('*')) {
    stats.scanned++
    const tag = el.tagName
    if (SKIP_TAGS.has(tag)) continue
    // SVG 子节点（path/g/...）的 rect 是绘制包围盒，按「元素布局」审计会全量误报；只审计 <svg> 根。
    if (el.namespaceURI === SVG_NS && tag.toLowerCase() !== 'svg') continue
    if (inTestBanner(el)) continue
    const r = rectOf(el)
    const c = cs(el)
    records.push({ el, tag, r, c })
  }

  // 可滚动祖先（用于「滚动可达的内容不算越界」）。按轴缓存。
  const scrollAncCache = new Map()
  const scrollAncestor = (el, axis) => {
    const key = `${axis}:`;
    let m = scrollAncCache.get(el)
    if (m && key in m) return m[key]
    if (!m) { m = {}; scrollAncCache.set(el, m) }
    let p = el.parentElement
    let found = null
    while (p && p !== doc) {
      const c = cs(p)
      const ov = axis === 'x' ? c.overflowX : c.overflowY
      if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
        const over = axis === 'x'
          ? p.scrollWidth > p.clientWidth + 1
          : p.scrollHeight > p.clientHeight + 1
        if (over) { found = p; break }
      }
      p = p.parentElement
    }
    m[key] = found
    return found
  }

  const rendered = records.filter(({ el, r, c }) => isRendered(el, r, c))
  stats.rendered = rendered.length
  stats.fixed = rendered.filter(({ c }) => c.position === 'fixed').length
  stats.sticky = rendered.filter(({ c }) => c.position === 'sticky').length
  stats.scrollX = records.filter(({ el }) => el.scrollWidth > el.clientWidth + 1 && /(auto|scroll|overlay)/.test(cs(el).overflowX)).length
  stats.scrollY = records.filter(({ el }) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(cs(el).overflowY)).length
  stats.interactive = rendered.filter(({ el }) => isInteractive(el)).length

  // ── ① 文档横向溢出 ──────────────────────────────────────────────────
  const docDelta = doc.scrollWidth - vw
  if (docDelta > payload.docOverflowPx) {
    detected['doc-overflow']++
    issues.push({
      rule: 'doc-overflow', sub: 'document', severity: docDelta >= 16 ? 'high' : 'medium',
      tag: 'html', id: '', cls: '', sel: 'html', text: '', position: 'static', zIndex: '',
      rect: { x: 0, y: 0, w: Math.round(doc.scrollWidth), h: Math.round(doc.scrollHeight) },
      amount: Math.round(docDelta),
    })
  }

  // ── ② 元素横向越界 ──────────────────────────────────────────────────
  {
    /**
     * 视觉上被祖先裁掉时不算「越界」：布局矩形伸出视口、但被祖先 overflow hidden/clip 切住的内容，
     * 用户看到的是**裁切**（由规则③在祖先上报），不是「元素露到视口外」。
     * 实测场景：操作日志表格的「上下文」列用 ellipsis + 祖先 overflow hidden 截断，
     * 其 span 的布局矩形会伸出视口 86px，但屏幕上只有省略号 —— 不排除会变成 79 条假越界。
     * @param {Element} el 目标元素。
     * @returns {Element|null} 最近的在 x 轴裁切它且确实有内容超出的祖先。
     */
    const clipAncestorX = (el) => {
      let p = el.parentElement
      while (p && p !== doc) {
        const pc = cs(p)
        if (/(hidden|clip)/.test(pc.overflowX) && p.scrollWidth > p.clientWidth + 1) return p
        p = p.parentElement
      }
      return null
    }
    const cand = []
    for (const { el, r, c } of rendered) {
      const rightOver = r.right - vw
      const leftOver = -r.left
      if (rightOver <= tol && leftOver <= tol) continue
      // 与视口完全无交集（上下左右任一方向都算「完全离屏」）→ 用户看不到，不能判「横向露出」。
      // 实测场景：settings 弹窗挂载瞬间滚到 y=-2581 的 header（宽度 838 > 390）被误报 privacy@390；
      // 两次单页复测均 0（flaky），加这条豁免后对「完全离屏」的布局中间态免疫。
      const intersectsViewport = r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh
      if (!intersectsViewport) continue
      if (el.closest('[aria-hidden="true"]')) continue
      // 纯装饰的固定/绝对定位层（超大背景网格等）：无文本、非交互、不含媒体 → 不计。
      const txt = directText(el)
      const hasMedia = !!el.querySelector('img,canvas,video,svg')
      if (!txt && !isInteractive(el) && !hasMedia &&
          (c.position === 'fixed' || c.position === 'absolute') && r.width >= vw) continue
      // 横向可滚容器内的内容：滚动可达，不是缺陷。
      if (scrollAncestor(el, 'x')) continue
      // 被祖先裁住的溢出：看到的是省略/裁切，交给规则③。
      if (clipAncestorX(el)) continue
      cand.push({ el, r, c, txt, rightOver, leftOver })
    }
    const candSet = new Set(cand.map((x) => x.el))
    // 只报最外层元凶：父级也在越界集合里 → 子级不重复报（父级宽度通常由子级撑开）。
    const picked = cand.filter((x) => !(x.el.parentElement && candSet.has(x.el.parentElement)))
    for (const x of picked) {
      const amount = Math.round(Math.max(x.rightOver, x.leftOver))
      const sev = amount >= 8 || x.txt || isInteractive(x.el) ? 'high' : 'medium'
      add('out-of-viewport', x.rightOver > 0 ? 'right' : 'left', x.el,
        { amount, overflowPx: amount }, sev)
    }
    capRule('out-of-viewport')
  }

  // ── ③ 被裁切 / 内容溢出容器 ─────────────────────────────────────────
  {
    const cand = []
    for (const { el, r, c } of rendered) {
      if (CONTROL_TAGS.has(el.tagName)) continue
      if (el.tagName === 'svg') continue
      if (el.closest(CHROME_SEL)) continue // 标题栏/侧栏/底栏是 chrome，字形的 1-4px 溢出不是业务缺陷
      if (el.closest('[aria-hidden="true"]')) continue // 纯装饰层（如 overview 的 NeonBackdrop），裁切是设计
      if (c.contentVisibility === 'auto') continue // 浏览器未渲染，scrollHeight 是占位值（既有审计已踩过）
      if (c.clip && /rect\(\s*0/.test(c.clip)) continue // sr-only
      if (Number.parseFloat(c.opacity || '1') <= 0.02) continue
      const ox = c.overflowX
      const oy = c.overflowY
      const dw = el.scrollWidth - el.clientWidth
      const dh = el.scrollHeight - el.clientHeight
      if (el.clientWidth < 8 || el.clientHeight < 8) continue
      const xScroll = /(auto|scroll|overlay)/.test(ox)
      const yScroll = /(auto|scroll|overlay)/.test(oy)
      // 纯装饰层（无文本、无媒体、无可交互后代）的 overflow:hidden 只是裁背景/光晕，不算内容裁切。
      const hasTextDesc = (el.textContent || '').trim().length > 0
      const hasMedia = !!el.querySelector('img,canvas,video')
      const hasInteractiveDesc = !!el.querySelector(INTERACTIVE_SEL)
      if (!hasTextDesc && !hasMedia && !hasInteractiveDesc) continue
      // 只装图片/视频的容器（朋友圈九宫格、头像框）：溢出 hidden 是**缩略图裁切**，按设计如此。
      // 注意：缺图时的文字兜底（「本机没有这张图…」）算文本，仍会被检出。
      if (!hasTextDesc && hasMedia && !hasInteractiveDesc) continue
      // 某个轴上存在真正裁切它的祖先 → 交给祖先报（根因在那一层）。
      // 有意截断：`-webkit-line-clamp` / `text-overflow:ellipsis` 是设计意图（仓内既有口径，
      // 见 overview-layout.spec.ts 与 panel-audit.mjs 的同一处排除），不计入「裁切」缺陷；
      // 只把数量记进 stats.intentionalTruncation，供人工复核。
      const lineClamp = c.webkitLineClamp && c.webkitLineClamp !== 'none'
      const ellipsis = c.textOverflow === 'ellipsis' && /nowrap/.test(c.whiteSpace)
      if (lineClamp || ellipsis) { stats.intentionalTruncation = (stats.intentionalTruncation ?? 0) + 1; continue }
      // 「spill」（overflow:visible 的溢出）只有**真的露到某个祖先盒子之外**才算视觉溢出：
      // flex 子项 scrollWidth>clientWidth 但文字仍落在父按钮里（实测设置弹窗的面板标题）是正常布局。
      // 纵向 visible 溢出是正常文档流（任务口径里 y 只测 hidden/clip），不计。
      const spillEscapes = (() => {
        const contentRight = rectOf(el).left + el.scrollWidth
        let p = el.parentElement
        let guard = 0
        while (p && p !== doc && guard++ < 30) {
          const pc = cs(p)
          if (/(hidden|clip)/.test(pc.overflowX)) return true // 会被裁 → 由父级报（clipAncestor 已判）
          const pr = rectOf(p)
          if (pr.width > 0 && pr.right >= contentRight - 1) return false // 溢出内容仍在祖先盒内
          p = p.parentElement
        }
        return true
      })()
      const xSpillTol = 4
      let xCand = !xScroll && dw > (/visible/.test(ox) ? xSpillTol : 1) && /(visible|hidden|clip)/.test(ox)
      let yCand = !yScroll && dh > 1 && /(hidden|clip)/.test(oy)
      if (xCand && /visible/.test(ox)) {
        if (scrollAncestor(el, 'x') || !spillEscapes) xCand = false
      }
      if (!xCand && !yCand) continue
      cand.push({ el, r, c, dw, dh, xCand, yCand })
    }
    const candSet = new Set(cand.map((x) => x.el))
    const picked = cand.filter((x) => !(x.el.parentElement && candSet.has(x.el.parentElement)))
    for (const x of picked) {
      const txt = directText(x.el)
      const interact = isInteractive(x.el)
      if (x.xCand) {
        const clippedX = /hidden|clip/.test(x.c.overflowX)
        const sub = clippedX ? 'x-clip' : 'x-spill'
        // hidden/clip 才是「看不见的内容」：≥24px 或自身承载文本/交互 → high；
        // 8 以下的多是边框/舍入误差 → low。visible 的 spill 只算「越界但不隐藏」，低一档。
        const sev = clippedX
          ? ((x.dw >= 24 || txt || interact) ? 'high' : x.dw >= 8 ? 'medium' : 'low')
          : ((x.dw >= 48 || txt) ? 'high' : 'medium')
        add('clipped', sub, x.el, { amount: x.dw, deltaX: x.dw }, sev)
      }
      if (x.yCand) {
        // y 轴只统计 overflow hidden/clip（可见的纵向溢出属正常文档流，不计）。
        const sev = (x.dh >= 24 || txt || interact) ? 'high' : x.dh >= 8 ? 'medium' : 'low'
        add('clipped', 'y-clip', x.el, { amount: x.dh, deltaY: x.dh }, sev)
      }
    }
    capRule('clipped')
  }

  // ── ④ 固定/粘性元素遮挡 ────────────────────────────────────────────
  {
    /**
     * 元素是否「当前真的画在屏幕上」：
     *   ① `checkVisibility({checkOpacity,checkVisibilityCSS})`（CSS 级：display/visibility/opacity/
     *      content-visibility；老内核没有该重载时退化为只看后续几何）；
     *   ② 中心点在视口内；
     *   ③ 逐级祖先 overflow∈hidden/clip/auto/scroll/overlay 时，中心点必须仍在该祖先的**可视矩形**内。
     *      位于滚动视口之外的内容虽然布局矩形存在、scrollTop 也能滚到，但此刻并没有被绘制，
     *      `elementFromPoint` 只可能打到上层 chrome —— 据此判「遮挡」就是 task-10 复现的 A1/A2 误报。
     *      `position:fixed` 的元素不被祖先 overflow 裁剪（除非祖先带 transform，此处不建模），跳过 ③。
     */
    const isPainted = (el, r, c) => {
      try {
        if (typeof el.checkVisibility === 'function' &&
            !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
      } catch { /* 老内核没有该重载：继续用几何判据 */ }
      if (isZeroRect(r)) return false
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) return false
      if (c.position === 'fixed') return true
      const CLIP = /(hidden|clip|auto|scroll|overlay)/
      let p = el.parentElement
      let guard = 0
      while (p && p !== doc && guard++ < 60) {
        const pc = cs(p)
        if (CLIP.test(pc.overflowX) || CLIP.test(pc.overflowY)) {
          const pr = rectOf(p)
          if (CLIP.test(pc.overflowX) && (cx < pr.left || cx > pr.right)) return false
          if (CLIP.test(pc.overflowY) && (cy < pr.top || cy > pr.bottom)) return false
        }
        p = p.parentElement
      }
      return true
    }

    const overlays = []
    for (const { el, r, c } of rendered) {
      if (c.position !== 'fixed' && c.position !== 'sticky') continue
      const zi = Number.parseInt(c.zIndex, 10)
      if (!Number.isFinite(zi) || zi <= 0) continue
      if (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) continue
      if (!isPainted(el, r, c)) continue // 被祖先裁掉的 sticky/fixed 层画不出来，不能算遮挡源
      overlays.push({ el, r, c, zi })
    }
    stats.overlays = overlays.length

    /** 最近的可滚动容器（纵向）——「滚动能不能把目标从覆盖层下面挪出来」要用它。 */
    const nearestVScroll = (el) => {
      let p = el.parentElement
      while (p && p !== doc) {
        const c = cs(p)
        if (/(auto|scroll|overlay)/.test(c.overflowY) && p.scrollHeight > p.clientHeight + 1) return p
        p = p.parentElement
      }
      return null
    }
    /**
     * 边缘 chrome（顶部标题栏 / 底部标签栏）与粘性条的遮挡是否可被滚动解除。
     *
     * 固定底栏压住内容在移动端是**常态**：内容在底栏下方滚过，用户往下滚就能把它挪出来。
     * 真正的问题是「滚到底也露不出来」（例如表格底部没有为底栏留 padding 的「加载更多」）。
     * 这里就地算一次：滚到极限后目标是否完全落在覆盖层之外；能 → 不算缺陷。
     *
     * task-10 起 sticky 覆盖层也走同一豁免（旧版只认 fixed，导致「被滚动容器裁住的 sticky td」
     * 一律按遮挡报，这正是 A2 ledger@390 的误报来源）。sticky 的锚定方向相对其滚动容器判定。
     */
    const canScrollClear = (t, o) => {
      const pos = o.c.position
      if (pos !== 'fixed' && pos !== 'sticky') return false
      const sc = nearestVScroll(t.el)
      if (!sc) return false
      let topAnchored = false
      let bottomAnchored = false
      if (pos === 'fixed') {
        topAnchored = o.r.bottom <= vh * 0.45
        bottomAnchored = o.r.top >= vh * 0.55
      } else {
        const scRect = rectOf(sc)
        topAnchored = o.r.top <= scRect.top + 4
        bottomAnchored = o.r.bottom >= scRect.bottom - 4
        if (!topAnchored && !bottomAnchored) return false
      }
      if (bottomAnchored) {
        const remaining = Math.max(0, sc.scrollHeight - sc.clientHeight - sc.scrollTop)
        const topAtEnd = t.r.top - remaining
        return topAtEnd + t.r.height <= o.r.top + 2
      }
      const up = Math.max(0, sc.scrollTop)
      const topAtStart = t.r.top + up
      return topAtStart >= o.r.bottom - 2
    }

    const targets = []
    const targetSet = new Set()
    for (const { el, r, c } of rendered) {
      if (overlays.some((o) => o.el === el)) continue
      if (el.closest('#test-mode-banner')) continue
      const interactive = isInteractive(el)
      const txt = directText(el)
      if (!interactive && !txt) continue
      if (r.width * r.height < 4) continue
      if (!isPainted(el, r, c)) continue // 目标本就没画出来（在滚动视口外/被裁）→ 谈不上遮挡
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      // 只报「最外层目标」：按钮里的文字 span 不必与按钮各报一次。
      let anc = el.parentElement
      let dup = false
      while (anc && anc !== scopeRoot) {
        if (targetSet.has(anc)) { dup = true; break }
        anc = anc.parentElement
      }
      if (dup) continue
      targetSet.add(el)
      targets.push({ el, r, interactive, txt, cx, cy })
      if (targets.length >= 1500) break
    }
    for (const t of targets) {
      const tArea = Math.max(1, t.r.width * t.r.height)
      let hitIssue = null
      for (const o of overlays) {
        if (o.el === t.el || o.el.contains(t.el) || t.el.contains(o.el)) continue
        if (intersects(t.r, o.r) <= 0) continue
        // 命中测试：目标中心点真的被覆盖层拿走了（而不是只在几何上相交）。
        const hit = document.elementFromPoint(t.cx, t.cy)
        if (!hit) continue
        if (hit === t.el || t.el.contains(hit) || hit.contains(t.el)) continue
        const hitOverlay = overlays.find((oo) => oo.el === hit || oo.el.contains(hit))
        if (!hitOverlay) continue
        // 归因到**真正命中的那个覆盖层**（旧版归因到几何相交的 o，会把不可见的 sticky 层算成凶手）。
        const pct = intersects(t.r, hitOverlay.r) / tArea
        if (pct < overlapPct) continue
        if (canScrollClear(t, hitOverlay)) { stats.escapedOcclusion = (stats.escapedOcclusion ?? 0) + 1; continue }
        hitIssue = { overlay: hitOverlay, pct, hit }
        break
      }
      // 视觉遮挡（覆盖层 pointer-events:none）：命中测试拿不到它，但大面积盖住可交互元素。
      let visualIssue = null
      if (!hitIssue) {
        for (const o of overlays) {
          if (o.c.pointerEvents !== 'none') continue
          if (o.el.contains(t.el) || t.el.contains(o.el)) continue
          if (!t.interactive) continue // 只对可交互元素报「视觉遮挡」，避免大面积装饰层噪声
          const inter = intersects(t.r, o.r)
          if (inter <= 0) continue
          const pct = inter / tArea
          if (pct < visualPct) continue
          if (canScrollClear(t, o)) { stats.escapedOcclusion = (stats.escapedOcclusion ?? 0) + 1; continue }
          visualIssue = { overlay: o, pct }
          break
        }
      }
      if (hitIssue) {
        add('occluded', 'intercepted', t.el, {
          amount: Math.round(hitIssue.pct * 100),
          overlaySelector: selectorPath(hitIssue.overlay.el),
          overlayText: (directText(hitIssue.overlay.el) || '').slice(0, 40),
          overlayZ: hitIssue.overlay.zi,
          overlapPct: Math.round(hitIssue.pct * 100),
        }, t.interactive ? 'high' : 'medium')
      } else if (visualIssue) {
        add('occluded', 'visual-only', t.el, {
          amount: Math.round(visualIssue.pct * 100),
          overlaySelector: selectorPath(visualIssue.overlay.el),
          overlayText: (directText(visualIssue.overlay.el) || '').slice(0, 40),
          overlayZ: visualIssue.overlay.zi,
          overlapPct: Math.round(visualIssue.pct * 100),
        }, 'medium')
      }
    }
    capRule('occluded')
  }

  // ── ⑤ 有文本但不可见 ────────────────────────────────────────────────
  {
    const reported = new Set()
    const srOnlyRe = /sr[-_]?only|visually[-_]?hidden|screen[-_]?reader|a11y[-_]?hidden|visuallyhidden/i
    for (const { el, r, c } of records) {
      if (CONTROL_TAGS.has(el.tagName)) continue // 表单控件的 value 不是「界面文本」（隐藏 checkbox 等）
      const txt = directText(el)
      if (!txt) continue
      if (el.closest('[aria-hidden="true"]')) continue
      // 桌面自绘标题栏 / 侧栏 / 手机底部栏 / 弹窗内的导航轨：导航是 chrome，
      // 窄屏把导航里的说明文字收成图标是有意设计，不算业务内容被隐藏。
      if (el.closest(CHROME_SEL)) continue
      if (el.closest('nav')) continue
      if (el.closest('#test-mode-banner')) continue
      if (srOnlyRe.test((el.getAttribute && el.getAttribute('class')) || '')) continue
      // 找「最高一层不可见祖先」：同一棵隐藏子树只报一次。
      let node = el
      let hiddenNode = null
      let reason = ''
      let guard = 0
      while (node && node !== body && guard < 40) {
        guard++
        const cnode = cs(node)
        const rnode = rectOf(node)
        let why = ''
        if (cnode.display === 'none') why = 'display-none'
        else if (cnode.visibility === 'hidden' || cnode.visibility === 'collapse') why = 'visibility-hidden'
        else if (isZeroRect(rnode)) why = 'zero-size'
        else if (node.checkVisibility && !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          why = Number.parseFloat(cnode.opacity || '1') <= 0.02 ? 'opacity-zero' : 'check-visibility-hidden'
        }
        if (why) { hiddenNode = node; reason = why }
        node = node.parentElement
      }
      if (!hiddenNode || reported.has(hiddenNode)) continue
      reported.add(hiddenNode)
      const hn = hiddenNode
      const hiddenText = (directText(hn) || txt).replace(/\s+/g, ' ').trim()
      const interact = isInteractive(hn) || isInteractive(el)
      // opacity:0 的 1-2 字符（表头排序箭头「↕」这类悬停/激活才出现的装饰）直接排除；
      // 更长的 opacity:0 文本仍按 low 保留（可能是被误藏的字段）。
      if (reason === 'opacity-zero' && hiddenText.length <= 2) continue
      const sev = interact ? 'high' : reason === 'opacity-zero' ? 'low' : hiddenText.length >= 12 ? 'medium' : 'low'
      add('hidden', reason, hn, { amount: hiddenText.length, hiddenText: hiddenText.slice(0, 60) }, sev)
    }
    // 同一父级下多个被隐藏的兄弟（被 display:none 包裹的整块）已由「最高隐藏祖先」归并。
    capRule('hidden')
  }

  // ── 视图信息（用于识别「多个 tab 落到同一视图」的别名关系）────────────
  const viewRoot = dialog ?? document.querySelector('main') ?? body
  const viewText = (viewRoot.innerText || '').replace(/\s+/g, ' ').trim()
  const activeNav = (() => {
    const aside = document.querySelector('aside')
    if (aside) {
      const a = aside.querySelector('[data-active="true"], [aria-current="page"]')
      if (a) return (a.textContent || '').trim().slice(0, 24)
    }
    const nav = document.querySelector('nav[aria-label="主导航"]')
    if (nav) {
      const a = nav.querySelector('[aria-current="page"]')
      if (a) return (a.textContent || '').trim().slice(0, 24)
      const d = nav.querySelector('[data-active="true"]')
      if (d) return (d.textContent || '').trim().slice(0, 24)
    }
    return ''
  })()
  const dialogTitle = (() => {
    if (!dialog) return ''
    const h = dialog.querySelector('h1, h2, h3')
    if (h) return (h.textContent || '').trim().slice(0, 40)
    const t = dialog.querySelector('[class*="title"], [class*="Title"]')
    return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  })()

  return {
    viewport: { vw, vh, dpr: window.devicePixelRatio || 1 },
    dialog: !!dialog,
    resolved: {
      hash: location.hash,
      activeNav,
      dialogTitle,
      viewHead: viewText.slice(0, 120),
      signature: `${dialog ? 'dialog' : 'page'}|${activeNav}|${viewText.slice(0, 40)}`,
    },
    doc: {
      scrollWidth: Math.round(doc.scrollWidth),
      clientWidth: Math.round(doc.clientWidth),
      bodyScrollWidth: Math.round(body.scrollWidth),
      scrollHeight: Math.round(doc.scrollHeight),
      innerWidth: vw,
      innerHeight: vh,
    },
    counts: { detected, truncated: ruleTruncated, retained: issues.length },
    issues,
    stats,
  }
}
