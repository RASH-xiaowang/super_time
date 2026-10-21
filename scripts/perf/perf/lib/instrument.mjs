/**
 * 探针注入口：主进程（IPC 计数 / 进程内存）与渲染进程（面板切换 / 滚动 / 图片可见性）。
 *
 * 约定：这里导出的 `fn` 会被原样序列化进 `app.evaluate(fn)` / `win.evaluate(fn)`，
 * **不能引用模块作用域的任何变量**（Playwright 只序列化函数体）。因此每个函数都自含，
 * 外部输入一律走参数。
 *
 * 产品代码只读：这里全部是运行时包装（wrapper），不改仓库任何文件与业务语义。
 */

/**
 * 在主进程包装 `ipcMain` 的既有 handler，做按通道计数与 `wechat:call` 时延统计。
 *
 * 为什么包内部 Map 而不是重注册：所有 handler 已在 app ready 时注册完；重注册会覆盖业务
 * handler（灾难性）。`_invokeHandlers` 是按通道取函数的 Map，替换 value 即可旁路计数。
 *
 * @param {{ ipcMain: Electron.IpcMain }} electron - Playwright 传进来的 electron 模块。
 * @returns {{ wrappedInvoke: number, wrappedEvents: number, unsupported: string[] }}
 */
export function installMainIpcProbe ({ ipcMain }) {
  if (globalThis.__stPerfIpc && globalThis.__stPerfIpc.installed) return globalThis.__stPerfIpc.meta
  const state = {
    installed: true,
    total: 0,
    byChannel: {},
    eventChannels: {},
    wechatCall: { count: 0, byMethod: {}, durations: [], slowCount: 0, slowOverMs: 500 },
    startedAt: Date.now(),
    meta: { wrappedInvoke: 0, wrappedEvents: 0, unsupported: [] },
  }
  globalThis.__stPerfIpc = state

  /** 记录一次调用（不抛错：观测设施不能影响业务）。 */
  const record = (channel, ms, method) => {
    try {
      state.total += 1
      state.byChannel[channel] = (state.byChannel[channel] || 0) + 1
      if (channel === 'wechat:call' && typeof method === 'string') {
        const wc = state.wechatCall
        wc.count += 1
        wc.byMethod[method] = (wc.byMethod[method] || 0) + 1
        wc.durations.push(Math.round(ms * 10) / 10)
        if (wc.durations.length > 2000) wc.durations.splice(0, wc.durations.length - 2000)
        if (ms >= wc.slowOverMs) wc.slowCount += 1
      }
    } catch { /* ignore */ }
  }

  if (ipcMain._invokeHandlers && typeof ipcMain._invokeHandlers.forEach === 'function') {
    for (const [channel, original] of [...ipcMain._invokeHandlers.entries()]) {
      if (typeof original !== 'function') continue
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        const t0 = Date.now()
        let method
        if (channel === 'wechat:call') method = typeof args[1] === 'string' ? args[1] : undefined
        try {
          return await original(...args)
        } finally {
          record(channel, Date.now() - t0, method)
        }
      })
      state.meta.wrappedInvoke += 1
    }
  } else {
    state.meta.unsupported.push('ipcMain._invokeHandlers')
  }

  // `ipcMain.on`（renderer → main 的单向消息，如窗口控制）：EventEmitter 数组替换。
  if (ipcMain._events && typeof ipcMain._events === 'object') {
    for (const channel of Object.keys(ipcMain._events)) {
      if (channel === 'newListener' || channel === 'removeListener' || channel === 'error') continue
      const listeners = ipcMain._events[channel]
      if (!Array.isArray(listeners) || listeners.length === 0) continue
      ipcMain._events[channel] = listeners.map((original) => {
        if (typeof original !== 'function') return original
        return function wrapped (...args) {
          record(channel, 0, undefined)
          return original.apply(this, args)
        }
      })
      state.meta.wrappedEvents += 1
    }
  } else {
    state.meta.unsupported.push('ipcMain._events')
  }
  return state.meta
}

/**
 * 读取主进程侧探针汇总。
 *
 * 返回 `byChannel` 为**累计值**，调用方用前后两次快照做差得到每一轮的增量。
 * @returns {object}
 */
