/**
 * 全功能界面审计：真实 Electron + 真实解密数据，逐个页签量出**留白**与错误。
 *
 * 为什么是"逐页签量空白"：用户对界面的核心抱怨是"留白太多"，而留白在源码里看不出来 ——
 * 一个 `min-height: 420px`、一个 `height: 520px` 的外部组件、一列 5 栅格旁边的 7 栅格空洞，
 * 在代码里都是"正常的一行 CSS"，只有真实布局引擎能算出它到底空了多少。
 *
 * 度量方式（对任意结构都成立，不依赖类名）：
 *   · 把面板滚动容器里**每一块有内容的元素**（有文字 / canvas / img / svg）的矩形
 *     换算到内容坐标系，投到一条 1px 分辨率的"已占用"带上；
 *   · 「最大空白带」= 连续未占用的最高一段，「空白占比」= 未占用行数 / 内容总高。
 *   · 同时记录渲染层 console error、是否是空状态（暂无/未找到/未配置）。
 *
 * 运行：npm run ui:panel-audit         （无真实数据时跳过并退出 0）
 * 输出：控制台表格 + .tmp-e2e/panels/<tab>.png
 */
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
// 真实 profile 播种器（2026-09-29 补：此前只写了注释、漏了 import，脚本一跑就
// `ReferenceError: seedRealProfile is not defined` —— 所以"留白审计"有段时间等于不可用）。
import { seedRealProfile } from './real-profile.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e', 'panels')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

if (!existsSync(EXE)) { console.error('[前置] 找不到 electron.exe：', EXE); process.exit(2) }
mkdirSync(OUT, { recursive: true })

// 真实 profile 的配置（含 llm.json）+ 应用**真正在用**的数据根，见 `real-profile.mjs` 的注释。
const userData = mkdtempSync(join(tmpdir(), 'st-pa-'))
const seeded = seedRealProfile(userData)
const DATA = seeded.dataRoot
console.log(`真实 profile：${seeded.source}（带入 ${seeded.copied.join('、') || '（无额外配置）'}）`)
console.log(`真实数据根：${DATA}`)

