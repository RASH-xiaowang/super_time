/**
 * Wave 4 · 刘海/安全区/动态地址栏的 **CDP 设备仿真**（手机浏览器专用探针与矩阵流程）。
 *
 * ## 为什么需要这一层
 *
 * Wave 3 的真实 Chrome 审计（`scripts/responsive-audit-browser.mjs`）已经把「真实 LAN 服务 +
 * 38 tab × 4 档」跑通，但无头 Chrome 的 `env(safe-area-inset-*)` 恒为 0 —— 刘海/手势条/挖孔
 * 从未在仿真里出现过。本模块用 CDP 的**安全区覆盖**把 `env()` 变成可注入的量，于是：
 *   · `.root`/`body` 里的 `env(safe-area-inset-*)` 留白、底部标签栏的手势条 padding、
 *     横屏左右刘海、全屏弹窗顶部的刘海避让，全部可以被**量出来**；
 *   · 地址栏收/展用「同一页在两个视口高度之间切换」近似，断言 `100dvh` 链跟随 `innerHeight`、
 *     固定底栏不悬空、底部按钮不出视口。
 *
 * ## CDP 命令（Chrome 155 实测；与本任务最初假设不同，写进报告）
 *
 *   · **`Emulation.setSafeAreaInsetsOverride`**（experimental，本机 Chrome 协议里**存在**）
 *     是唯一能覆盖 `env(safe-area-inset-*)` / `env(safe-area-max-inset-*)` 的命令：
 *     `{ insets: { top, right, bottom, left } }`（整数 px；`{ insets: {} }` 清空）。
 *     实测：注入后 `env()` 立即变成注入值；清空即回 0。**这是主路径。**
 *   · 任务书假设的 `Emulation.setDisplayCutoutOverride` **在本机 Chrome 155 的协议里不存在**
 *     （`Schema.getDomains` + 实际 `send` 均报 `wasn't found`），所以不是「有但不会用」，
 *     而是该版本没有这个命令；协议里同族只有 `setSafeAreaInsetsOverride` /
 *     `setDisplayFeaturesOverride`（折叠屏的 Viewport Segments）/ `setDeviceMetricsOverride`
 *     的 `displayFeature`（已 deprecated，且**不作用于 env(safe-area-inset-*)`）。
 *   · 降级：若宿主 Chrome 没有 `setSafeAreaInsetsOverride`（老版本），依次探测
 *     `Emulation.setDisplayFeaturesOverride` 与 `setDeviceMetricsOverride.displayFeature`；
 *     两者都只能提供折叠屏设备特征、**无法伪造 env()**，此时本模块把矩阵标为
 *     `emulation: 'unavailable'`，只跑「几何/固定底栏」检查并明确写入报告，不假装量到了安全区。
 *
 * ## 仿真边界（报告同口径复述）
 *
 *   1. 无头 Chrome 注入的 insets 是**矩形安全区**，不是真实刘海形状（真机顶部中央缺口两侧仍可见）；
 *      「元素落在安全区内」在本模块里按「矩形 band 相交」近似，是**保守**判据。
 *   2. `env()` 覆盖对 `viewport-fit` 更宽松：即使没有 `viewport-fit=cover`，注入也会让 env 非 0；
 *      真实设备不加 `viewport-fit=cover` 时 env 恒 0。本仓库 `index.html` 已由 Lead 补
 *      `viewport-fit=cover`，所以该差异不影响结论真实性。
 *   3. 地址栏：CDP 没有「只把地址栏收起来」的仿真命令（`Emulation.setVisibleSize` 实测是 no-op，
 *      `visualViewport` 不变）；本模块用「改视口高度」近似收/展。桌面 Chrome 里 `dvh==vh==innerHeight`，
 *      所以**只能验证布局链跟随视口高度、固定元素不悬空**，验证不了真机 `vh`（大视口）与
 *      `dvh`（动态视口）的差异本身 —— 后者用「静态扫描 `vh` 单位声明」补一刀。
 *   4. 软键盘/输入法仍无法唤起（无头环境），只做结构性检查。
 *
 * @module scripts/responsive-audit-browser/emulate
 */

/** 刘海/挖孔仿真档位（尺寸 × 安全区矩形；单位 px，按真机公开参数取整）。 */
export const CUTOUT_PROFILES = [
  {
    label: '375x812-notch',
    w: 375,
    h: 812,
    device: 'iPhone X 类刘海屏（竖屏）',
    insets: { top: 44, right: 0, bottom: 34, left: 0 },
  },
  {
    label: '390x844-punch',
    w: 390,
    h: 844,
    device: 'Android 挖孔屏（竖屏）。注：Android 手势条常见 0–24px，这里取 24 做最坏假设',
    insets: { top: 32, right: 0, bottom: 24, left: 0 },
  },
  {
    label: '812x375-landscape',
    w: 812,
    h: 375,
    device: '刘海屏横屏：刘海在左/右，底部手势条',
    insets: { top: 0, right: 44, bottom: 21, left: 44 },
  },
]

/** Wave 4 覆盖的页签：6 个设置类 + 4 个有固定底栏/输入框/弹层的面板。 */
export const SAFE_AREA_TABS = ['privacy', 'privacytrust', 'backup', 'health', 'hook', 'settings', 'overview', 'ledger', 'monitor', 'moments']

/** 动态地址栏收/展仿真的两个高度（任务书给的 375×667 ↔ 375×735）。 */
export const DYNAMIC_TOOLBAR_SIZES = {
  barVisible: { w: 375, h: 667, label: '375x667-地址栏可见' },
  barHidden: { w: 375, h: 735, label: '375x735-地址栏收起' },
}