export function readMainIpcProbe () {
  const s = globalThis.__stPerfIpc
  if (!s || !s.installed) return { installed: false }
  const durations = s.wechatCall.durations.slice().sort((a, b) => a - b)
  const pick = (q) => (durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * q) - 1))])
  const fast = durations.filter((d) => d < 10).length
  const byMethod = { ...s.wechatCall.byMethod }
  const top = Object.entries(byMethod).sort((a, b) => b[1] - a[1]).slice(0, 12)
  return {
    installed: true,
    total: s.total,
    byChannel: { ...s.byChannel },
    eventChannels: { ...s.eventChannels },
    wechatCall: {
      count: s.wechatCall.count,
      byMethod,
      topMethods: top,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      maxMs: durations.length === 0 ? 0 : durations[durations.length - 1],
      fastRatio: durations.length === 0 ? 0 : Math.round((fast / durations.length) * 1000) / 1000,
      slowCount: s.wechatCall.slowCount,
      slowOverMs: s.wechatCall.slowOverMs,
      retainedSamples: durations.length,
    },
    uptimeMs: Date.now() - s.startedAt,
  }
}

/**
 * 读主进程自身的 Node 内存 + Electron 的 per-process 指标（app.getAppMetrics）。
 *
 * `app.getAppMetrics().memory` 在 Windows 上单位是 KB（Electron 文档口径），
 * 这里同时给出原始值（让读者自己核对）与换算后的字节。
 * @param {{ app: Electron.App }} electron
 */
export function readMainProcessMetrics ({ app }) {
  const m = process.memoryUsage()
  const metrics = app.getAppMetrics().map((x) => {
    const mem = x.memory || {}
    return {
      pid: x.pid,
      type: x.type,
      creationTime: x.creationTime,
      cpuCumulativeSeconds: x.cpu ? x.cpu.cumulativeCPUUsage : null,
      cpuPercent: x.cpu ? x.cpu.percentCPUUsage : null,
      idleWakeupsPerSecond: x.cpu ? x.cpu.idleWakeupsPerSecond : null,
      // Electron: Windows 下 workingSetSize / peakWorkingSetSize 单位 KB
      workingSetBytes: typeof mem.workingSetSize === 'number' ? mem.workingSetSize * 1024 : null,
      peakWorkingSetBytes: typeof mem.peakWorkingSetSize === 'number' ? mem.peakWorkingSetSize * 1024 : null,
      privateBytes: typeof mem.privateBytes === 'number' ? mem.privateBytes * 1024 : null,
      rawMemory: mem,
    }
  })
  return {
    mainPid: process.pid,
    uptimeSec: Math.round(process.uptime() * 100) / 100,
    nodeMem: {
      rssBytes: m.rss,
      heapTotalBytes: m.heapTotal,
      heapUsedBytes: m.heapUsed,
      externalBytes: m.external,
      arrayBuffersBytes: m.arrayBuffers,
    },
    appMetrics: metrics,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  }
}

/* ─────────────────────────── 渲染进程侧 ─────────────────────────── */

/**
 * 文档启动前注入的图片生命周期追踪器（`win.addInitScript` 用）。
 *
 * 记录每张 `<img>` 的「元素首见（挂载/赋值 src）→ load（decode 完成）」时间。
 * 面板里的图目前基本都是 `data:` URL（实测 229/229、33/33），不存在网络请求阶段，
 * 所以「请求发起」在 data URL 下无对应物 —— 这里测的是挂载→decode 的端到端。
 * 非 data URL（file: / wechat-media: / http:）同样记录；网络阶段另由 CDP Network 采。
 */