/** 在页面里跑的空白度量（返回内容坐标下的统计）。 */
const MEASURE = () => {
  // 「用户此刻看到的是哪个滚动容器」：设置类页面是以 dialog 形式打开的，
  // 这时该量 dialog 自己的内容，而不是它背后那页主内容区。
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => {
    const r = d.getBoundingClientRect()
    return r.width > 200 && r.height > 200
  })
  const panelBody = document.querySelector('main [class*=panelBody]') || document.querySelector('main')
  let scroller = dlg ?? panelBody
  while (scroller && scroller !== document.body) {
    if (scroller.scrollHeight > scroller.clientHeight + 40) break
    scroller = scroller.parentElement
  }
  const sc = scroller && scroller.scrollHeight > scroller.clientHeight + 40 ? scroller : (dlg ?? panelBody)
  const base = sc.getBoundingClientRect()
  const scrollTop = sc.scrollTop
  const H = Math.max(1, Math.round(sc.scrollHeight))
  const used = new Uint8Array(H)
  let contentEls = 0
  for (const el of sc.querySelectorAll('*')) {
    const tag = el.tagName
    const isContent = (el.children.length === 0 && (el.textContent ?? '').trim().length > 0)
      || tag === 'CANVAS' || tag === 'IMG' || tag === 'SVG'
    if (!isContent) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    contentEls++
    const top = Math.max(0, Math.round(r.top - base.top + scrollTop))
    const bottom = Math.min(H, Math.round(r.bottom - base.top + scrollTop))
    for (let y = top; y < bottom; y++) used[y] = 1
  }
  // 最大连续空白带（只看有内容包围的区间：首尾各留 8px 容差）
  let maxGap = 0; let gapStart = 0; let cur = 0; let curStart = 0
  for (let y = 0; y < H; y++) {
    if (!used[y]) { if (cur === 0) curStart = y; cur++ } else { if (cur > maxGap) { maxGap = cur; gapStart = curStart } cur = 0 }
  }
  if (cur > maxGap) { maxGap = cur; gapStart = curStart }
  let blank = 0
  for (let y = 0; y < H; y++) if (!used[y]) blank++
  const txt = sc.innerText ?? ''
  const emptyHints = ['暂无', '未找到', '没有', '未配置', '未检测'].filter((k) => txt.includes(k))
  // 「裁切」只统计**真的看不到**的内容：
  //   · `overflow-y: auto/scroll` 的容器是"可以滚"的，不是裁切（长列表、作者栏都属于这类）；
  //   · `-webkit-line-clamp` 的元素是**有意**截断（朋友圈的链接标题就是 2 行截断，
  //     而且都带 title 全文入口，仓库第 60 轮的截断巡检也是这个口径）。
  // 之前两条都不排除，于是「朋友圈」被记成"裁切 ×11"，实际全是设计如此。
  //
  // 2026-09-26 再补第三条：**`content-visibility: auto` 的元素不算**。
  // 设置弹窗的 `.card` 带 `content-visibility: auto` + `contain-intrinsic-size: auto 320px` ——
  // 视口外的卡片浏览器**根本不渲染**，先按 320px 占位，滚到了才量真实高度。
  // 于是出现 `clientHeight=320 / scrollHeight=880` 这种读数，看着像"卡片切掉 560px"，
  // 其实用户滚过去就能看到全部（`auto` 关键字还会记住首次渲染后的真实尺寸）。
  // 四个弹窗节各报「裁切 ×4」全是它 —— 与「转账红包 ×1」（那是真的被 flex 压掉 85px）性质完全不同。
  const clippedEls = [...sc.querySelectorAll('*')]
    .filter((el) => {
      if (el.clientHeight <= 24) return false
      if (el.scrollHeight <= el.clientHeight + 4) return false
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'visible' || cs.overflowY === 'auto' || cs.overflowY === 'scroll') return false
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return false
      if (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap') return false
      if (cs.contentVisibility === 'auto') return false
      return true
    })
  // 记下**被裁的是谁**。只报数量的话，修的时候只能靠猜 —— 实测「转账红包 裁切×1」
  // 与「四个弹窗节 裁切×4」看着是同一类，其实一个是卡片被 flex 压缩、另一个是骨架行，
  // 修法完全不同。这里是"定点诊断"要用的最小信息：标签 + 类名 + 尺寸 + 文本开头。
  const clipDetail = clippedEls.slice(0, 6).map((el) => {
    const cls = String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')
    const t = (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 16)
    return `${el.tagName.toLowerCase()}.${cls}[h=${el.clientHeight} sh=${el.scrollHeight}]${t === '' ? '' : ' 「' + t + '」'}`
  })
  return {
    contentH: H,
    maxGap,
    gapStart: gapStart + Math.round(scrollTop),
    blank,
    blankPct: Math.round((blank / H) * 100),
    contentEls,
    clipped: clippedEls.length,
    clipDetail,
    emptyHints,
    textLen: txt.length,
    // 面板正文开头（用于人工判断"这一屏到底是什么状态"）
    head: txt.replace(/\s+/g, ' ').trim().slice(0, 110),
  }
}

