/**
 * 响应式审计 · 主流程（启动 Electron → --selftest → 逐 tab×视口检测 → 汇总落盘）。
 *
 * 从 `scripts/responsive-audit.mjs` **机械拆出**：原顶层 await 语句整体包进 `run()`，
 * 参数解析/退出码/控制台输出/JSON 与 Markdown 形状全部保持不变。
 *
 * @module scripts/responsive-audit/runner
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import {
  ROOT, EXE, NAV_CONFIG, hasFlag, opt, THRESHOLDS, MAX_SHOTS, NO_SHOTS,
  parseTabs, parseViewports, slug, defaultLabel, sleep, gitHead, RULE_ORDER,
  detectUserDataDir, seedProfile,
} from './setup.mjs'
import { AUDIT_PAGE } from './detector.mjs'
import { buildSummary, buildBaselineMarkdown } from './report.mjs'

/**
 * 跑一次响应式审计（入口传参走 `process.argv`，与拆分前一致）。
 * @returns {Promise<void>} 完成后由 `process.exitCode` 表达结果。
 */
export async function run () {
  // ── 主流程 ────────────────────────────────────────────────────────────────
  const LABEL = opt('label', defaultLabel())
  const VIEWPORTS = parseViewports()
  const OUT_DIR = resolve(ROOT, opt('out', join('working', 'team', 'responsive')))
  const SHOTS_DIR = join(OUT_DIR, 'shots')
  const REPORT_DIR = resolve(ROOT, opt('report-dir', join('working', 'team')))
  const PROFILE_DIR = resolve(ROOT, opt('profile', join('.tmp-e2e', 'responsive-profile')))
  const JSON_PATH = join(OUT_DIR, `${slug(LABEL)}.json`)
  const BASELINE_MD = join(REPORT_DIR, 'responsive-baseline.md')

  const ALL_TABS = parseTabs()
  const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean)
  const TABS = ONLY.length > 0 ? ALL_TABS.filter((t) => ONLY.includes(t.tab)) : ALL_TABS

  if (hasFlag('list')) {
    console.log(`共解析 ${ALL_TABS.length} 个页签（${ALL_TABS.filter((t) => t.hidden).length} 个 hidden）：`)
    for (const [i, t] of ALL_TABS.entries()) {
      console.log(`${String(i + 1).padStart(2, '0')}. ${t.tab.padEnd(16)} ${t.label}${t.hidden ? '  (hidden → 由父面板分段/弹窗到达)' : ''}`)
    }
    process.exit(0)
  }

  // 前置检查
  if (!existsSync(EXE)) { console.error('[前置] 找不到 electron.exe：', EXE); process.exit(2) }
  if (!existsSync(NAV_CONFIG)) { console.error('[前置] 找不到 nav-config.ts：', NAV_CONFIG); process.exit(2) }
  if (ALL_TABS.length < 30) console.warn(`[警告] 从 nav-config 只解析出 ${ALL_TABS.length} 个页签，预期 38 —— 检查正则是否与源码结构失配`)
  if (TABS.length === 0) { console.error('[前置] --only 过滤后没有可跑的页签'); process.exit(2) }
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(REPORT_DIR, { recursive: true })
  if (!NO_SHOTS) mkdirSync(SHOTS_DIR, { recursive: true })

  let playwright
  try {
    playwright = await import('playwright')
  } catch (e) {
    console.error('[前置] 缺少 playwright（devDependency）：', e.message)
    process.exit(2)
  }
  const { _electron } = playwright

  const srcUserData = resolve(ROOT, opt('user-data', '') || detectUserDataDir())
  console.log('─'.repeat(78))
  console.log(`响应式审计  label=${LABEL}  git=${gitHead()}  node=${process.version}  electron=${(() => {
    try { return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return 'unknown' }
  })()}`)
  console.log(`页签 ${TABS.length}/${ALL_TABS.length}  视口 ${VIEWPORTS.map((v) => v.label).join(' / ')}`)
  console.log(`真实 profile：${srcUserData}`)
  console.log('─'.repeat(78))

  // 播种影子 profile（绕开单实例锁；真实数据只读）
  const profile = seedProfile(PROFILE_DIR, srcUserData)
  console.log(`临时 profile：${PROFILE_DIR}`)
  console.log(`  数据根：${profile.dataRoot || '（未确定）'}`)
  console.log(`  配置复制：${profile.copied.join(' / ') || '（无）'}`)
  console.log(`  首启闸门：${profile.gates === 'seeded' ? '已复制真实状态（无调试横幅）' : '回退 SUPERTIME_SKIP_ONBOARDING=1（界面含调试横幅）'}`)
  for (const r of profile.reasons) console.log(`  · ${r}`)

  // 启动真实 Electron
  const launchEnv = { ...process.env, SUPERTIME_USER_DATA_DIR: PROFILE_DIR }
  delete launchEnv.ELECTRON_RUN_AS_NODE // harness 注入它会让 Electron 退化成纯 node（崩在 main.js 的 app.isPackaged）
  if (profile.gates !== 'seeded') launchEnv.SUPERTIME_SKIP_ONBOARDING = '1'
  // 不要设 SUPERTIME_TEST_MODE：它会在 #root 前插一条红色自动化横幅，改变布局测量与截图。

  const consoleErrors = []
  const tRunStart = Date.now()
  let app = null
  let fatal = null
  const cells = []

  try {
    app = await _electron.launch({ executablePath: EXE, args: [ROOT], cwd: ROOT, env: launchEnv })
    const win = await app.firstWindow()
    win.setDefaultTimeout(60000)
    await win.waitForLoadState('domcontentloaded')
    win.on('console', (m) => {
      if (m.type() !== 'error') return
      if (/Failed to load resource/i.test(m.text())) return // 外部图片 CDN 失败不是布局缺陷
      if (consoleErrors.length < 100) consoleErrors.push(m.text().slice(0, 180))
    })
    win.on('pageerror', (e) => {
      if (consoleErrors.length < 100) consoleErrors.push('pageerror: ' + String(e.message).slice(0, 180))
    })

    /** 等应用主界面挂载（导航壳出现）。闸门没通过时这里会失败，报出诊断而不是继续量授权页。 */
    const waitShell = async (timeout = 60000) => {
      await win.waitForFunction(() => {
        const aside = document.querySelector('aside')
        const navBtn = aside && [...aside.querySelectorAll('button')]
          .some((b) => ((b.getAttribute('title') || '') + (b.textContent || '')).includes('数据总览'))
        const mobile = document.querySelector('nav[aria-label="主导航"]')
        const dlg = document.querySelector('[role="dialog"]')
        return !!(navBtn || mobile || dlg)
      }, null, { timeout })
    }

    try {
      await waitShell()
    } catch {
      const diag = await win.evaluate(() => ({
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        htmlClass: document.documentElement.className,
      })).catch(() => ({ text: '(取不到 body)', htmlClass: '' }))
      throw new Error(`未能进入主界面（首启闸门？）body=「${diag.text}」 htmlClass=「${diag.htmlClass}」`)
    }
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

    // 放开最小窗口尺寸（main-window 的 minWidth 960/minHeight 640 会挡住窄窗）。
    await app.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows()[0]
      if (!bw) return
      if (bw.isMaximized()) bw.unmaximize()
      bw.setMinimumSize(320, 480)
    })

    // ── 检测器自检（--selftest）：往运行中的真实界面注入 5 类夹具 + 1 个负向护栏，断言规则行为 ──
    // 目的：证明「0 条 doc-overflow / 0 条 occluded」这类结论是**真没有**，而不是检测器写坏了。
    // 注入的夹具全部带 `st-` 前缀，测完即移除并 reload，不进入基线。
    // task-10 起增加 occluded 负向护栏：位于滚动视口之外、被祖先 overflow 裁掉的内容不得被判遮挡
    //（Wave2 的 A1/A2 误报就是它）。
    if (hasFlag('selftest')) {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
      await sleep(500)
      await win.evaluate(() => {
        for (const el of document.querySelectorAll('[id^="st-"]')) el.remove()
        // 夹具直接挂 body：若套一层公共父级，公共父级自己会落进「越界/裁切」候选，
        // 子夹具会被「只报最外层元凶」的去重规则合并掉，自检就测不到每条规则了。
        const html = [
          // ① 文档横向溢出：2000px 宽、绝对定位在 left:0
          '<div id="st-wide" style="position:absolute;left:0;top:0;width:2000px;height:8px;background:#123">wide</div>',
          // ② 元素越界：超出视口右缘
          '<button id="st-oob" type="button" style="position:absolute;left:0;top:20px;width:calc(100vw + 120px);height:32px">越界按钮</button>',
          // ③ 裁切：overflow hidden 里放不换行长文本
          '<div id="st-clip" style="position:absolute;left:0;top:70px;width:120px;height:40px;overflow:hidden">'
            + '<span style="white-space:nowrap">这是一段绝对不会换行因此必然被裁切的长文本 fixture</span></div>',
          // ④ 遮挡：固定覆盖层压住一个可交互按钮
          '<div id="st-overlay" style="position:fixed;left:0;top:40%;width:100vw;height:80px;z-index:99999;background:#000;color:#fff">覆盖层 fixture</div>',
          '<button id="st-covered" type="button" style="position:absolute;left:20px;top:calc(40% + 20px);width:240px;height:40px">被遮挡按钮</button>',
          // ⑤ 有文本但不可见
          '<span id="st-hidden" style="display:none">这段文字 fixture 不可见</span>',
          // ④-负向护栏（task-10）：按钮位于 overflow:hidden 容器（300..400）的滚动视口之外
          // （480..520，中心 500 在视口内），中心点被 fixed 底栏（460..800）命中；同容器里还有一个
          // 同样被裁掉的 sticky 层（矩形与按钮相交、中心 450 在裁剪区外）。
          // 旧判据：几何相交 + 命中到某个覆盖层 ⇒ 把不可见的 sticky 层报成遮挡（A1/A2 同款误报）；
          // 修正后：目标未被绘制 ⇒ 不得开火。
          '<div id="st-neg-box" style="position:absolute;left:0;top:300px;width:300px;height:100px;overflow:hidden">'
            + '<div id="st-neg-overlay" style="position:sticky;top:0;height:300px;width:300px;z-index:5;background:#000;color:#fff">被裁掉的粘性层</div>'
            + '<button id="st-neg-target" type="button" style="position:absolute;left:0;top:180px;width:200px;height:40px">滚动视口外的按钮</button>'
            + '</div>',
          '<div id="st-neg-bar" style="position:fixed;left:0;top:460px;width:100vw;height:340px;z-index:99999;background:#000;color:#fff">固定底栏</div>',
          // ②-负向护栏（task-16）：完全离屏不得判横向越界。复刻 privacy@390 flaky 的形状：
          // 纵向 y=-2600（与视口无交集）、宽度 838 > 390。旧判据只比 right/left ⇒ 误报 high。
          '<div id="st-oob-offscreen" style="position:absolute;left:0;top:-2600px;width:calc(100vw + 320px);height:40px">完全离屏的宽块</div>',
          // ②-负向护栏（task-16）：可横向滚动祖先内的内容不得判越界（滚动可达）。
          '<div id="st-hscroll" style="position:absolute;left:0;top:140px;width:300px;height:80px;overflow-x:auto;overflow-y:hidden">'
            + '<button id="st-hscroll-child" type="button" style="width:1600px;height:40px">横向滚动容器内的超宽按钮</button>'
            + '</div>',
        ].join('')
        document.body.insertAdjacentHTML('beforeend', html)
      })
      const stResult = await win.evaluate(AUDIT_PAGE, {
        tol: THRESHOLDS.viewportOverflowPx,
        maxPerRule: THRESHOLDS.perRuleCap,
        overlapPct: THRESHOLDS.occlusionOverlapPct,
        visualPct: THRESHOLDS.occlusionVisualPct,
        docOverflowPx: THRESHOLDS.docOverflowPx,
      })
      const expect = {
        'doc-overflow': null, // 文档级问题没有具体元素：只断言规则开火
        'out-of-viewport': 'st-oob',
        clipped: 'st-clip',
        occluded: 'st-covered',
        hidden: 'st-hidden',
      }
      let failed = []
      console.log('\n── 检测器自检（--selftest）──')
      console.log(`  视口 ${stResult.viewport.vw}×${stResult.viewport.vh}；html.scrollWidth=${stResult.doc.scrollWidth} body.scrollWidth=${stResult.doc.bodyScrollWidth}`)
      for (const [rule, id] of Object.entries(expect)) {
        const hit = stResult.issues.some((i) => i.rule === rule && (!id || i.id === id || (i.sel || '').includes(id)))
        console.log(`  ${hit ? 'PASS' : 'FAIL'}  ${rule.padEnd(16)} ${id ? `期望命中 #${id}` : '期望规则开火（文档级）'}`)
        if (!hit) failed.push(rule)
      }
      // 负向护栏：滚动视口外（被祖先裁掉）的内容不得判遮挡（task-10 / Wave2 A1·A2 误报回归守卫）。
      const negHit = stResult.issues.some((i) => i.rule === 'occluded' &&
        (i.id === 'st-neg-target' || (i.sel || '').includes('st-neg-target')))
      console.log(`  ${!negHit ? 'PASS' : 'FAIL'}  occluded(负向)   滚动视口外的内容不得判遮挡`)
      if (negHit) failed.push('occluded-negative')
      // 负向护栏（task-16）：完全离屏 / 横向可滚内容不得判 out-of-viewport。
      const hasOob = (id) => stResult.issues.some((i) => i.rule === 'out-of-viewport' &&
        (i.id === id || (i.sel || '').includes(id)))
      const offscreenHit = hasOob('st-oob-offscreen')
      const hscrollHit = hasOob('st-hscroll-child')
      console.log(`  ${!offscreenHit ? 'PASS' : 'FAIL'}  out-of-viewport(负向) 完全离屏的元素不得判越界`)
      console.log(`  ${!hscrollHit ? 'PASS' : 'FAIL'}  out-of-viewport(负向) 横向可滚祖先内的内容不得判越界`)
      if (offscreenHit) failed.push('out-of-viewport-offscreen')
      if (hscrollHit) failed.push('out-of-viewport-hscroll')
      console.log(`  自检结果：${failed.length === 0 ? '5/5 规则均开火 + 2 条负向护栏通过' : `失败 ${failed.join(', ')}`}（共 ${stResult.issues.length} 条夹具问题）`)
      // 清场：移除夹具并 reload，避免污染后续基线（自检模式本来也不跑基线）。
      await win.evaluate(() => { for (const el of document.querySelectorAll('[id^="st-"]')) el.remove() })
      await app.close()
      app = null
      process.exit(failed.length === 0 ? 0 : 1)
    }

    /**
     * 深度链接进入一个页签：写 hash → reload。
     * WechatDataPanel 只在挂载时读 `location.hash`（没有 hashchange 监听），所以必须 reload；
     * 这也正是深链（#ledger / #graph / #settings…）的进入姿势，41 个可路由状态都能覆盖。
     */
    const goto = async (tab) => {
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await win.evaluate((t) => { location.hash = `#${t}` }, tab).catch(() => {})
          await win.reload({ waitUntil: 'domcontentloaded' })
          await waitShell(45000)
          return attempt
        } catch (e) {
          lastErr = e
          await sleep(700)
        }
      }
      throw lastErr ?? new Error('goto 失败')
    }

    /** 读当前「正在看的那一层」的文本长度与骨架数（落定判据）。 */
    const readState = () => win.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')]
        .find((d) => { const r = d.getBoundingClientRect(); return r.width > 200 && r.height > 200 })
      const sc = dlg ?? document.querySelector('main') ?? document.body
      const text = (sc.innerText || '').replace(/\s+/g, ' ').trim()
      const skel = (dlg ?? document).querySelectorAll('[class*="skeleton"], [class*="Skeleton"], .nm-skel, [data-st-loading]').length
      return { len: text.length, skel, dialog: !!dlg, hash: location.hash, vw: innerWidth, vh: innerHeight }
    })

    /**
     * 等面板落定：至少 `tabWaitMinMs`，且文本长度连续 3 次（≈500ms）不变 + 无骨架。
     * 冷启动重载后数据异步到达（真实数据下「聊天会话」等页在 ~1.0s 才把列表填上），
     * 只等固定时长会把「空面板」当成落定 —— 这里用长度稳定兜住，最长 6s。
     */
    const waitSettled = async () => {
      const t0 = Date.now()
      let prevLen = -1
      let stable = 0
      let last = null
      while (Date.now() - t0 < THRESHOLDS.tabWaitMaxMs) {
        await sleep(250)
        last = await readState()
        if (last.len === prevLen && last.skel === 0) stable++
        else stable = 0
        prevLen = last.len
        if (Date.now() - t0 >= THRESHOLDS.tabWaitMinMs && stable >= 2) break
      }
      return { ...last, settledMs: Date.now() - t0 }
    }

    /** 改窗口内容区尺寸，并等到渲染层视口真的跟上。 */
    const setViewport = async (vp) => {
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        const bw = BrowserWindow.getAllWindows()[0]
        if (!bw) return
        if (bw.isMaximized()) bw.unmaximize()
        bw.setMinimumSize(320, 480)
        bw.setContentSize(w, h)
      }, [vp.w, vp.h])
      let matched = true
      try {
        await win.waitForFunction(([w, h]) =>
          Math.abs(window.innerWidth - w) <= 2 && Math.abs(window.innerHeight - h) <= 2,
        [vp.w, vp.h], { timeout: 6000 })
      } catch { matched = false }
      await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await sleep(THRESHOLDS.resizeSettleMs)
      const actual = await win.evaluate(() => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 }))
      return { ...actual, matched }
    }

    // ── 逐个页签 × 逐个视口 ────────────────────────────────────────────
    let shotsTaken = 0
    const tabStartedAt = Date.now()
    for (const [tabIndex, tabInfo] of TABS.entries()) {
      const tabT0 = Date.now()
      const navAttempt = await goto(tabInfo.tab)
      const settled = await waitSettled()
      const rowCounts = []
      for (const vp of VIEWPORTS) {
        const actual = await setViewport(vp)
        let result = null
        let error = ''
        try {
          result = await win.evaluate(AUDIT_PAGE, {
            tol: THRESHOLDS.viewportOverflowPx,
            maxPerRule: THRESHOLDS.perRuleCap,
            overlapPct: THRESHOLDS.occlusionOverlapPct,
            visualPct: THRESHOLDS.occlusionVisualPct,
            docOverflowPx: THRESHOLDS.docOverflowPx,
          })
        } catch (e) {
          error = (e?.message ?? String(e)).split('\n')[0].slice(0, 200)
        }
        const cell = {
          tab: tabInfo.tab,
          label: tabInfo.label,
          hidden: tabInfo.hidden,
          viewport: vp.label,
          requested: { w: vp.w, h: vp.h },
          actual: { w: actual.vw, h: actual.vh, dpr: actual.dpr, sizeMatched: actual.matched },
          settled: { loadAttempt: navAttempt, settledMs: tabT0 ? Date.now() - tabT0 : null },
          error,
          result,
          screenshot: '',
        }
        if (!error && result) {
          const counts = {}
          for (const rule of RULE_ORDER) counts[rule] = result.issues.filter((i) => i.rule === rule).length
          cell.counts = counts
          cell.total = result.issues.length
          rowCounts.push(`${vp.label.replace('x', '×')}:${result.issues.length}`)
          // 截图策略：文档横向溢出 / 存在 high 级问题才拍，受全局上限约束。
          const docOverflow = counts['doc-overflow'] > 0
          const anyHigh = result.issues.some((i) => i.severity === 'high')
          if (!NO_SHOTS && shotsTaken < MAX_SHOTS && (docOverflow || anyHigh)) {
            const file = `${slug(LABEL)}-${slug(tabInfo.tab)}-${slug(vp.label)}.jpg`
            try {
              await win.screenshot({ path: join(SHOTS_DIR, file), type: 'jpeg', quality: 70 })
              cell.screenshot = `shots/${file}`
              shotsTaken++
            } catch { /* 截图失败不影响基线数据 */ }
          }
        } else {
          cell.total = 0
          rowCounts.push(`${vp.label.replace('x', '×')}:ERR`)
        }
        cells.push(cell)
      }
      const okCells = cells.filter((c) => c.tab === tabInfo.tab && !c.error)
      const tabIssues = okCells.reduce((s, c) => s + c.total, 0)
      const elapsed = ((Date.now() - tabT0) / 1000).toFixed(1)
      console.log(`[${String(tabIndex + 1).padStart(2, '0')}/${TABS.length}] ${tabInfo.tab.padEnd(16)} ${rowCounts.join(' ')}  total=${String(tabIssues).padStart(3)}  ${elapsed}s${settled.settledMs >= THRESHOLDS.tabWaitMaxMs ? ' (落定超时)' : ''}`)
    }

    // ── 汇总与落盘 ─────────────────────────────────────────────────────
    const durationMs = Date.now() - tRunStart
    const summary = buildSummary(cells, TABS, VIEWPORTS)
    const meta = {
      tool: 'scripts/responsive-audit.mjs',
      version: 1,
      label: LABEL,
      at: new Date().toISOString(),
      durationMs,
      git: gitHead(),
      node: process.version,
      electron: (() => {
        try { return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return 'unknown' }
      })(),
      playwright: (() => {
        try { return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8')).version } catch { return 'unknown' }
      })(),
      root: ROOT,
      userDataSource: srcUserData,
      dataRoot: profile.dataRoot,
      profileDir: PROFILE_DIR,
      profileGates: profile.gates,
      profileReasons: profile.reasons,
      viewports: VIEWPORTS,
      thresholds: THRESHOLDS,
      tabsParsed: ALL_TABS.length,
      tabsRun: TABS.map((t) => ({ tab: t.tab, label: t.label, hidden: t.hidden })),
      consoleErrors: consoleErrors.slice(0, 50),
      screenshots: shotsTaken,
      limitations: [
        '检测基于 DOM 几何 + elementFromPoint，不覆盖 canvas / WebGL 内部绘制内容（如图谱画布里的节点重叠）。',
        '只测「初次进入的默认状态」：弹层/抽屉/下拉/筛选展开态、hover/focus 态与滚动后的位置不覆盖。',
        '窗体内视口尺寸 = BrowserWindow 内容区；与真机浏览器（含地址栏、安全区）存在差异。',
        '纵向溢出属正常文档滚动，只在「overflow:hidden/clip 裁切」与「fixed/sticky 遮挡」规则下检测。',
        '横向可滚容器（滚动条全局隐藏，实际可用滚轮/shift 滚动或触摸滚动）内的内容视为「滚动可达」，不计越界。',
        '应用在 body/#root/面板层已有 overflow:hidden 裁剪：真正伸出视口的元素很少，多数横向溢出会以「规则③ 被祖先裁切」的形态出现，修复时看裁剪容器。',
        '遮挡判据（task-10）要求目标/覆盖层实际可绘制（checkVisibility + 祖先 overflow 裁剪链）；但 position:fixed 子元素不被祖先裁进可视区的判定不建模 transform/filter 包含块效应（当前应用未使用该组合）。',
        'html <details> 折叠区内的内容会被规则⑤ 报为隐藏（折叠态本就不该可见），属已知边界。',
        'task-10 之前的基线（2026-10-18-baseline / post-wave1 / wave2-full）的 occluded 条目是旧判据产物，不可与终版判据基线直接比较。',
        '截图只覆盖「文档横向溢出或有 high 级问题」的格子（上限 40）；无截图不代表无问题，以 JSON 为准。',
        profile.gates === 'seeded'
          ? '使用影子 profile（真实配置 + 真实数据根）启动，未开自动化横幅；与真实运行环境的差异仅限 Chromium 缓存目录。'
          : '首启闸门状态无法复制，回退 SUPERTIME_SKIP_ONBOARDING=1：界面顶部会有 1 条调试横幅（高度约 30px），相关格的视口高度因此少约 30px。',
      ],
    }
    const jsonDoc = { meta, summary, cells }
    mkdirSync(dirname(JSON_PATH), { recursive: true })
    const tmp = `${JSON_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(jsonDoc, null, 2), 'utf8')
    renameSync(tmp, JSON_PATH)
    const md = buildBaselineMarkdown(jsonDoc)
    writeFileSync(BASELINE_MD, md, 'utf8')

    // 控制台摘要
    console.log('─'.repeat(78))
    console.log(`完成：${cells.length} 格（${TABS.length} tab × ${VIEWPORTS.length} 视口），用时 ${(durationMs / 1000).toFixed(1)}s`)
    for (const rule of RULE_ORDER) {
      const s = summary.byRule[rule]
      console.log(`  ${rule.padEnd(16)} 保留 ${String(s.issues).padStart(4)} 条（检出 ${String(s.detected).padStart(4)}）  涉及 ${String(s.tabs).padStart(2)} tab / ${String(s.cells).padStart(3)} 格`)
    }
    const errCells = cells.filter((c) => c.error)
    if (errCells.length) console.log(`  ⚠ 失败格 ${errCells.length}：${errCells.slice(0, 5).map((c) => `${c.tab}@${c.viewport}`).join(', ')}`)
    if (consoleErrors.length) console.log(`  ⚠ 渲染层 console error ${consoleErrors.length} 条（前 3：${consoleErrors.slice(0, 3).join(' | ')})`)
    console.log(`\nTop offenders（前 10）：`)
    for (const [i, o] of summary.topOffenders.slice(0, 10).entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. [${o.rule}] ${o.tag}${o.cls ? '.' + o.cls.split(' ')[0] : ''}  ${o.count} 次 / ${o.tabs.length} tab  ${o.text ? `「${o.text}」` : ''}`)
    }
    console.log(`\nJSON 基线：${JSON_PATH}`)
    console.log(`Markdown 基线：${BASELINE_MD}`)
    if (shotsTaken && !NO_SHOTS) console.log(`截图：${SHOTS_DIR}（${shotsTaken} 张）`)
  } catch (e) {
    fatal = e
    console.error('\n[fatal]', e?.message ?? e)
    if (e?.stack) console.error(String(e.stack).split('\n').slice(0, 6).join('\n'))
  } finally {
    if (app) { try { await app.close() } catch { /* ignore */ } }
  }

  process.exitCode = fatal
    ? (String(fatal.message).includes('未能进入主界面') ? 3 : 1)
    : 0
}