export function installImageTrackerInit () {
  if (window.__stPerfImg) return
  const st = {
    seq: 0,
    records: [],
    startedAt: performance.now(),
    byEl: new WeakMap(),
    maxRecords: 6000,
  }
  window.__stPerfImg = st
  const schemeOf = (src) => {
    try { return new URL(src).protocol } catch { return '?' }
  }
  const mark = (im) => {
    if (!(im instanceof HTMLImageElement)) return
    if (st.byEl.has(im)) return
    const src = im.currentSrc || im.src || ''
    if (src === '') return
    const rec = { id: ++st.seq, firstSeen: performance.now(), loadedAt: null, scheme: schemeOf(src), srcLen: src.length }
    st.byEl.set(im, rec)
    st.records.push(rec)
    if (st.records.length > st.maxRecords) st.records.splice(0, st.records.length - st.maxRecords)
    if (im.complete && im.naturalWidth > 0) { rec.loadedAt = rec.firstSeen; return }
    im.addEventListener('load', () => { if (rec.loadedAt === null) rec.loadedAt = performance.now() }, { once: true })
  }
  const scan = (root) => {
    if (root instanceof HTMLImageElement) { mark(root); return }
    if (!root || typeof root.querySelectorAll !== 'function') return
    for (const im of root.querySelectorAll('img')) mark(im)
  }
  // 关键：addInitScript 在 documentElement 还不存在时执行；直接 observe(null) 会抛错，
  // 之后就只有 load 事件里那一次 scan —— 而 React 往往在 load 之后才插 <img>，于是追踪器
  // 会"装了但一条都没记"。实测：evaluate 里装（DOM 已就绪）能记 17/33 张，initScript 里装记 0。
  const startObserver = () => {
    const root = document.documentElement
    if (!root) { setTimeout(startObserver, 0); return }
    try {
      const mo = new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) if (n && n.nodeType === 1) scan(n)
      })
      mo.observe(root, { childList: true, subtree: true })
      st.observer = mo
    } catch { /* 观测设施失败不应影响页面 */ }
    scan(document)
  }
  startObserver()
  window.addEventListener('load', () => scan(document), true)
  scan(document)
}

/**
 * 采集一张渲染层快照（页面状态 + 视觉/时序 + 图片生命周期统计）。
 *
 * @param {{ fullImageScan?: boolean }} [opts]
 */