/** CDP 主命令 / 降级命令名（探测结果写进 meta，报告引用）。 */
export const CDP_SAFE_AREA_COMMAND = 'Emulation.setSafeAreaInsetsOverride'
export const CDP_FALLBACK_COMMANDS = ['Emulation.setDisplayFeaturesOverride', 'Emulation.setDeviceMetricsOverride(displayFeature)']

// ══════════════════════════════════════════════════════════════════════════
// CDP 能力探测与安全区注入
// ══════════════════════════════════════════════════════════════════════════

/**
 * 用一次真实 `send` 探测本机 Chrome 是否支持安全区覆盖（协议里 `wasn't found` 即不支持）。
 *
 * 探测时先注入 1px 再清空：既证明命令存在，也证明它**真的作用于渲染进程**（不是空实现）。
 * @param {import('playwright').CDPSession} cdp
 * @returns {Promise<{command:string|null, fallback:string|null, notes:string[]}>}
 */
export async function detectSafeAreaSupport (cdp) {
  const notes = []
  try {
    await cdp.send(CDP_SAFE_AREA_COMMAND, { insets: { top: 1, right: 1, bottom: 1, left: 1 } })
    await cdp.send(CDP_SAFE_AREA_COMMAND, { insets: {} })
    return { command: CDP_SAFE_AREA_COMMAND, fallback: null, notes }
  } catch (e) {
    notes.push(`${CDP_SAFE_AREA_COMMAND} 不可用：${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`)
  }
  for (const candidate of CDP_FALLBACK_COMMANDS) {
    const bare = candidate.replace(/\(.*\)$/, '')
    try {
      if (bare === 'Emulation.setDisplayFeaturesOverride') {
        await cdp.send(bare, { features: [] })
        notes.push(`${bare} 可用，但只填充折叠屏 Viewport Segments，**不覆盖 env(safe-area-inset-*)**`)
      } else {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
          displayFeature: { orientation: 'vertical', offset: 195, maskLength: 0 },
        })
        await cdp.send('Emulation.clearDeviceMetricsOverride')
        notes.push('setDeviceMetricsOverride.displayFeature 可用（已 deprecated），**不覆盖 env(safe-area-inset-*)**')
      }
      return { command: null, fallback: bare, notes }
    } catch (e) {
      notes.push(`${bare} 也不可用：${String(e?.message ?? e).split('\n')[0].slice(0, 140)}`)
    }
  }
  return { command: null, fallback: null, notes }
}

/**
 * 注入安全区（envelope 内命令不存在时抛错，由调用方标 unavailable）。
 * @param {import('playwright').CDPSession} cdp
 * @param {{top?:number,right?:number,bottom?:number,left?:number}} insets
 */
export async function applySafeArea (cdp, insets) {
  await cdp.send(CDP_SAFE_AREA_COMMAND, { insets })
}

/**
 * 清空安全区覆盖（回到无刘海状态）。
 * @param {import('playwright').CDPSession} cdp
 */
export async function clearSafeArea (cdp) {
  try { await cdp.send(CDP_SAFE_AREA_COMMAND, { insets: {} }) } catch { /* 老 Chrome：本来就没注入过 */ }
}

// ══════════════════════════════════════════════════════════════════════════
// 页面内探针（会被序列化进浏览器执行；不能引用 Node 作用域任何东西）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 安全区/固定底栏/弹窗的页面内观测（纯读取，不点击不滚动）。
 *
 * 产出三组事实：
 *   ① `env` 实测值（用 off-screen fixture 读 `env(safe-area-inset-*)`）——证明 CDP 注入是否生效；
 *   ② 四条安全区 band 内的**文本/可交互元素**（保守判据：矩形相交即算；装饰层/背景不算）；
 *   ③ 高度链与固定底栏几何：`html/body/#root` 高度、底部标签栏 rect、有无越出视口、
 *      全屏弹窗 rect（顶部是否落在刘海里）。
 * @param {{insets?:{top:number,right:number,bottom:number,left:number}}} payload - 注入值（仅用于比对，不参与计算）。
 * @returns {object} 原始观测。
 */