let app = null
const rows = []
try {
  // ⚠️ 必须先把 `ELECTRON_RUN_AS_NODE` 摘掉再传给 Electron：本机把它注入了环境，
  // Electron 继承它就会**退化成纯 node**（没有窗口/渲染层），playwright 只报一句
  // 没有下文的 `Process failed to launch!`。此前一直靠 `working/run.py` 里的
  // `env.pop()` 兜着 —— 也就是说**直接 `node scripts/panel-audit.mjs` 是跑不起来的**
  // （2026-09-26 实测）。在这里再拦一道，脚本才能独立运行。
  const launchEnv = { ...process.env }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: { ...launchEnv, SUPERTIME_USER_DATA_DIR: userData, SUPERTIME_SKIP_ONBOARDING: '1', SUPERTIME_TEST_MODE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(45000)

  /**
   * 主题选择（`--theme light|dark`，默认 dark）。
   *
   * 为什么加：这个脚本原先**完全不碰主题**，截图一律是默认（深色）。
   * 而"浅色主题下颜色一致"这条要求，最后需要**人眼看浅色界面** ——
   * 没有浅色截图，那一步就只能靠人在应用里手动切主题、手动点 16 个页签，
   * 成本高到基本不会被做。加一个开关，浅色截图一条命令就有。
   *
   * 做法与 `theme-live-audit.mjs` 一致：写 `localStorage` 再 reload，
   * 并**断言真的切过去了**（否则会拿到"看着像浅色、其实是深色"的图 —— 第 16 轮踩过）。
   */
  const themeArg = (() => {
    const i = process.argv.indexOf('--theme')
    const v = i === -1 ? 'dark' : String(process.argv[i + 1] ?? 'dark')
    return v === 'light' ? 'light' : 'dark'
  })()
  await win.evaluate((t) => { localStorage.setItem('super-time-wechat-theme', t) }, themeArg)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await sleep(1500)
  {
    const applied = String(await win.evaluate(() => document.documentElement.className))
    const okTheme = applied.includes('theme-light') === (themeArg === 'light')
    if (!okTheme) {
      throw new Error(`主题没切过去：请求 ${themeArg}，但 htmlClass="${applied}" ⇒ 拒绝继续产出（否则截图会被误当成该主题的证据）`)
    }
    console.log(`主题 = ${themeArg}（已断言 htmlClass="${applied}"）`)
  }
  const suffix = themeArg === 'light' ? '.light' : ''
  const errs = []
  // 「Failed to load resource」是资源加载失败的通用文案，由下面的 response 监听带着 URL 单独统计，
  // 这里不再重复计入 console 错误 —— 让 `console×N` 只表示**我们代码的** JS 错误。
  win.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 120)) })
  win.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 120)))
  /**
   * 外部资源加载失败（4xx/5xx）单独记：那不是我们代码的错误，而是 CDN 那边的。
   * 实测「朋友圈」的 3 条 console error 全是 `mmbiz.qpic.cn`（公众号封面 CDN）的 400 ——
   * 图片 URL 过期，Chromium 无论有没有 onError 兜底都会打一条 console error。
   * 这类只报数、不判失败；JS 错误与 pageerror 才算失败。
   */
  const assetFails = []
  win.on('response', (r) => {
    if (r.status() >= 400 && /^https?:/i.test(r.url())) assetFails.push(`${r.status()} ${r.url().slice(0, 90)}`)
  })
  await win.waitForLoadState('domcontentloaded')

  // 导航条目（nav 内的按钮），label 取自 title
  const tabs = await win.evaluate(() => {
    const nav = document.querySelector('aside nav') || document.querySelector('nav')
    return [...nav.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean)
  })
  console.log(`导航条目共 ${tabs.length} 个\n`)

  const loaded = await win.evaluate(() => !!document.querySelector('main [class*=panelBody]'))
  if (!loaded) console.log('（面板未挂载，仍继续逐页签尝试）')

  /** 等到面板"落定"：文字稳定 3 次 + 无加载措辞 + 无骨架 + 至少 minMs 毫秒。 */
  const settle = async ({ minMs = 6000, maxPolls = 60, phraseAlwaysLoading = false } = {}) => {
    let prevLen = -1
    let stable = 0
    let loading = true
    const t0 = Date.now()
    for (let i = 0; i < maxPolls; i++) {
      await sleep(600)
      const st = await win.evaluate((alwaysPhrase) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().height > 200)
        const sc = dlg ?? document.querySelector('main [class*=panelBody]') ?? document.querySelector('main')
        const t = sc?.innerText ?? ''
        const skel = sc ? sc.querySelectorAll('[class*=skel], [class*=Sk], .nm-skel').length : 0
        const hasPhrase = /正在|加载中|统计中|检测中|扫描中|同步中|解析中|读取中/.test(t)
        // 默认只在"内容还很少"时才算加载态（朋友圈头部那句说明文字含"统计中"，是反例）；
        // 隐藏页签那一遍是重载后的冷启动，面板本来就会明说"正在统计"，这时一律算加载中。
        return { len: t.length, skel, loading: hasPhrase && (alwaysPhrase || t.length < 400) }
      }, phraseAlwaysLoading)
      loading = st.loading || st.skel > 0
      const settled = st.len === prevLen && !loading
      if (settled) { stable++; if (stable >= 3 && Date.now() - t0 > minMs) break } else { stable = 0 }
      prevLen = st.len
    }
    return loading
  }

  /**
   * 等后端队列排空再量。
   * 后端是**同步**处理请求的：前面几屏的重查询（存储分析、朋友圈洞察、年度报告…）
   * 会把后面的请求全堵在队列里，于是面板上只剩一句"统计中…"。
   * 实测：单独重载进「表情包」t=0 就有数据；而跟在几个重面板之后进同一页，60 秒还在"正在加载"。
   * 注意探针必须**打到 worker**：`listMethods` 是主进程直接答的，后端再堵它也是 1ms
   * （第一版就踩了这个坑，队列繁忙被误判成空闲）。
   */
  const waitQueueIdle = async () => {
    let queueMs = 0
    for (let i = 0; i < 120; i++) {
      try {
        queueMs = await win.evaluate(async () => {
          const t = performance.now()
          await window.electronAPI.wechat.call('getSearchIndexStatus', {})
          return Math.round(performance.now() - t)
        })
      } catch { queueMs = -1 }
      if (queueMs >= 0 && queueMs < 500) break
      await sleep(1000)
    }
    return queueMs
  }

  for (const label of tabs) {
    if (process.argv.includes('--hidden-only')) break
    const before = errs.length
    const assetBefore = assetFails.length
    let m = null
    try {
      await win.getByRole('button', { name: label, exact: true }).first().click({ timeout: 8000 })
      // 等队列排空 + 面板"落定"。三条都满足才算：① 文字长度连续 3 次不变 ② 不再有加载措辞
      // ③ 没有骨架元素。另外至少等 6 秒。
      //   —— 少了 ③ 和最短等待，会把"首屏还没取到数据的空面板"当成落定：
      //   实测「文件与存储」加载中头部写的是「共 0 项 …（0）」，文字稳定、没有"加载中"字样，
      //   于是被量成"651px 空白 + 0 项"，而真实数据是 4305 个文件（3–6 秒后才到）。
      const queueMs = await waitQueueIdle()
      // ⚠️ **必须先等落定、再量**（2026-09-26 修）。原先这里是「先 MEASURE、再 settle，
      // 把 settle 的结果只当作一个 flag」，于是**量的是加载帧**：
      // 实测「群聊分析」被量成 `624px 空白 / 84% / 只有 60 字`，而同一帧的正文里
      // 就明写着「统计中…」—— 那是加载态，不是布局缺陷。settle 之后才拿到真数据。
      // 顺序错了的话，下面所有"空白带/空白占比"结论都不可信（本项目第 N 次被量具骗）。
      const stillLoading = await settle()
      m = await win.evaluate(MEASURE)
      m.queueMs = queueMs
      m.stillLoading = stillLoading
      const slug = label.replace(/[^\w\u4e00-\u9fa5]+/g, '_')
      await win.screenshot({ path: join(OUT, `${slug}${suffix}.png`) })
    } catch (e) {
      rows.push({ label, failed: (e.message || String(e)).split('\n')[0].slice(0, 60) })
      continue
    }
    rows.push({ label, ...m, errs: errs.slice(before), assetFails: assetFails.slice(assetBefore) })
  }

  /**
   * 第二遍：**隐藏页签**。它们在导航里不渲染（`hidden: true`），但用户能从各面板的「详情 →」
   * 进入，同样是真实可见的界面。驱动方式是本页唯一可用的入口：写 hash 后重载
   * （`WechatDataPanel` 只在挂载时读 `location.hash`）。
   * 其中 4 个（数据边界与出网 / 备份恢复 / 数据库健康 / 原图链路自检）以「设置」弹窗形式打开，
   * 度量会自动改量弹窗本身（见 MEASURE）。
   */
  if (!process.argv.includes('--fast')) {
    const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts'), 'utf8')
    const hidden = []
    for (const ln of cfg.split(/\r?\n/)) {
      const mm = ln.match(/\{ tab: '([a-z]+)', label: '([^']+)'/)
      if (mm && ln.includes('hidden: true')) hidden.push({ tab: mm[1], label: mm[2] })
    }
    console.log(`\n隐藏页签 ${hidden.length} 个：${hidden.map((h) => h.tab).join(', ')}\n`)
    for (const h of hidden) {
      const before = errs.length
      const assetBefore = assetFails.length
      try {
        await win.evaluate((t) => { location.hash = '#' + t }, h.tab)
        await win.reload({ waitUntil: 'domcontentloaded' })
        // 4 个隐藏页签以「设置」弹窗打开：此时 Radix 会把主内容区设为 aria-hidden，
        // 导航按钮查不到 —— 所以等"导航按钮 **或** 弹窗"任一出现。
        await Promise.race([
          win.getByRole('button', { name: '数据总览', exact: true }).waitFor({ state: 'visible', timeout: 60000 }),
          win.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 60000 }),
        ])
        // 壳挂上 ≠ 面板挂上：重载后第一个隐藏页签曾量到"0 字 + 631px 全空"
        // （壳已渲染、页签内容还没 mount）。这里等到**确实有内容**再进入落定判定。
        for (let i = 0; i < 60; i++) {
          const len = await win.evaluate(() => {
            const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().height > 200)
            const sc = dlg ?? document.querySelector('main [class*=panelBody]') ?? document.querySelector('main')
            return (sc?.innerText ?? '').trim().length
          })
          if (len > 50) break
          await sleep(500)
        }
        const queueMs = await waitQueueIdle()
        // 冷启动：面板自己会写"正在统计/正在加载"，这时一律按加载中处理。
        // 与可见页签那一遍同理：**先等落定、再量**（量加载帧会得到虚高的空白带）。
        const stillLoading = await settle({ minMs: 12000, maxPolls: 100, phraseAlwaysLoading: true })
        const m = await win.evaluate(MEASURE)
        m.queueMs = queueMs
        m.stillLoading = stillLoading
        await win.screenshot({ path: join(OUT, `hidden-${h.tab}${suffix}.png`) })
        rows.push({ label: h.label, hidden: true, ...m, errs: errs.slice(before), assetFails: assetFails.slice(assetBefore) })
      } catch (e) {
        rows.push({ label: h.label, hidden: true, failed: (e.message || String(e)).split('\n')[0].slice(0, 60) })
      }
    }
    // 回到干净状态，别把隐藏页签的 hash 留给下一个人
    await win.evaluate(() => { location.hash = '#overview' })
  }
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
}

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)
console.log(`${pad('面板', 16)}${num('内容高', 7)}${num('最大空白', 9)}${num('空白占比', 9)}${num('裁切', 5)}${num('文字', 7)}  状态`)
for (const r of rows) {
  if (r.failed) { console.log(`${pad(r.label, 16)}  点击失败: ${r.failed}`); continue }
  const flags = []
  if (r.queueMs !== undefined && r.queueMs >= 500) flags.push(`后端排队(探针 ${r.queueMs}ms)`)
  if (r.stillLoading) flags.push('仍在加载')
  if (r.emptyHints.length) flags.push('含空态词:' + r.emptyHints.join('/'))
  if (r.errs.length) flags.push('console×' + r.errs.length)
  if (r.assetFails?.length) flags.push('外部资源×' + r.assetFails.length)
  if (r.clipped > 0) flags.push('裁切×' + r.clipped)
  if (r.textLen < 80) flags.push('几乎无文字')
  console.log(`${pad(r.label, 16)}${num(r.contentH, 7)}${num(r.maxGap + 'px', 9)}${num(r.blankPct + '%', 9)}${num(r.clipped, 5)}${num(r.textLen, 7)}  ${flags.join(' ')}`)
  // 被裁元素的身份另起一行，缩进在它所属的那一行下面（修的时候用它定位，别猜）
  if (r.clipDetail?.length) console.log(`${' '.repeat(18)}└─ ${r.clipDetail.join(' | ')}`)
}

// 按"最大空白"排序给出优先级建议（附正文开头，避免把"空状态"误判成"没渲染"）
const worst = rows.filter((r) => !r.failed).sort((a, b) => b.maxGap - a.maxGap).slice(0, 10)
console.log('\n最大空白 Top 10：')
for (const r of worst) {
  console.log(`  ${pad(r.label, 16)} 空白带 ${num(r.maxGap + 'px', 5)}（起点 y=${r.gapStart}）占比 ${num(r.blankPct + '%', 4)} 内容高 ${r.contentH}px`)
  console.log(`      「${r.head}」`)
}
console.log(`\n截图目录：${OUT}`)