export function collectPageSnapshot (opts) {
  const fullImageScan = !opts || opts.fullImageScan !== false
  const panelBody = document.querySelector('main [class*=panelBody]') || document.querySelector('main')
  const nav = document.querySelector('aside nav') || document.querySelector('nav')
  const activeBtn = nav ? [...nav.querySelectorAll('button')].find((b) => b.getAttribute('data-active') !== null) : null
  const navBtns = nav ? [...nav.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean) : []

  /**
   * 找可滚动容器：**先看后代**（列表/朋友圈/收藏的滚动容器都是面板内部的 `_list_/_scroll_/_grid_`），
   * 再向上找（总览这类是面板正文自己滚）。只对"确实有溢出"的元素算 computedStyle，避免全量开销。
   */
  const findScroller = (root) => {
    if (!root) return null
    let best = null
    let bestDelta = 40
    let scanned = 0
    for (const el of [root, ...root.querySelectorAll('*')]) {
      scanned += 1
      if (scanned > 12000) break
      const delta = el.scrollHeight - el.clientHeight
      if (delta <= bestDelta) continue
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') { best = el; bestDelta = delta }
    }
    if (best) return best
    let el = root
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) return el
      el = el.parentElement
    }
    return null
  }
  const scroller = findScroller(panelBody)
  const scrollable = Boolean(scroller && scroller !== document.body && scroller.scrollHeight > scroller.clientHeight + 40)

  const navTiming = performance.getEntriesByType('navigation')[0]
  const paints = performance.getEntriesByType('paint')
  let lcp = null
  try {
    const lcps = performance.getEntriesByType('largest-contentful-paint')
    if (lcps.length > 0) lcp = Math.round(lcps[lcps.length - 1].startTime)
  } catch { /* 老内核没有 */ }

  const imgs = [...document.images]
  let loaded = 0; let broken = 0; let visibleNow = 0
  const schemeByImg = {}
  for (const im of imgs) {
    const src = im.currentSrc || im.src || ''
    let scheme = '?'
    try { scheme = new URL(src).protocol } catch { scheme = '?' }
    schemeByImg[scheme] = (schemeByImg[scheme] || 0) + 1
    if (im.complete && im.naturalWidth > 0) loaded += 1
    else if (im.complete && im.naturalWidth === 0) broken += 1
    const r = im.getBoundingClientRect()
    if (r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) visibleNow += 1
  }

  const tracker = window.__stPerfImg
  let tracked = null
  if (tracker) {
    const recs = tracker.records
    const e2e = []
    let trackedLoaded = 0
    let dataUrls = 0
    for (const r of recs) {
      if (r.scheme === 'data:') dataUrls += 1
      if (r.loadedAt !== null) { trackedLoaded += 1; e2e.push(Math.round(r.loadedAt - r.firstSeen)) }
    }
    e2e.sort((a, b) => a - b)
    const pick = (q) => (e2e.length === 0 ? 0 : e2e[Math.min(e2e.length - 1, Math.max(0, Math.ceil(e2e.length * q) - 1))])
    tracked = {
      records: recs.length,
      loaded: trackedLoaded,
      dataUrlShare: recs.length === 0 ? 0 : Math.round((dataUrls / recs.length) * 1000) / 1000,
      e2eP50Ms: pick(0.5),
      e2eP95Ms: pick(0.95),
      e2eMaxMs: e2e.length === 0 ? 0 : e2e[e2e.length - 1],
      pendingLoads: recs.length - trackedLoaded,
    }
  }

  // Resource Timing 在本仓库渲染层恒为 0 条（见 docs/perf/02-BASELINE.md 的实测与原因）；
  // 仍然采回来，是为了让"换环境后是否恢复"这件事有可对照的读数。
  let resourceEntries = 0
  try { resourceEntries = performance.getEntriesByType('resource').length } catch { resourceEntries = -1 }

  const mem = performance.memory
    ? { usedJSHeapBytes: performance.memory.usedJSHeapSize, totalJSHeapBytes: performance.memory.totalJSHeapSize, jsHeapLimitBytes: performance.memory.jsHeapSizeLimit }
    : null

  return {
    at: Date.now(),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    nav: {
      count: navBtns.length,
      active: activeBtn ? (activeBtn.getAttribute('title') || activeBtn.textContent || '').trim() : null,
      labels: fullImageScan ? navBtns : undefined,
    },
    panel: {
      textLen: panelBody ? panelBody.innerText.length : 0,
      scrollTop: scrollable ? Math.round(scroller.scrollTop) : 0,
      scrollHeight: scrollable ? scroller.scrollHeight : 0,
      clientHeight: scrollable ? scroller.clientHeight : 0,
      scrollable,
      hasSkeleton: panelBody ? panelBody.querySelectorAll('[class*=skel], [class*=Skel], [class*=skeleton]').length : 0,
    },
    images: { total: imgs.length, loaded, broken, visibleNow, schemeByImg, tracker: tracked },
    timing: {
      navigation: navTiming
        ? {
            type: navTiming.type,
            responseEndMs: Math.round(navTiming.responseEnd),
            domContentLoadedMs: Math.round(navTiming.domContentLoadedEventEnd),
            loadEventMs: Math.round(navTiming.loadEventEnd),
            durationMs: Math.round(navTiming.duration),
          }
        : null,
      paints: paints.map((p) => ({ name: p.name, startTimeMs: Math.round(p.startTime) })),
      lcpMs: lcp,
      nowMs: Math.round(performance.now()),
      timeOrigin: Math.round(performance.timeOrigin),
    },
    rendererMemory: mem,
    resourceTiming: {
      entries: resourceEntries,
      note: resourceEntries === 0 ? 'performance.getEntriesByType("resource") 恒为空（sandbox+file:// 渲染层，实测；见报告）' : undefined,
    },
  }
}

/**
 * 采集「某阶段内新出现的图片」的端到端统计（元素首见 → decode 完成）。
 * @param {{ sincePerf: number }} args - sincePerf 是阶段开始时页面里的 performance.now()。
 */