export function PROBE_SAFE_AREA (payload) {
  const expect = (payload && payload.insets) || { top: 0, right: 0, bottom: 0, left: 0 }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const doc = document.documentElement
  const body = document.body
  const cs = (el) => getComputedStyle(el)
  const rectOf = (el) => el.getBoundingClientRect()

  // ① env() 实测（临时 fixture，读完立刻移除；主题/布局无副作用）
  const envEl = document.createElement('div')
  envEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;'
    + 'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);'
    + 'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)'
  body.appendChild(envEl)
  const envCs = cs(envEl)
  const env = {
    top: Math.round(Number.parseFloat(envCs.paddingTop) || 0),
    right: Math.round(Number.parseFloat(envCs.paddingRight) || 0),
    bottom: Math.round(Number.parseFloat(envCs.paddingBottom) || 0),
    left: Math.round(Number.parseFloat(envCs.paddingLeft) || 0),
  }
  envEl.remove()

  // ② 安全区 band 内元素（文本/可交互；排除背景装饰与整屏容器）
  const rootEl = document.getElementById('root')
  const interactiveSel = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), summary'
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
  const isVisible = (el) => {
    const r = rectOf(el)
    if (r.width < 1 || r.height < 1) return false
    if (r.bottom <= 0 || r.top >= vh) return false // 完全在视口外的不算「被安全区盖住」
    const c = cs(el)
    return c.display !== 'none' && c.visibility !== 'hidden' && Number.parseFloat(c.opacity || '1') > 0.02
  }
  /** 最近的有 fixed/sticky 定位的祖先（含自身）：固定层是手势条/刘海遮挡的真实风险面。 */
  const hasFixedAncestor = (el) => {
    let n = el
    let depth = 0
    while (n && n !== body && depth < 12) {
      const c = cs(n)
      if (c.position === 'fixed' || c.position === 'sticky') return true
      n = n.parentElement
      depth++
    }
    return false
  }
  /** 最近的可滚祖先（坐标轴上 overflow auto/scroll）：这些内容可滚动到安全区内，不算「被裁」。 */
  const inScrollable = (el) => {
    let n = el.parentElement
    let depth = 0
    while (n && n !== body && depth < 12) {
      const c = cs(n)
      if (/(auto|scroll|overlay)/.test(c.overflowX) || /(auto|scroll|overlay)/.test(c.overflowY)) return true
      n = n.parentElement
      depth++
    }
    return false
  }
  const selPath = (el) => {
    const parts = []
    let n = el
    let depth = 0
    while (n && n !== body && depth < 4) {
      let s = n.tagName.toLowerCase()
      if (n.id) s += '#' + n.id
      const cls = (n.getAttribute && n.getAttribute('class')) ? n.getAttribute('class') : ''
      s += cls.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c.replace(/[^\w-]/g, '_').slice(0, 26)).join('')
      parts.unshift(s)
      n = n.parentElement
      depth++
    }
    return parts.join(' > ').slice(0, 180)
  }
  // 先确定「当前正在看的那一层」：弹窗打开时只审计弹窗内部，背景是 inert/遮罩（与桌面检测器同口径）。
  const dialogEl = [...document.querySelectorAll('[role="dialog"]')]
    .filter((d) => isVisible(d))
    .sort((a, b) => rectOf(b).width * rectOf(b).height - rectOf(a).width * rectOf(a).height)[0] || null
  /**
   * 收集落在某条安全区 band 里的「真正会被盖住」的元素。
   * 判据（每条都对应一种真机事故）：
   *   · 与 band 相交 ≥3px（1px 亚像素/取整噪声不算）；
   *   · 排除完全在视口外的（那是滚动内容，用户滚一下就能看到）；
   *   · 排除在可滚祖先里的常规内容（能滚就不可达性不成立）；
   *   · 底部 band 只认固定/粘性层与弹窗内部（普通内容滚到底还有自己的 padding，不是遮挡）；
   *   · `inDialog` 标记便于判定时按弹窗作用域过滤。
   */
  const collectBand = (band, axis) => {
    const out = []
    for (const el of body.querySelectorAll('*')) {
      if (el === rootEl || el === body || el === doc) continue
      const r = rectOf(el)
      if (r.width < 8 || r.height < 8) continue
      const overlap = !(r.bottom <= band.top || r.top >= band.bottom || r.right <= band.left || r.left >= band.right)
      if (!overlap) continue
      const overlapDepth = axis === 'y' ? Math.min(r.bottom, band.bottom) - Math.max(r.top, band.top) : Math.min(r.right, band.right) - Math.max(r.left, band.left)
      if (overlapDepth < 3) continue
      if (!isVisible(el)) continue
      const text = directText(el)
      const interactive = !!el.closest(interactiveSel)
      if (text === '' && !interactive) continue
      // 整屏容器（overlay/遮罩/背景）本身不报：它铺满是设计，报里面真正的内容元素。
      if (r.width >= vw - 2 && r.height >= vh - 2) continue
      if (inScrollable(el)) continue
      const inDialog = !!(dialogEl && dialogEl.contains(el))
      const fixedLayer = hasFixedAncestor(el)
      if (band.kind === 'bottom' && !fixedLayer && !inDialog) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        sel: selPath(el),
        text: text.slice(0, 28),
        interactive,
        inDialog,
        fixedLayer,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      })
      if (out.length >= 12) break
    }
    return out
  }
  const bands = {
    top: collectBand({ kind: 'top', top: 0, bottom: expect.top > 0 ? expect.top : 0, left: 0, right: vw }, 'y'),
    bottom: collectBand({ kind: 'bottom', top: vh - (expect.bottom > 0 ? expect.bottom : 0), bottom: vh, left: 0, right: vw }, 'y'),
    left: collectBand({ kind: 'left', top: 0, bottom: vh, left: 0, right: expect.left > 0 ? expect.left : 0 }, 'x'),
    right: collectBand({ kind: 'right', top: 0, bottom: vh, left: vw - (expect.right > 0 ? expect.right : 0), right: vw }, 'x'),
  }

  // ③ 高度链 / 固定底栏 / 弹窗
  const rootRect = rootEl ? rectOf(rootEl) : null
  const nav = document.querySelector('nav[aria-label="主导航"]')
  const navRect = nav ? rectOf(nav) : null
  let navInfo = null
  if (nav && navRect) {
    const ncs = cs(nav)
    navInfo = {
      rect: { x: Math.round(navRect.x), y: Math.round(navRect.y), w: Math.round(navRect.width), h: Math.round(navRect.height) },
      bottomGap: Math.round(vh - navRect.bottom),
      paddingBottom: Math.round(Number.parseFloat(ncs.paddingBottom) || 0),
      paddingLeft: Math.round(Number.parseFloat(ncs.paddingLeft) || 0),
      paddingRight: Math.round(Number.parseFloat(ncs.paddingRight) || 0),
      position: ncs.position,
    }
  }
  const dialog = dialogEl
  let dialogInfo = null
  if (dialog) {
    const dr = rectOf(dialog)
    const btns = [...dialog.querySelectorAll('button, input, [role="button"]')]
      .filter((b) => isVisible(b))
      .map((b) => {
        const r = rectOf(b)
        return { tag: b.tagName.toLowerCase(), text: directText(b).slice(0, 20), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      })
    dialogInfo = { rect: { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.width), h: Math.round(dr.height) }, buttons: btns.slice(0, 8) }
    const dcs = cs(dialog)
    dialogInfo.style = {
      position: dcs.position, top: dcs.top, left: dcs.left, transform: dcs.transform,
      margin: `${dcs.marginTop} ${dcs.marginRight} ${dcs.marginBottom} ${dcs.marginLeft}`,
      boxSizing: dcs.boxSizing, paddingBottom: dcs.paddingBottom, paddingTop: dcs.paddingTop,
      className: (dialog.getAttribute('class') || '').slice(0, 120),
    }
    // 诊断：弹窗打开时 body 的安全区 padding 可能被滚动锁/portal 影响 —— 记录可复现的事实而不是猜
    const chain = []
    let anc = dialog.parentElement
    let depth = 0
    while (anc && anc !== body && depth < 4) {
      const ar = rectOf(anc)
      chain.push({ tag: anc.tagName.toLowerCase(), cls: ((anc.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0] || '').slice(0, 40), position: cs(anc).position, rect: { x: Math.round(ar.x), y: Math.round(ar.y), w: Math.round(ar.width), h: Math.round(ar.height) } })
      anc = anc.parentElement
      depth++
    }
    dialogInfo.ancestors = chain
    dialogInfo.parentIsBody = dialog.parentElement === body
  }
  const diag = {
    bodyClassName: (body.getAttribute('class') || '').slice(0, 120),
    bodyInlineStyle: (body.getAttribute('style') || '').slice(0, 200),
    media: {
      max560: window.matchMedia('(max-width: 560px)').matches,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      landscape: window.matchMedia('(orientation: landscape)').matches,
      maxHeight500: window.matchMedia('(max-height: 500px)').matches,
    },
    rootParent: rootEl && rootEl.parentElement ? rootEl.parentElement.tagName.toLowerCase() : '',
    // 命中 body 的规则（排查「弹窗打开后 body 安全区 padding 消失」这类级联问题）
    bodyRules: (() => {
      const hits = []
      const visit = (rules) => {
        for (const rule of rules) {
          if (rule.type === 1) { // CSSStyleRule
            const sel = rule.selectorText || ''
            if (!sel || !/(^|[\s,])(body|html)\b/.test(sel)) continue
            try { if (!body.matches(sel)) continue } catch { continue }
            const cssText = rule.style && rule.style.cssText ? rule.style.cssText : ''
            if (/safe-area|padding|overflow/.test(cssText)) hits.push(`${sel.slice(0, 90)} { ${cssText.slice(0, 140)} }`)
            if (hits.length >= 16) return
          } else if (rule.cssRules && rule.cssRules.length > 0) {
            visit([...rule.cssRules])
            if (hits.length >= 16) return
          }
        }
      }
      try {
        for (const sheet of document.styleSheets) {
          let rules = []
          try { rules = [...sheet.cssRules] } catch { continue }
          visit(rules)
          if (hits.length >= 16) break
        }
      } catch { /* ignore */ }
      return hits
    })(),
    safeAreaRuleFound: (() => {
      let found = 0
      const visit = (rules) => {
        for (const rule of rules) {
          if (rule.type === 1) {
            const sel = rule.selectorText || ''
            const cssText = rule.style && rule.style.cssText ? rule.style.cssText : ''
            if (sel && body.matches(sel) && cssText.includes('safe-area-inset')) found++
          } else if (rule.cssRules && rule.cssRules.length > 0) visit([...rule.cssRules])
        }
      }
      try {
        for (const sheet of document.styleSheets) {
          let rules = []
          try { rules = [...sheet.cssRules] } catch { continue }
          visit(rules)
        }
      } catch { /* ignore */ }
      return found
    })(),
  }
  // 固定在底部的非导航层（输入条 / 操作条）：手势条区域的遮挡风险
  const fixedBottom = []
  for (const el of body.querySelectorAll('*')) {
    const c = cs(el)
    if (c.position !== 'fixed') continue
    const r = rectOf(el)
    if (r.width < 40 || r.height < 16 || r.height > vh * 0.6) continue
    if (r.bottom < vh - 4) continue
    if (nav && (el === nav || nav.contains(el))) continue
    const isDialogOverlay = el.getAttribute('role') === 'dialog' || el.closest('[role="dialog"]')
    fixedBottom.push({ sel: selPath(el), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, insideDialog: !!isDialogOverlay })
    if (fixedBottom.length >= 6) break
  }
  const bodyCs = cs(body)
  return {
    viewport: { vw, vh, dpr: window.devicePixelRatio || 1 },
    env,
    expected: expect,
    bodyPadding: {
      top: Math.round(Number.parseFloat(bodyCs.paddingTop) || 0),
      right: Math.round(Number.parseFloat(bodyCs.paddingRight) || 0),
      bottom: Math.round(Number.parseFloat(bodyCs.paddingBottom) || 0),
      left: Math.round(Number.parseFloat(bodyCs.paddingLeft) || 0),
      overflow: bodyCs.overflow,
    },
    heights: {
      inner: vh,
      html: Math.round(rectOf(doc).height),
      body: Math.round(rectOf(body).height),
      root: rootRect ? Math.round(rootRect.height) : 0,
      rootBottom: rootRect ? Math.round(rootRect.bottom) : 0,
      rootBottomOverflow: rootRect ? Math.round(rootRect.bottom - vh) : 0,
      docScrollHeight: doc.scrollHeight,
    },
    nav: navInfo,
    dialog: dialogInfo,
    fixedBottom,
    bands,
    supportsDvh: typeof CSS !== 'undefined' && CSS.supports && CSS.supports('height', '100dvh'),
    diag,
    visualViewport: window.visualViewport
      ? { w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height), offsetTop: Math.round(window.visualViewport.offsetTop) }
      : null,
  }
}

