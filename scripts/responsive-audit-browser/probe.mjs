/**
 * 手机浏览器专项探针（Wave 3 从入口文件机械拆出，检测逻辑未改）。
 *
 * 视口元信息 / dvh / 安全区 / 标题栏 / 触摸目标 / 小字号正文 / hover-only 风险 /
 * 底部固定层（输入法遮挡的结构指标）。纯读取 DOM 与 CSSOM，不点击、不滚动。
 *
 * ⚠️ 与 `AUDIT_PAGE` 一样会被 Playwright 序列化进浏览器执行，函数体内**不能引用 Node
 * 作用域的任何东西**（`directText` 刻意内联在函数里）。
 *
 * @module scripts/responsive-audit-browser/probe
 */

/**
 * 手机浏览器特有问题探针：视口元信息 / dvh / 安全区 / 标题栏 / 触摸目标 /
 * 小字号正文 / hover-only 风险 / 底部固定层（输入法遮挡的结构指标）。
 *
 * 纯读取 DOM 与 CSSOM，不点击、不滚动、不修改页面。
 * ⚠️ 与 `AUDIT_PAGE` 一样会被 Playwright 序列化进浏览器执行，函数体内**不能引用 Node 作用域的
 * 任何东西**（下面 `directText` 是刻意内联的，不能提到模块级公用 —— 否则浏览器里 ReferenceError）。
 * @returns {object} 原始观测值（判定与汇总在 Node 侧做）。
 */
 export function PROBE_MOBILE () {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const doc = document.documentElement
  const body = document.body
  const cs = (el) => getComputedStyle(el)
  const rect = (el) => el.getBoundingClientRect()
  const visible = (el) => {
    const r = rect(el)
    const c = cs(el)
    return r.width > 1 && r.height > 1 && c.display !== 'none' && c.visibility !== 'hidden' && Number.parseFloat(c.opacity || '1') > 0.02
  }
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  /** 直接文本（只认直接子文本节点；与检测器同一口径）。 */
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

  // ① 视口元信息（手机浏览器的第一块地基：没有 viewport 元信息 = 桌面宽度渲染）
  const metaEl = document.querySelector('meta[name="viewport"]')
  const meta = metaEl ? metaEl.getAttribute('content') || '' : ''
  // ② dvh：地址栏收起时「布局高度 vs 可见高度」会不会打架（0 = 一致；正数 = 布局比可见高）
  const htmlH = rect(doc).height
  const bodyH = rect(body).height
  const root = document.getElementById('root')
  const rootH = root ? rect(root).height : 0
  const visual = window.visualViewport
    ? { height: Math.round(window.visualViewport.height), offsetTop: Math.round(window.visualViewport.offsetTop) }
    : null
  // ③ 安全区：headless 下 env() 恒为 0，这里量的是「CSS 有没有消费它」+ 实际解析值
  const bodyStyle = cs(body)
  const safeArea = {
    paddingTop: Number.parseFloat(bodyStyle.paddingTop) || 0,
    paddingLeft: Number.parseFloat(bodyStyle.paddingLeft) || 0,
    paddingRight: Number.parseFloat(bodyStyle.paddingRight) || 0,
    paddingBottom: Number.parseFloat(bodyStyle.paddingBottom) || 0,
  }
  // ④ 浏览器模式下 Electron 自绘标题栏应被移除（capabilities.titlebar=false）
  const titlebar = document.getElementById('titlebar')
  // ⑤ 触摸目标 < 44px（WCAG 2.5.5 / Apple HIG）：可交互、可见、有文本/aria，排除密集筛选控件
  const interactiveSel = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'
  const skipDense = new Set(['checkbox', 'radio'])
  const tinyTargets = []
  for (const el of document.querySelectorAll(interactiveSel)) {
    if (!visible(el)) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' && skipDense.has((el.getAttribute('type') || '').toLowerCase())) continue
    if (el.hasAttribute('data-search-input') || el.hasAttribute('data-global-search')) continue
    const r = rect(el)
    if (r.height >= 44 || r.width < 8) continue
    const label = (el.getAttribute('aria-label') || textOf(el) || el.getAttribute('title') || '').slice(0, 24)
    if (label === '' && tag !== 'input' && tag !== 'select') continue
    tinyTargets.push({ tag, label, h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.left), y: Math.round(r.top) })
  }
  // ⑥ 小字号正文（< 11px 且是一段有实质内容的文本）——手机上读不清
  const smallText = []
  for (const el of document.querySelectorAll('p, li, td, th, dd, dt, label, span, div')) {
    const t = directText(el)
    if (t.length < 8) continue
    if (!visible(el)) continue
    const fs = Number.parseFloat(cs(el).fontSize) || 0
    if (fs <= 0 || fs >= 11) continue
    smallText.push({ text: t.slice(0, 32), fs: Math.round(fs * 10) / 10, tag: el.tagName.toLowerCase() })
    if (smallText.length >= 12) break
  }
  // ⑦ hover-only 风险：样式表里只在 :hover 上改 display/visibility/opacity 的规则（触摸设备没有 hover）
  const hoverOnly = []
  let hoverRuleCount = 0
  try {
    for (const sheet of document.styleSheets) {
      let rules = []
      try { rules = [...sheet.cssRules] } catch { continue } // 跨域表跳过
      for (const rule of rules) {
        const sel = rule.selectorText || ''
        if (!sel.includes(':hover')) continue
        const text = rule.cssText || ''
        if (!/(display|visibility|opacity)\s*:/.test(text)) continue
        hoverRuleCount++
        if (hoverOnly.length < 8) hoverOnly.push(sel.slice(0, 120))
      }
    }
  } catch { /* CSSOM 不可读时跳过 */ }
  // ⑧ 底部固定层：占视口高度 > 20% 的 fixed 元素（软键盘/地址栏弹出时的遮挡风险指标）
  const fixedBottom = []
  for (const el of document.querySelectorAll('body *')) {
    const c = cs(el)
    if (c.position !== 'fixed') continue
    const r = rect(el)
    if (r.width < 40 || r.height < 20) continue
    const share = r.height / vh
    if (share < 0.12) continue
    fixedBottom.push({ sel: (el.getAttribute('class') || el.tagName).slice(0, 60), h: Math.round(r.height), share: Math.round(share * 100), bottomAnchored: r.bottom >= vh - 4 })
    if (fixedBottom.length >= 8) break
  }
  // ⑨ 横向滚动（文档级）与 body 滚动行为
  const scroll = {
    docScrollWidth: doc.scrollWidth,
    docClientWidth: doc.clientWidth,
    bodyScrollWidth: body.scrollWidth,
    innerWidth: vw,
    bodyOverflowX: bodyStyle.overflowX,
    bodyOverflowY: bodyStyle.overflowY,
    htmlOverscroll: cs(doc).overscrollBehaviorY,
  }
  // ⑩ 移动端壳：底部主标签栏 / 侧栏（判断四档里壳形态是否与断点一致）
  const bottomNav = document.querySelector('nav[aria-label="主导航"]')
  const navRect = bottomNav ? rect(bottomNav) : null
  const aside = document.querySelector('aside')
  const asideVisible = aside ? visible(aside) : false

  return {
    viewport: { vw, vh, dpr: window.devicePixelRatio || 1 },
    metaViewport: meta,
    hasViewportFitCover: /viewport-fit\s*=\s*cover/i.test(meta),
    heights: { html: Math.round(htmlH), body: Math.round(bodyH), root: Math.round(rootH), visual },
    safeArea,
    titlebarPresent: !!titlebar,
    shell: {
      bottomNav: !!bottomNav,
      bottomNavRect: navRect ? { h: Math.round(navRect.height), top: Math.round(navRect.top), bottom: Math.round(navRect.bottom) } : null,
      asideVisible,
    },
    tinyTargets: { count: tinyTargets.length, sample: tinyTargets.slice(0, 8) },
    smallText: { count: smallText.length, sample: smallText.slice(0, 6) },
    hoverOnly: { ruleCount: hoverRuleCount, sample: hoverOnly },
    fixedBottom,
    scroll,
  }
}