export function collectImagePhase ({ sincePerf }) {
  const tracker = window.__stPerfImg
  if (!tracker) return { available: false }
  const recs = tracker.records.filter((r) => r.firstSeen >= sincePerf)
  const e2e = []
  const schemes = {}
  let loaded = 0
  for (const r of recs) {
    schemes[r.scheme] = (schemes[r.scheme] || 0) + 1
    if (r.loadedAt !== null) { loaded += 1; e2e.push(Math.round(r.loadedAt - r.firstSeen)) }
  }
  e2e.sort((a, b) => a - b)
  const pick = (q) => (e2e.length === 0 ? 0 : e2e[Math.min(e2e.length - 1, Math.max(0, Math.ceil(e2e.length * q) - 1))])
  return {
    available: true,
    newImages: recs.length,
    loaded,
    pending: recs.length - loaded,
    schemes,
    e2eP50Ms: pick(0.5),
    e2eP95Ms: pick(0.95),
    e2eMaxMs: e2e.length === 0 ? 0 : e2e[e2e.length - 1],
  }
}

/**
 * 在页面内点导航按钮并等到面板「落定」，返回呈现耗时。
 *
 * 落定判据（与 `scripts/panel-audit.mjs` 同源思想，但用 rAF 采样）：
 *   ① 正文文字长度连续 N 帧不变；② 不含加载措辞（且正文还短）；③ 没有骨架元素；
 *   ④ 至少 minMs 毫秒（避免把"上一步的内容"当成新面板）。
 *
 * @param {{ label: string, minMs?: number, maxMs?: number, stableFrames?: number }} args
 */
export function switchPanelAndMeasure (args) {
  const label = args.label
  const minMs = args.minMs ?? 150
  const maxMs = args.maxMs ?? 30000
  const stableFrames = args.stableFrames ?? 8
  return new Promise((resolve) => {
    const nav = document.querySelector('aside nav') || document.querySelector('nav')
    if (!nav) { resolve({ ok: false, error: 'nav not found' }); return }
    const btn = [...nav.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || b.textContent || '').trim()) === label)
    if (!btn) { resolve({ ok: false, error: 'panel button not found: ' + label }); return }
    const body = () => document.querySelector('main [class*=panelBody]') || document.querySelector('main')
    const preBody = body()
    const preTextLen = preBody ? preBody.innerText.length : 0
    const preActive = nav.querySelector('button[data-active]')
    const preActiveLabel = preActive ? (preActive.getAttribute('title') || preActive.textContent || '').trim() : null
    const preScrollHeight = preBody ? preBody.scrollHeight : 0
    const t0 = performance.now()
    let firstFrame = null
    let stateChangedAt = null
    let firstContentAt = null
    let lastTextLen = -1
    let stable = 0
    let frames = 0
    let maxFrames = Math.ceil(maxMs / 16.7)
    let raf = 0
    let finished = false
    const finish = (reason) => {
      if (finished) return
      finished = true
      cancelAnimationFrame(raf)
      const b = body()
      resolve({
        ok: true,
        label,
        reason,
        settleMs: Math.round(performance.now() - t0),
        firstFrameMs: firstFrame === null ? null : Math.round(firstFrame - t0),
        stateChangedMs: stateChangedAt === null ? null : Math.round(stateChangedAt - t0),
        firstContentMs: firstContentAt === null ? null : Math.round(firstContentAt - t0),
        frames,
        preActiveLabel,
        postTextLen: b ? b.innerText.length : 0,
        preTextLen,
        scrollHeight: b ? b.scrollHeight : 0,
        scrollHeightDelta: b ? b.scrollHeight - preScrollHeight : 0,
        imgs: document.images.length,
        t0Perf: t0,
      })
    }
    const tick = () => {
      if (finished) return
      const now = performance.now()
      const elapsed = now - t0
      if (firstFrame === null) firstFrame = now
      frames += 1
      const cur = body()
      const txt = cur ? cur.innerText : ''
      const len = txt.length
      const skel = cur ? cur.querySelectorAll('[class*=skel], [class*=Skel], [class*=skeleton]').length : 0
      const active = nav.querySelector('button[data-active]')
      const activeLabel = active ? (active.getAttribute('title') || active.textContent || '').trim() : null
      if (stateChangedAt === null && activeLabel !== preActiveLabel) stateChangedAt = now
      if (firstContentAt === null && len !== preTextLen && len > 40) firstContentAt = now
      const loading = /正在|加载中|统计中|检测中|扫描中|同步中|解析中|读取中/.test(txt) && len < 600
      if (len === lastTextLen && !loading && skel === 0) stable += 1
      else stable = 0
      lastTextLen = len
      if (stable >= stableFrames && elapsed >= minMs) { finish('settled'); return }
      if (elapsed >= maxMs || frames >= maxFrames) { finish('timeout'); return }
      raf = requestAnimationFrame(tick)
    }
    btn.click()
    raf = requestAnimationFrame(tick)
  })
}