/**
 * 动态地址栏探针：在给定视口高度下量「布局链是否跟随 innerHeight」。
 *
 * 与 `PROBE_SAFE_AREA` 分开是因为要回答的问题不同：这里关心**高度变化前后**有没有
 * 悬空/遮挡/漂移，不关心刘海 band。
 * @returns {object} 高度链 + 视口底部的可交互元素 + 固定底栏几何。
 */
export function PROBE_DYNAMIC_VIEWPORT () {
  const vh = window.innerHeight
  const vw = window.innerWidth
  const doc = document.documentElement
  const body = document.body
  const cs = (el) => getComputedStyle(el)
  const rootEl = document.getElementById('root')
  const rootRect = rootEl ? rootEl.getBoundingClientRect() : null
  const nav = document.querySelector('nav[aria-label="主导航"]')
  const navRect = nav ? nav.getBoundingClientRect() : null
  const interactiveSel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])'
  /** 最近的 fixed/sticky 祖先（含自身）：只有固定层悬空才算「地址栏收起/展开把元素留在视口外」。 */
  const hasFixedAncestor = (el) => {
    let n = el
    let depth = 0
    while (n && n !== body && depth < 12) {
      const c = cs(n)
      if (c.position === 'fixed' || c.position === 'sticky') return true
      n = n.parentElement
      depth++
    }
    return false
  }
  /** 最近的可滚祖先：长列表/滚动面板里的元素「在视口外」是正常的，可滚即可达。 */
  const inScrollable = (el) => {
    let n = el.parentElement
    let depth = 0
    while (n && n !== body && depth < 12) {
      const c = cs(n)
      if (/(auto|scroll|overlay)/.test(c.overflowX) || /(auto|scroll|overlay)/.test(c.overflowY)) return true
      n = n.parentElement
      depth++
    }
    return false
  }
  const nearBottom = []
  for (const el of body.querySelectorAll(interactiveSel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    const c = cs(el)
    if (c.display === 'none' || c.visibility === 'hidden') continue
    // 面板常规内容在长列表里天然会落在视口外（可滚动），不是「悬空」；只查固定/粘性层。
    if (!hasFixedAncestor(el)) continue
    // 弹窗/表格的固定头部常在滚动容器内：可滚就可达，不算地址栏把按钮挤出去。
    if (inScrollable(el)) continue
    if (r.bottom > vh + 1) nearBottom.push({ sel: (el.getAttribute('class') || el.tagName).slice(0, 48), text: (el.textContent || '').trim().slice(0, 20), bottom: Math.round(r.bottom), height: Math.round(r.height) })
    if (nearBottom.length >= 8) break
  }
  return {
    viewport: { vw, vh, dpr: window.devicePixelRatio || 1 },
    heights: {
      inner: vh,
      html: Math.round(doc.getBoundingClientRect().height),
      body: Math.round(body.getBoundingClientRect().height),
      root: rootRect ? Math.round(rootRect.height) : 0,
      rootBottomOverflow: rootRect ? Math.round(rootRect.bottom - vh) : 0,
      docScrollHeight: doc.scrollHeight,
      bodyScrollHeight: body.scrollHeight,
    },
    nav: navRect
      ? { y: Math.round(navRect.y), bottomGap: Math.round(vh - navRect.bottom), h: Math.round(navRect.height), position: cs(nav).position, paddingBottom: Math.round(Number.parseFloat(cs(nav).paddingBottom) || 0) }
      : null,
    nearBottom,
    visualViewport: window.visualViewport ? { h: Math.round(window.visualViewport.height), offsetTop: Math.round(window.visualViewport.offsetTop) } : null,
    scroll: { y: Math.round(window.scrollY), bodyOverflow: cs(body).overflow, overscroll: cs(doc).overscrollBehaviorY },
  }
}

/**
 * 静态扫 `vh` 单位声明（地址栏抖动风险清单：真机 `vh`=大视口，`dvh`=动态视口）。
 *
 * 只扫可读的 same-origin 样式表（内联/本地 CSS 都同源）；把 `dvh/svh/lvh` 排除。
 * @returns {{rules:Array<{selector:string, prop:string, value:string}>, count:number}}
 */
export function SCAN_VH_UNITS () {
  const out = []
  const vhRe = /(?:^|[^\w-])(\d+(?:\.\d+)?)vh\b/
  for (const sheet of document.styleSheets) {
    let rules = []
    try { rules = [...sheet.cssRules] } catch { continue }
    for (const rule of rules) {
      if (!rule.style) continue
      for (const prop of ['height', 'min-height', 'max-height', 'padding-top', 'padding-bottom', 'top', 'bottom']) {
        const v = rule.style.getPropertyValue(prop)
        if (!v || !vhRe.test(v)) continue
        out.push({ selector: (rule.selectorText || '').slice(0, 120), prop, value: v.slice(0, 40) })
        if (out.length >= 40) return { rules: out, count: out.length, truncated: true }
      }
    }
  }
  return { rules: out, count: out.length, truncated: false }
}

// ══════════════════════════════════════════════════════════════════════════
// 判定与汇总（Node 侧）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 判定一个「安全区格子」的结论。
 * @param {object} probe - `PROBE_SAFE_AREA` 观测。
 * @param {object} profile - 档位（含 insets）。
 * @param {object} audit - `AUDIT_PAGE` 五类规则结果（可选）。
 * @param {{emulationAvailable:boolean}} flags
 * @returns {{violations:Array<{kind:string,detail:string,items:Array}>, accepted:Array<{kind:string,detail:string}>}}
 */