/**
 * 在面板滚动容器里批量滚动（模拟用户连续下滚），用于触发长列表/图片懒加载。
 * @param {{ rounds: number, stepRatio?: number, waitMs?: number }} args
 */
export function scrollPanelRounds (args) {
  const rounds = args.rounds ?? 6
  const stepRatio = args.stepRatio ?? 0.85
  const waitMs = args.waitMs ?? 220
  const body = document.querySelector('main [class*=panelBody]') || document.querySelector('main')
  /** 与 collectPageSnapshot 同一口径：先后代、再向上。 */
  const findScroller = (root) => {
    if (!root) return null
    let best = null
    let bestDelta = 40
    let scanned = 0
    for (const el of [root, ...root.querySelectorAll('*')]) {
      scanned += 1
      if (scanned > 12000) break
      const delta = el.scrollHeight - el.clientHeight
      if (delta <= bestDelta) continue
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') { best = el; bestDelta = delta }
    }
    if (best) return best
    let el = root
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) return el
      el = el.parentElement
    }
    return null
  }
  const scroller = findScroller(body)
  const scrollable = Boolean(scroller && scroller !== document.body && scroller.scrollHeight > scroller.clientHeight + 40)
  if (!scrollable) {
    return Promise.resolve({ scrollable: false, rounds: 0, scrollTop: 0, scrollTopBefore: 0, scrollTopAfter: 0, scrollHeight: body ? body.scrollHeight : 0, clientHeight: body ? body.clientHeight : 0 })
  }
  const step = Math.max(200, Math.round(scroller.clientHeight * stepRatio))
  const out = { scrollable: true, rounds: 0, step, scrollTopBefore: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, samples: [] }
  let done = 0
  return new Promise((resolve) => {
    const next = () => {
      if (done >= rounds) {
        out.scrollTopAfter = Math.round(scroller.scrollTop)
        out.rounds = done
        resolve(out)
        return
      }
      const before = scroller.scrollTop
      scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, before + step)
      try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) } catch { /* ignore */ }
      done += 1
      out.samples.push({ round: done, scrollTop: Math.round(scroller.scrollTop), atMs: Math.round(performance.now()) })
      setTimeout(next, waitMs)
    }
    next()
  })
}

/**
 * 等面板落定（不点击任何按钮）：用于启动后总览、或滚动/空闲后确认没有新的加载帧。
 * @param {{ minMs?: number, maxMs?: number, stableFrames?: number }} [args]
 */
export function waitPanelSettled (args) {
  const minMs = (args && args.minMs) || 400
  const maxMs = (args && args.maxMs) || 45000
  const stableFrames = (args && args.stableFrames) || 10
  const t0 = performance.now()
  return new Promise((resolve) => {
    const body = () => document.querySelector('main [class*=panelBody]') || document.querySelector('main')
    let lastTextLen = -1
    let stable = 0
    let frames = 0
    let raf = 0
    let done = false
    const finish = (reason) => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      const b = body()
      resolve({ settled: reason === 'settled', reason, ms: Math.round(performance.now() - t0), textLen: b ? b.innerText.length : 0, scrollHeight: b ? b.scrollHeight : 0 })
    }
    const tick = () => {
      if (done) return
      frames += 1
      const b = body()
      const txt = b ? b.innerText : ''
      const len = txt.length
      const skel = b ? b.querySelectorAll('[class*=skel], [class*=Skel], [class*=skeleton]').length : 0
      const loading = /正在|加载中|统计中|检测中|扫描中|同步中|解析中|读取中/.test(txt) && len < 600
      if (len === lastTextLen && !loading && skel === 0) stable += 1
      else stable = 0
      lastTextLen = len
      const elapsed = performance.now() - t0
      if (stable >= stableFrames && elapsed >= minMs) { finish('settled'); return }
      if (elapsed >= maxMs) { finish('timeout'); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
}