export function judgeSafeAreaCell (probe, profile, audit, flags) {
  const violations = []
  const accepted = []
  const insets = profile.insets
  const emu = flags.emulationAvailable
  if (!emu) {
    return { violations: [{ kind: 'emulation-unavailable', detail: '本机 Chrome 不支持安全区覆盖，env() 无法注入；只做几何检查', items: [] }], accepted }
  }
  const envOk = probe.env.top === insets.top && probe.env.right === insets.right
    && probe.env.bottom === insets.bottom && probe.env.left === insets.left
  if (!envOk) violations.push({ kind: 'env-not-applied', detail: `env 实测 ${JSON.stringify(probe.env)} ≠ 注入 ${JSON.stringify(insets)}`, items: [] })

  const dialog = probe.dialog
  const inDialog = (item) => !!item.inDialog
  const outDialog = (item) => !item.inDialog

  // ① 弹窗打开时：安全区要由**弹窗自己**吃掉（背景是 inert 遮罩，body padding 与背景
  //    band 都不可达，不参与判定）。检查弹窗四条边是否越过对应安全区，以及弹窗内的
  //    可交互元素是否落进 band（真实事故：横屏刘海盖住右上角关闭按钮）。
  if (dialog) {
    const r = dialog.rect
    if (insets.top > 0 && r.y < insets.top - 2) {
      violations.push({ kind: 'dialog-under-notch', detail: `弹窗顶部 y=${r.y} 越过安全区 top=${insets.top}`, items: dialog.buttons.slice(0, 4) })
    }
    // 底部只查「弹窗内容」是否落进手势条 band：手机档的设置弹窗是**贴底 sheet**（顶部留白、
    // 底边贴视口底），它自己有 `padding-bottom: calc(8px + env(safe-area-inset-bottom))`
    // 把内容抬起来 —— 卡面背景压住手势条是设计，不算缺陷（判据与真机一致）。
    if (insets.left > 0 && r.x < insets.left - 2) {
      violations.push({ kind: 'dialog-under-left-notch', detail: `弹窗左缘 x=${r.x} 越过安全区 left=${insets.left}`, items: [] })
    }
    if (insets.right > 0 && r.x + r.w > probe.viewport.vw - insets.right + 2) {
      violations.push({ kind: 'dialog-under-right-notch', detail: `弹窗右缘 x=${r.x + r.w} 越过安全区 right=${insets.right}`, items: [] })
    }
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const items = (probe.bands[side] || []).filter(inDialog)
      if (items.length > 0) {
        violations.push({ kind: `dialog-content-in-${side}-band`, detail: `弹窗内有 ${items.length} 个元素落进 ${side} 安全区`, items: items.slice(0, 4) })
      }
    }
    accepted.push({ kind: 'dialog-scoped', detail: `弹窗打开：背景 shell 不参与安全区判定（inert/遮罩），body padding 曲线不适用` })
  } else {
    // ② 普通页面：`body` 的 padding 应吃掉 top/left/right（`mobile-viewport.css` 负责），
    //    否则整块 shell 会顶进刘海 —— 这时再报 band 内容（去重：有 padding 缺失就只报根因）。
    let bodyMissing = false
    for (const side of [['top', 'top'], ['left', 'left'], ['right', 'right']]) {
      const [padKey, insetKey] = side
      if (insets[insetKey] <= 0) continue
      if (probe.bodyPadding[padKey] < insets[insetKey] - 1) {
        bodyMissing = true
        violations.push({ kind: `body-${padKey}-padding-missing`, detail: `body padding-${padKey}=${probe.bodyPadding[padKey]} < 安全区 ${insetKey}=${insets[insetKey]}`, items: [] })
      }
    }
    for (const side of ['top', 'left', 'right']) {
      if (insets[side] <= 0 || bodyMissing) continue
      const items = (probe.bands[side] || []).filter(outDialog)
      if (items.length > 0) {
        violations.push({ kind: `content-in-${side}-band`, detail: `${insets[side]}px ${side} 安全区内有 ${items.length} 个文本/可交互元素`, items: items.slice(0, 4) })
      }
    }
  }

  // ③ 底部：底部标签栏自带 `padding-bottom: env(safe-area-inset-bottom)`（面板级，Wave 3 前已就位）；
  //    若它没有消费 env，或 band 里有固定层/弹窗内的可交互元素，就是真问题。
  if (insets.bottom > 0) {
    if (probe.nav && probe.nav.position === 'fixed' && probe.nav.paddingBottom < insets.bottom - 1) {
      violations.push({ kind: 'bottombar-safe-padding-missing', detail: `底部栏 padding-bottom=${probe.nav.paddingBottom} < ${insets.bottom}`, items: [] })
    } else if (probe.nav && probe.nav.position === 'fixed' && probe.nav.paddingBottom >= insets.bottom - 1) {
      accepted.push({ kind: 'bottombar-safe-padding', detail: `底部栏 padding-bottom=${probe.nav.paddingBottom} 已吃掉手势条 ${insets.bottom}px` })
    }
    const bottomItems = (probe.bands.bottom || []).filter((item) => item.fixedLayer || item.inDialog)
    if (bottomItems.length > 0) {
      violations.push({ kind: 'fixed-content-in-bottom-band', detail: `底部 ${insets.bottom}px 安全区内有 ${bottomItems.length} 个固定层/弹窗元素`, items: bottomItems.slice(0, 4) })
    }
  }
  // ④ 高度链：`body` 有 padding 时 #root 若仍取 100dvh 会整体下移、底部溢出（Wave 4 重点怀疑项）
  if (probe.heights.rootBottomOverflow > 2) {
    violations.push({ kind: 'root-bottom-overflow', detail: `#root 底部超出视口 ${probe.heights.rootBottomOverflow}px（高度链没扣掉安全区 padding）`, items: [] })
  }
  // ⑤ 五类规则回归（加安全区后不应新增溢出/裁切）
  if (audit && Array.isArray(audit.issues)) {
    for (const issue of audit.issues) {
      if (issue.rule === 'hidden') continue
      violations.push({ kind: `audit-${issue.rule}`, detail: `${issue.rule}:${issue.sub} ${issue.cls || issue.tag} ${issue.amount ?? ''}`.trim(), items: [] })
    }
  }
  return { violations, accepted }
}

/**
 * 汇总安全区矩阵。
 * @param {Array<object>} cells
 * @returns {object}
 */
export function summarizeSafeArea (cells) {
  const ok = cells.filter((c) => !c.error)
  const byKind = {}
  const byProfile = {}
  let envApplied = 0
  for (const c of ok) {
    if (!c.profile) continue
    byProfile[c.profile] = byProfile[c.profile] || { cells: 0, violations: 0, kinds: {} }
    byProfile[c.profile].cells++
    byProfile[c.profile].violations += c.verdict.violations.length
    for (const v of c.verdict.violations) {
      byKind[v.kind] = (byKind[v.kind] || 0) + 1
      byProfile[c.profile].kinds[v.kind] = (byProfile[c.profile].kinds[v.kind] || 0) + 1
    }
    if (c.envOk) envApplied++
  }
  return {
    cells: ok.length,
    envApplied,
    envAppliedPct: ok.length ? Math.round((envApplied / ok.length) * 100) : 0,
    violationCells: ok.filter((c) => c.verdict.violations.length > 0).length,
    totalViolations: ok.reduce((s, c) => s + c.verdict.violations.length, 0),
    byKind,
    byProfile,
  }
}

/**
 * 控制台打印安全区矩阵。
 * @param {{cells:Array<object>,summary:object,profiles:Array<object>,tabs:Array<string>,durationMs:number}} args
 */
export function printSafeAreaSummary (args) {
  const { summary, profiles, tabs, durationMs } = args
  console.log('─'.repeat(78))
  console.log(`安全区/刘海仿真完成：${summary.cells} 格（${tabs.length} tab × ${profiles.length} 档），用时 ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`  env(safe-area-inset-*) 注入生效：${summary.envApplied}/${summary.cells} 格（${summary.envAppliedPct}%）`)
  console.log(`  有问题的格子：${summary.violationCells}；问题条数：${summary.totalViolations}`)
  const kinds = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) console.log('  按类型：无')
  else for (const [kind, n] of kinds) console.log(`  · ${kind.padEnd(32)} ${n}`)
  for (const p of profiles) {
    const s = summary.byProfile[p.label]
    if (!s) continue
    console.log(`  ${p.label.padEnd(20)} 格数 ${s.cells}  问题 ${s.violations}`)
  }
}

/**
 * 汇总动态地址栏矩阵。
 * @param {Array<object>} cells
 * @returns {object}
 */
export function summarizeDynamic (cells, vhUnits = null) {
  const ok = cells.filter((c) => !c.error)
  const problems = []
  for (const c of ok) {
    if (c.findings.length > 0) problems.push({ tab: c.tab, findings: c.findings })
  }
  const byKind = {}
  for (const c of ok) for (const f of c.findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1
  return {
    cells: ok.length,
    problemCells: problems.length,
    totalFindings: ok.reduce((s, c) => s + c.findings.length, 0),
    byKind,
    stableHeightCells: ok.filter((c) => c.heightChainStable).length,
    vhUnitRisk: vhUnits,
  }
}

/**
 * 控制台打印动态地址栏矩阵。
 * @param {{summary:object,tabs:Array<string>,sizes:object,durationMs:number}} args
 */
export function printDynamicSummary (args) {
  const { summary, tabs, sizes, durationMs } = args
  console.log('─'.repeat(78))
  console.log(`动态地址栏仿真完成：${summary.cells} 格（${tabs.length} tab × 收/展 + 复位），用时 ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`  收/展切换高度：${sizes.barVisible.h} ↔ ${sizes.barHidden.h}（${sizes.barVisible.w}×…）`)
  console.log(`  高度链在两种高度都跟随 innerHeight：${summary.stableHeightCells}/${summary.cells} 格`)
  console.log(`  有问题格子：${summary.problemCells}；问题条数：${summary.totalFindings}`)
  const kinds = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) console.log('  按类型：无')
  else for (const [kind, n] of kinds) console.log(`  · ${kind.padEnd(32)} ${n}`)
  if (summary.vhUnitRisk) {
    console.log(`  静态 vh 单位风险声明：${summary.vhUnitRisk.count} 条（dvh 缺失处见 JSON；面板/kit 归 Wave 2/4）`)
    for (const r of summary.vhUnitRisk.rules.slice(0, 6)) console.log(`    - ${r.selector} { ${r.prop}: ${r.value} }`)
  }
}

/**
 * 判定一个动态地址栏格子（收/展/复位三次观测）。
 * @param {{barVisible:object,barHidden:object,restored:object}} m
 * @param {{barVisible:object,barHidden:object}} sizes
 * @returns {{findings:Array<{kind:string,detail:string}>, heightChainStable:boolean}}
 */
export function judgeDynamicCell (m, sizes) {
  const findings = []
  const check = (probe, label) => {
    if (!probe) { findings.push({ kind: 'probe-missing', detail: `${label} 未取到观测` }); return }
    if (Math.abs(probe.heights.root - probe.viewport.vh) > 2) {
      findings.push({ kind: 'dvh-not-tracking', detail: `${label}: #root 高 ${probe.heights.root} ≠ innerHeight ${probe.viewport.vh}` })
    }
    if (probe.heights.rootBottomOverflow > 2) findings.push({ kind: 'root-overflow', detail: `${label}: #root 底部超出视口 ${probe.heights.rootBottomOverflow}px` })
    if (probe.nav && probe.nav.position === 'fixed' && Math.abs(probe.nav.bottomGap) > 2) {
      findings.push({ kind: 'bottombar-gap', detail: `${label}: 底部栏离视口底 ${probe.nav.bottomGap}px（应贴底）` })
    }
    for (const el of probe.nearBottom) findings.push({ kind: 'interactive-below-viewport', detail: `${label}: ${el.sel} 底边 ${el.bottom} > ${probe.viewport.vh}` })
    if (probe.visualViewport && Math.abs(probe.visualViewport.h - probe.heights.inner) > 2) {
      findings.push({ kind: 'visual-vs-layout-mismatch', detail: `${label}: visualViewport.h=${probe.visualViewport.h} vs innerHeight=${probe.heights.inner}` })
    }
  }
  check(m.barVisible, sizes.barVisible.label)
  check(m.barHidden, sizes.barHidden.label)
  check(m.restored, '复位' )
  // 收/展只是高度变化：复位后布局必须与初始等价（高度链/底栏贴底）
  if (m.barVisible && m.restored) {
    const dRoot = Math.abs(m.barVisible.heights.root - m.restored.heights.root)
    if (dRoot > 2) findings.push({ kind: 'resize-drift', detail: `复位后 #root 高 ${m.restored.heights.root} 与初始 ${m.barVisible.heights.root} 相差 ${dRoot}px` })
    if (Math.abs(m.barVisible.nav?.bottomGap ?? 0) !== Math.abs(m.restored.nav?.bottomGap ?? 0)) {
      findings.push({ kind: 'resize-drift-nav', detail: '复位后底部栏位置与初始不一致' })
    }
  }
  const heightChainStable = [m.barVisible, m.barHidden, m.restored].every((p) => p && Math.abs(p.heights.root - p.viewport.vh) <= 2)
  return { findings, heightChainStable }
}

// ══════════════════════════════════════════════════════════════════════════
// 矩阵流程（由入口传入 page/goto/settle/setViewport 等回调，避免复制启动逻辑）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 跑安全区（刘海/挖孔）矩阵：每个 profile × 每个 tab 注入 insets → 探针 → 五类规则回归。
 * @param {object} ctx - `{ page, cdp, tabs, profiles, goto, settle, setViewport, runAudit, screenshot, emulationAvailable, detectNotes }`
 * @returns {Promise<{cells:Array<object>, profiles:Array<object>, tabs:Array<string>}>}
 */
export async function collectSafeAreaCells (ctx) {
  const { page, cdp, tabs, profiles, goto, settle, setViewport, runAudit, screenshot, emulationAvailable } = ctx
  const cells = []
  for (const profile of profiles) {
    const size = { label: profile.label, w: profile.w, h: profile.h }
    for (const tab of tabs) {
      const cell = { tab: tab.tab, label: tab.label, profile: profile.label, device: profile.device, insets: profile.insets, error: '' }
      try {
        await setViewport(page, size)
        if (emulationAvailable) await applySafeArea(cdp, profile.insets)
        await goto(page, tab.tab)
        await settle(page)
        // 注入在 reload 之后仍生效；再写一次防御（个别 Chrome 会在导航后重置 Emulation 状态）
        if (emulationAvailable) await applySafeArea(cdp, profile.insets)
        const probe = await page.evaluate(PROBE_SAFE_AREA, { insets: profile.insets })
        const audit = await runAudit(page)
        const flags = { emulationAvailable }
        const verdict = judgeSafeAreaCell(probe, profile, audit, flags)
        cell.envOk = probe.env.top === profile.insets.top && probe.env.bottom === profile.insets.bottom
          && probe.env.left === profile.insets.left && probe.env.right === profile.insets.right
        cell.probe = probe
        cell.audit = { issues: audit.issues, total: audit.issues.length }
        cell.verdict = verdict
        if (verdict.violations.length > 0 && screenshot) cell.screenshot = await screenshot(page, `safe-${tab.tab}-${profile.label}`)
      } catch (e) {
        cell.error = (e?.message ?? String(e)).split('\n')[0].slice(0, 220)
      }
      cells.push(cell)
    }
  }
  return { cells, profiles, tabs: tabs.map((t) => t.tab) }
}

/**
 * 跑动态地址栏矩阵：每 tab 在「地址栏可见高度 → 收起高度 → 复位」三次观测。
 * @param {object} ctx - `{ page, tabs, sizes, goto, settle, setViewport, scanVh }`
 * @returns {Promise<{cells:Array<object>, sizes:object, tabs:Array<string>}>}
 */
export async function collectDynamicCells (ctx) {
  const { page, tabs, sizes, goto, settle, setViewport, scanVh } = ctx
  const cells = []
  let vhUnits = null
  for (const tab of tabs) {
    const cell = { tab: tab.tab, label: tab.label, sizes: { visible: sizes.barVisible.label, hidden: sizes.barHidden.label }, error: '' }
    try {
      await setViewport(page, sizes.barVisible)
      await goto(page, tab.tab)
      await settle(page)
      const barVisible = await page.evaluate(PROBE_DYNAMIC_VIEWPORT)
      if (!vhUnits) vhUnits = await page.evaluate(SCAN_VH_UNITS)
      await setViewport(page, sizes.barHidden)
      await sleepQuick(450)
      const barHidden = await page.evaluate(PROBE_DYNAMIC_VIEWPORT)
      await setViewport(page, sizes.barVisible)
      await sleepQuick(450)
      const restored = await page.evaluate(PROBE_DYNAMIC_VIEWPORT)
      const judged = judgeDynamicCell({ barVisible, barHidden, restored }, sizes)
      cell.measurements = { barVisible, barHidden, restored }
      cell.findings = judged.findings
      cell.heightChainStable = judged.heightChainStable
    } catch (e) {
      cell.error = (e?.message ?? String(e)).split('\n')[0].slice(0, 220)
      cell.findings = []
      cell.heightChainStable = false
    }
    cells.push(cell)
  }
  return { cells, sizes, tabs: tabs.map((t) => t.tab), vhUnits }
}

/** 本地 sleep（避免把入口的 sleep 传进来只为一处等待）。 */
function sleepQuick (ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
