/**
 * 真机主题一致性审计：**在真实 Electron + 真实数据里读 computed style**，深/浅各跑一遍。
 *
 * ## 为什么这个工具必须存在（而不是每次临时写脚本）
 *
 * 「深浅主题颜色一致」这条要求的证据分三层：
 *   ① **令牌层**：两套主题的 `--nm-*` 到底解析成什么颜色 —— 由
 *      `theme-contrast.guard.spec.ts` 离线算（快、能进 CI）；
 *   ② **真机层**：跑起来的界面**实际**用的是什么颜色（面板背景是否真的随主题换）——
 *      就是本工具。离线算令牌证明不了"某块面板的背景根本没走令牌"；
 *   ③ **像素层**：截图肉眼看 —— **本仓库没有可信的实现**（见下）。
 *
 * 第 ② 层此前只有一次性脚本，命令与结论都容易丢；固化在这里之后可以随时复跑。
 *
 * ## ⚠️ 为什么不用截图当证据
 *
 * 实测过两种做法都不可靠：同一时刻截图显示"骨架屏 + 首次配置向导"，而同一进程里的
 * DOM 探针报 `nm-skel=0`、无 dialog。截图受时序/合成影响，**不能当判据**。
 * 所以本工具只读 computed style。
 *
 * ## 前置
 *
 * - `node_modules/electron/dist/electron.exe` 与 `playwright` 都在；
 * - 真实解密数据根存在（默认 `%APPDATA%/super-time-electron/wechat-data`）。
 *   临时 profile 里会写一份指向它的 `wechat/config.json` —— **漏了这一步会拿到
 *   全空面板**（每个面板只有标题和标签、一个数值都没有），那种状态极易被误读成
 *   "面板卡住"。本工具因此带**断言**：面板文本少于阈值就直接报错退出。
 *
 * 用法：`npm run theme:live-audit`（17 个可见页签）/ `npm run theme:live-audit -- --all-tabs`
 *      （**全部 37 个页签**：17 可见 + 20 隐藏，后者按 hash 路由 + reload 进入）。
 * 退出码：0 = 两套主题都验完；2 = 前置缺失；3 = 主题没生效或数据根没生效。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { seedRealProfile } from './real-profile.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e', 'theme-live-audit.txt')

/** 要逐个看的页签（真机导航里的名字）。 */
const WANT = [
  '数据总览', '微信问答', '总结', '聊天会话', '群聊分析', '通话记录', '通讯录',
  '朋友圈', '知识库', '收藏与表情', '文件与存储', '资金往来', '朋友圈洞察',
  '待办日程', '隐私体检', '操作日志',
]

/**
 * 是否连**隐藏页签**一起量（`--all-tabs`）。
 *
 * 为什么要覆盖它们：导航里渲染的只有 17 个页签，而 `nav-config.ts` 里另有 20 个
 * `hidden: true` 的**可路由页面**（用户从各面板的「详情 →」或 hash 进入）——
 * `scripts/panel-audit.mjs` 早就在截图那一遍覆盖了它们（`hidden-*.png`），
 * 但**主题一致性这一遍此前只看了 17 个**，于是"每一个用户界面"里的 20 个是盲区。
 *
 * 驱动方式与 `panel-audit.mjs` 一致：`WechatDataPanel` 只在挂载时读 `location.hash`
 * ⇒ 写 hash 后**必须 reload**。其中 4 个隐藏页签以「设置」弹窗形式打开，此时导航按钮
 * 查不到，所以等"导航按钮 **或** 弹窗"任一出现。
 */
const ALL_TABS = process.argv.includes('--all-tabs')

/**
 * 从 `nav-config.ts` 抽 `hidden: true` 的页签（与 `panel-audit.mjs:296-301` 同一口径）。
 * 读源码而不是运行时 DOM —— 隐藏项**不渲染**，DOM 里根本拿不到。
 * @returns `{ tab, label }[]`。
 */
function hiddenTabs () {
  const cfg = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts'), 'utf8')
  const out = []
  for (const ln of cfg.split(/\r?\n/)) {
    const m = /\{ tab: '([a-z]+)', label: '([^']+)'/.exec(ln)
    if (m && ln.includes('hidden: true')) out.push({ tab: m[1], label: m[2] })
  }
  return out
}

/**
 * `--stress` 的判定门槛（ms）：回访时正文超过这个时间才出现，就算慢。
 *
 * 取值依据（本机基线）：14/16 个面板回访 **~520ms**，取 3000ms ⇒ 留 **约 5.8×** 余量，
 * 不会在稍慢的机器上误报；而真正的队列积压是 **60000ms** 量级（= RPC 默认调用超时），
 * 比门槛高 **20×**，不会被漏掉。
 */
const STRESS_FAST_MS = 3000

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

if (!existsSync(EXE)) { console.error('[前置] 找不到 electron.exe：', EXE); process.exit(2) }
mkdirSync(join(ROOT, '.tmp-e2e'), { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'st-theme-'))
// **用真实 profile 的配置**（含 llm.json / secrets.json）+ 真实数据根。
// 为什么不再手写一份最小 config.json：那样临时窗口里没有模型配置，AI 面板在验收里
// 拿不到真模型；数据根写死也会指向"不是用户在用的那个盘子"（2026-09-29 用户报障）。
const seeded = seedRealProfile(userData)
const DATA = seeded.dataRoot
mkdirSync(join(userData, 'wechat'), { recursive: true })
if (!existsSync(DATA)) { console.error('[前置] 找不到真实数据根：', DATA); process.exit(2) }
console.log(`真实 profile：${seeded.source}（带入 ${seeded.copied.join('、') || '（无额外配置）'}）`)
console.log(`真实数据根：${DATA}`)

/**
 * 在页面里读一屏主题证据。**在渲染进程里执行**，所以只能用它自己的 API。
 * @returns 该面板的主题相关 computed style 摘要。
 */
const PROBE = () => {
  const root = document.documentElement
  const tokens = {}
  for (const t of ['--nm-bg-0', '--nm-bg-1', '--nm-bg-2', '--nm-text-1', '--nm-text-2', '--nm-text-3', '--nm-border', '--nm-cyan']) {
    tokens[t] = getComputedStyle(root).getPropertyValue(t).trim()
  }
  /**
   * 往下找一个**真的画了不透明背景**的祖先：`main` / `panelBody` 都是透明的，
   * 直接拿它们算对比度只会得到 n/a。
   */
  const opaqueBgOf = (el) => {
    let cur = el
    while (cur && cur !== document.documentElement) {
      const bg = getComputedStyle(cur).backgroundColor
      const m = /rgba?\(([^)]+)\)/.exec(bg)
      if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
        if (p.length >= 3 && (p.length < 4 || p[3] >= 1)) return bg
      }
      cur = cur.parentElement
    }
    return getComputedStyle(document.body).backgroundColor
  }
  const main = document.querySelector('main')
  /**
   * 从 `el` 往上走到**第一个不透明背景色**为止，途中是否夹着渐变/图片底。
   *
   * 用途见下面采样处的注释：夹了渐变就不能拿那个不透明色当"实际底色"算对比度
   * （霓虹皮肤的卡片就是这种形状），否则会产出 1.10 这类假阳性。
   * @param el - 文字所在元素。
   * @returns 途中是否出现 `background-image`。
   */
  const gradientBetween = (el) => {
    let cur = el
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true
      // 媒体元素底下的文字（视频时长角标、播放徽标这类）：真底是画面，合成不了 ⇒ n/a。
      if (cur.tagName === 'IMG' || cur.tagName === 'VIDEO' || cur.tagName === 'CANVAS') return true
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor)
      if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
        if (p.length >= 3 && (p.length < 4 || p[3] >= 1)) return false
        // 半透明 scrim（rgba 黑底压画面）：实际底色是它合成在媒体/页面之上的结果，
        // 本审计既定不做合成 ⇒ 记 n/a。2026-10-13 实测：漏掉这一支时走查会把 scrim 当透明
        // 一路跳到页面白底，白字 scrim 被算成「白字白底 1.00」的假阳性（朋友圈 light）。
        if (p.length === 4 && p[3] > 0 && p[3] < 1) return true
      }
      cur = cur.parentElement
    }
    return false
  }
  /**
   * 取样根：**优先弹窗**。
   *
   * 为什么（2026-09-29 实测）：4 个隐藏页签（数据边界与出网/备份恢复/数据库健康/原图链路自检）
   * 是以「设置」弹窗打开的，主内容区停在**上一个页面**（实测全是「数据总览」）。
   * 不优先弹窗的话，这 4 个页签量到的其实是背后那一页 —— 于是它们与「数据总览」给出
   * **一模一样**的读数（连 1.10 那个假阳性都一起复制）。那也是"量具骗人"的一种。
   */
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().height > 200)
  const panel = dialog ?? document.querySelector('main [class*=panelBody]') ?? main
  let sample = null
  /**
   * **多采样**（2026-09-29 加固）：把面板内**所有可见文本**按 `(color, 不透明祖先背景)` 去重，
   * 最多留 {@link SAMPLE_CAP} 对，连同代表文本一起回传。
   *
   * 为什么不再只取"第一个非空文本叶子"：那**只能证明一个点**。实测四份面板（知识库/年度报告/
   * 知识图谱/文件）的第一个叶子恰好都是弱化文字 `--nm-text-3`（3.75），而它们正文部分的对比度
   * 到底是 12.67 还是 3.1 ——单点采样**答不了**。多采样之后，"除弱化文字外是否全部 ≥AA"
   * 才第一次成为可判的东西。
   */
  const SAMPLE_CAP = 40
  const samples = []
  const seenPairs = new Set()
  if (panel) {
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim()
      if (t.length < 2 || !n.parentElement) continue
      if (n.parentElement.getBoundingClientRect().width <= 0) continue
      if (sample === null) sample = { el: n.parentElement, text: t.slice(0, 20) }
      const color = getComputedStyle(n.parentElement).color
      const bg = opaqueBgOf(n.parentElement)
      // ⚠️ **渐变/图片底不参与对比度计算**：`opaqueBgOf` 只会走到"最近的不透明颜色"，
      // 而霓虹皮肤（总览）的卡片是 `rgba(0,0,0,0)` + 自己的渐变 —— 于是它会把
      // 白底当成底色，算出 1.10 这种**假阳性**（真机上卡片是深蓝紫，实测见
      //  第 3 节）。凡是"文字与那个不透明底之间夹着一层
      // 渐变/图片"的对，一律标 `gradient: true`，由主进程侧跳过（记 n/a，不做合成）。
      const gradient = gradientBetween(n.parentElement)
      const key = color + '|' + bg + (gradient ? '|g' : '')
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      samples.push({ color, bg, text: t.slice(0, 24), gradient })
      if (samples.length >= SAMPLE_CAP) break
    }
  }
  // 弱化文字令牌的**当轮实值**：判定"这一对是不是弱化文字"用它比对，
  // 而不是按面板名登记（按面板登记例外只会长不会短，见 budget 脚本的注释）。
  const weakColor = getComputedStyle(root).getPropertyValue('--nm-text-3').trim()
  /**
   * **纵向填充比**（2026-09-29 新增，**只作诊断**）。
   *
   * ⚠️ 先说清楚它**不**是什么 —— 我第一版把它当成了"留白度"，那是错的：
   * 它量的是「`panelBody` 的直接子元素在面板可视区内覆盖了多少纵向空间」，
   * 而 `panelBody` 是 `flex:1 1 auto` 的**撑满容器**，子元素本身又常常是
   * 会自然增高的卡片 —— 于是**有内容的页面它接近 100%，空页面也可能不低**。
   * 实测反例：本机 `panelBody` 高度 2535px、视口 770px（内容比视口高得多），
   * 这种"滚动页"上这个比值没有"留白"的含义。
   *
   * 所以：**不要用它判断"内容多不多"**（那看 `panelTextLen`）。
   * 它只能用来发现"布局塌了"（比如某个 flex 容器高度算成 0）。
   */
  const coverageOf = (el) => {
    if (!el) return null
    const box = el.getBoundingClientRect()
    if (box.height < 10) return null
    const spans = []
    for (const child of el.children) {
      const r = child.getBoundingClientRect()
      if (r.height < 2 || r.width < 2) continue
      // 只算落在面板可视区内的部分（超出的不算"填满了"）。
      const top = Math.max(r.top, box.top)
      const bottom = Math.min(r.bottom, box.bottom)
      if (bottom > top) spans.push([top, bottom])
    }
    if (spans.length === 0) return 0
    spans.sort((a, b) => a[0] - b[0])
    let filled = 0
    let [cs, ce] = spans[0]
    for (const [s, e] of spans.slice(1)) {
      if (s > ce) { filled += ce - cs; cs = s; ce = e } else if (e > ce) ce = e
    }
    filled += ce - cs
    return filled / box.height
  }

  return {
    htmlClass: root.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    tokens,
    sampleColor: sample ? getComputedStyle(sample.el).color : '',
    sampleBg: sample ? opaqueBgOf(sample.el) : '',
    sampleText: sample ? sample.text : '',
    weakColor,
    samples,
    panelTextLen: panel ? (panel.innerText || '').length : 0,
    panelFound: panel !== null && panel !== main,
    // 留白度的反面：0 = 基本没内容，1 = 正文区被铺满。
    coverage: coverageOf(panel),
    // 有没有可见的加载指示（骨架屏/转圈）：留白 + 仍在加载 ⇒ 是"没加载完"，不是"内容少"。
    loadingVisible: [...document.querySelectorAll('[class*=skel], [class*=spinner], [class*=loading]')]
      .some((e) => e.getBoundingClientRect().height > 4),
  }
}

/** WCAG 对比度（只处理不透明 rgb()）。 */
function contrastOf (a, b) {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (p.length < 3 || p.slice(0, 3).some((x) => Number.isNaN(x))) return null
    return p.length < 4 || p[3] >= 1 ? p.slice(0, 3) : null
  }
  const fg = parse(a); const bg = parse(b)
  if (fg === null || bg === null) return null
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const A = lum(fg); const B = lum(bg)
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05)
}

/**
 * 把"多采样"收敛成两个数：**含弱化文字的最低对比度**与**除弱化文字外的最低对比度**。
 *
 * 为什么分两条：深色端弱化文字 `--nm-text-3` 是仓库**早已记录并决策接受**的低对比
 * （`ui/kit.module.css:34-37`：内容类文字改用 `--text-2`，不动令牌值）。
 * 如果把它和正文混在一个最低值里，门槛就永远卡在 3.75，什么都发现不了；
 * 分开之后，"正文有没有掉到 AA 以下"才成为可判的东西 —— 而它此前**完全没有被量过**。
 * @param r - 单个面板单套主题的探针结果。
 * @returns `{ worstAny, worstContent, pairs }`。
 */
function reduceSamples (r) {
  const list = Array.isArray(r?.samples) ? r.samples : []
  const weak = String(r?.weakColor ?? '').trim()
  let worstAny = null
  let worstContent = null
  for (const s of list) {
    // 夹着渐变/图片底的对**不参与计算**（记 n/a）：拿它背后的不透明色当底色会产出假阳性，
    // 而真正的底色是渐变，逐点合成只会得到一个更精致却同样错的数。
    if (s.gradient === true) continue
    const c = contrastOf(s.color, s.bg)
    if (c === null) continue
    const item = { contrast: c, color: s.color, bg: s.bg, text: s.text }
    if (worstAny === null || c < worstAny.contrast) worstAny = item
    // 弱化文字：颜色与当轮 `--nm-text-3` 的实值一致（含透明度差异，比 rgb 三段）。
    const norm = (x) => (x.match(/[\d.]+/g) ?? []).slice(0, 3).join(',')
    const isWeak = weak !== '' && norm(s.color) === norm(weak)
    if (!isWeak && (worstContent === null || c < worstContent.contrast)) worstContent = item
  }
  return { worstAny, worstContent, pairs: list.length }
}

const log = []
const say = (s) => { log.push(s); console.log(s) }

let app = null
let exitCode = 0
try {
  const launchEnv = { ...process.env }
  // 必须摘掉：否则 Electron 退化成纯 node、没有窗口（panel-audit.mjs:135-141 的既有教训）。
  delete launchEnv.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: { ...launchEnv, SUPERTIME_USER_DATA_DIR: userData, SUPERTIME_SKIP_ONBOARDING: '1', SUPERTIME_TEST_MODE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(45000)
  await win.waitForLoadState('domcontentloaded')

  const results = { dark: {}, light: {} }
  /** 隐藏页签的 label → tab（落盘时带上，便于把面板名映射回路由）。 */
  const hiddenMeta = {}
  const hidden = ALL_TABS ? hiddenTabs() : []
  if (ALL_TABS) say(`\n隐藏页签 ${String(hidden.length)} 个将一并量：${hidden.map((h) => `${h.label}(${h.tab})`).join('、')}`)
  else say('\n（本次不量隐藏页签；加 `--all-tabs` 可覆盖 `nav-config.ts` 里全部 37 个页签）')

  // ── 可选：切页签压力测试（`--stress`） ─────────────────────────────────────
  //
  // 为什么要有它：2026-09-29 实测发现「按顺序连点 12 个页签后，点『朋友圈洞察』要等
  // **60 秒**才出内容」—— 根因不是该面板慢（直连 512ms），而是它的请求排在**串行
  // worker 的队列尾部**等出来的（原 PERF-THEME-LEDGER 文档的「三点五」节，已删除，原文见 git 历史）。
  // 那次是手工脚本临时跑出来的；这个模式把它变成**每次可量、可对比**的数。
  //
  // 它量的是"**加载态持续多久**"：点进每个页签后立刻切走（模拟"快速浏览"），
  // 再回来记录正文从点击到出现（>50 字）的耗时。60s 这个数字有特殊意义 ——
  // 它正好是 RPC 默认调用超时（src/backend/backend-rpc.js:18），
  // 到了这个数说明请求是"排到超时窗口才轮到自己"。
  if (process.argv.includes('--stress')) {
    say('')
    say('=== 切页签压力测试（连点后各面板的加载态持续时长）===')
    const seq = WANT
    const clickTab = async (l) => win.evaluate((x) => {
      const nav = document.querySelector('aside nav') || document.querySelector('nav')
      const b = nav ? [...nav.querySelectorAll('button')].find((y) => (y.getAttribute('title') || y.textContent || '').trim() === x) : undefined
      if (b) b.click()
    }, l)
    const bodyLen = () => win.evaluate(() => {
      const pb = document.querySelector('[class*=panelBody]')
      const el = pb ?? document.querySelector('main')
      return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().length : -1
    })

    const timings = []
    for (const label of seq) {
      // 连点：给 1.2s 就切下一个 —— 比真人快，用来把队列压起来。
      await clickTab(label)
      await sleep(1200)
      timings.push({ label, quickLen: await bodyLen() })
    }
    // 连点结束后立刻抓一次"谁还在加载态" —— 这些就是**在途请求**的来源，
    // 也是把队列压住的候选。公开它，才能在数量上定位触发门槛。
    const inFlight = await win.evaluate(() => {
      const pb = document.querySelector('[class*=panelBody]')
      const el = pb ?? document.querySelector('main')
      const txt = el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : ''
      return {
        len: txt.length,
        loading: [...document.querySelectorAll('[class*=skel], [class*=spinner], [class*=loading]')].some((e) => e.getBoundingClientRect().height > 4),
        head: txt.slice(0, 40),
      }
    })
    const stillLoading = timings.filter((t) => t.quickLen < 50 && t.quickLen >= 0)
    say('')
    say(`连点结束时仍停在加载态的面板（正文 <50 字）: ${stillLoading.length === 0 ? '无' : stillLoading.map((t) => `${t.label}(${t.quickLen})`).join('、')}`)
    say(`当前屏（连点停在「${seq[seq.length - 1]}」）: len=${inFlight.len} loading=${inFlight.loading ? 'Y' : 'N'} :: ${inFlight.head}`)
    // 再逐个回访，量"回来时多久能出内容"。
    for (const t of timings) {
      const t0 = Date.now()
      await clickTab(t.label)
      let ms = -1
      let len = 0
      for (let i = 0; i < 150; i++) {
        await sleep(500)
        len = await bodyLen()
        if (len > 50) { ms = Date.now() - t0; break }
      }
      t.revisitMs = ms
      t.revisitLen = len
      say(`  ${t.label.padEnd(10)} 连点时正文=${String(t.quickLen).padStart(5)}  回访出内容=${ms < 0 ? '>40s 未出' : String(ms) + 'ms'}  len=${len}`)
    }
    const slow = timings.filter((t) => t.revisitMs < 0 || t.revisitMs > STRESS_FAST_MS)
    say('')
    say(`回访超过 ${String(STRESS_FAST_MS / 1000)}s 或始终不出的面板: ${slow.length === 0 ? '无' : slow.map((t) => `${t.label}(${t.revisitMs < 0 ? '未出' : String(t.revisitMs) + 'ms'})`).join('、')}`)
    say('')
    say(`门槛：${String(STRESS_FAST_MS / 1000)}s（基线实测 14/16 个面板 ~520ms，留约 5.8× 余量；`)
    say('      超时窗口是 60s ⇒ 真正的队列积压会比门槛高 20×，不会被这条误判）。')

    /**
     * 把逐面板耗时**落盘成机器可读**（2026-09-29 第 82 轮新增）。
     *
     * 为什么必须落盘：这组数是**唯一可信的"用户视角"指标**（点击 → 正文出现），
     * 但此前只打印到控制台 ⇒ **没有任何门禁能核对它**。
     * 而 `STRESS_FAST_MS = 3000` 这条门槛太松：基线 ~520ms，**退化到 2900ms 也不会报**
     * （5.8× 余量是有意留给慢机器的，不是给回归留的）。
     * 落盘之后，`scripts/interactive-budget.mjs` 就能用**紧得多的预算**逐面板核对，
     * 且**门槛与测量分离** —— 改门槛只动 JSON，不碰测量代码。
     */
    const timingOut = join(ROOT, '.tmp-e2e', 'interactive-timings.json')
    writeFileSync(timingOut, JSON.stringify({
      generatedAt: new Date().toISOString(),
      // 口径说明随数据一起落盘：看数据的人不该去翻代码才知道这一列量的是什么。
      metric: 'click→content(ms)：点下页签后，正文（>50 字）出现所经过的墙钟时间；<0 表示 40s 内未出',
      panels: timings.map((t) => ({ label: t.label, clickToContentMs: t.revisitMs, quickLen: t.quickLen, contentLen: t.revisitLen })),
    }, null, 2) + '\n', 'utf8')
    say(`逐面板耗时已落盘：${timingOut}`)
    // 已知例外：这两个面板排在队尾、要等队列排干（>=60s）。它们**不是缺陷本身**，
    // 而是"串行 worker 队列深度"这个已知架构问题的**观测窗口**（见账本三点五）。
    const knownTail = new Set(['朋友圈洞察', '收藏与表情'])
    const unexpected = slow.filter((t) => !knownTail.has(t.label))
    const tailHit = slow.filter((t) => knownTail.has(t.label))
    say(`  其中已登记为"队尾"的: ${tailHit.length === 0 ? '无' : tailHit.map((t) => t.label).join('、')}（退出码不计）`)
    if (unexpected.length > 0) {
      say(`  !! 未登记的慢面板: ${unexpected.map((t) => `${t.label}(${t.revisitMs < 0 ? '未出' : String(t.revisitMs) + 'ms'})`).join('、')}`)
      exitCode = 4
    }
    say('注：本模式进退出码（4 = 出现未登记的慢面板）。')
    say('    "已登记为队尾"的那两个：串行 worker 队列排满时它们延迟到 60s 超时窗口才返回，')
    say('    这是**已知且已定性**的架构问题（修法=取消在途请求/多 worker，超出逐接口优化范围）。')
    say('    若哪天它们不再慢（比如做了取消在途请求），请把名字从 knownTail 删掉。')
  }

  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => { localStorage.setItem('super-time-wechat-theme', t) }, theme)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await sleep(1500)
    // 断言①：主题**真的**换过去了。曾经因为没断，两轮都停在浅色 ⇒ "dark 列"其实是浅色数据。
    const applied = String(await win.evaluate(() => document.documentElement.className))
    const ok = applied.includes('theme-light') === (theme === 'light')
    say(`[主题切换] 请求=${theme} htmlClass="${applied}" ⇒ ${ok ? 'OK' : '!! 未生效'}`)
    if (!ok) { exitCode = 3; break }

    const tabs = await win.evaluate(() => {
      const nav = document.querySelector('aside nav') || document.querySelector('nav')
      return nav ? [...nav.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean) : []
    })
    await sleep(4000)
    for (const label of tabs.filter((t) => WANT.includes(t))) {
      await win.evaluate((l) => {
        const nav = document.querySelector('aside nav') || document.querySelector('nav')
        const btn = nav ? [...nav.querySelectorAll('button')].find((b) => (b.getAttribute('title') || b.textContent || '').trim() === l) : undefined
        if (btn) btn.click()
      }, label)
      // ⚠️ 每格等久一点：原先 2.5s，实测**不够** —— 「朋友圈洞察」在这种等待下被读成
      // 「正文 4 个字符、填充比 8%」，看着像空面板；单独直连同一个面板 1s 后就有
      // 2199 字符（"📝 2708 发布 ❤️ 685 获赞…"）。那是**我的探针在切页动画中途取样**，
      // 不是面板缺陷。5s 是有余量的取值（面板最重的取数在 1s 内就完成了）。
      await sleep(5000)
      results[theme][label] = await win.evaluate(PROBE)
    }

    // ── 隐藏页签（`--all-tabs`）：hash 路由 + reload ──────────────────────────
    if (ALL_TABS) {
      for (const h of hidden) {
        try {
          await win.evaluate((t) => { location.hash = '#' + t }, h.tab)
          await win.reload({ waitUntil: 'domcontentloaded' })
          // 4 个隐藏页签会以「设置」弹窗打开：Radix 把主内容区设成 aria-hidden，导航按钮查不到
          // ⇒ 等"导航按钮 **或** 弹窗"任一出现（panel-audit.mjs:311-314 的既有教训）。
          await Promise.race([
            win.getByRole('button', { name: '数据总览', exact: true }).waitFor({ state: 'visible', timeout: 60000 }),
            win.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 60000 }),
          ])
          // 壳挂上 ≠ 页签内容挂上：等到确实有内容再取样（否则量到的是空壳的底色）。
          for (let i = 0; i < 40; i++) {
            const len = await win.evaluate(() => {
              const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().height > 200)
              const sc = dlg ?? document.querySelector('main [class*=panelBody]') ?? document.querySelector('main')
              return (sc?.innerText ?? '').trim().length
            })
            if (len > 50) break
            await sleep(500)
          }
          await sleep(2000)
          results[theme][h.label] = await win.evaluate(PROBE)
          hiddenMeta[h.label] = h.tab
          say(`  [隐藏页签] ${h.label}(${h.tab}) 采样完成：正文 ${String(results[theme][h.label].panelTextLen)} 字`)
        } catch (e) {
          say(`  [隐藏页签] ${h.label}(${h.tab}) **取样失败**：${(e.message || String(e)).split('\n')[0].slice(0, 80)}`)
        }
      }
      // 别把隐藏页签的 hash 留给下一轮主题（否则下一轮一开始就停在隐藏页上）。
      await win.evaluate(() => { location.hash = '#overview' })
    }
  }

  const anyLabel = Object.keys(results.dark)[0] ?? Object.keys(results.light)[0]
  if (anyLabel === undefined) { say('!! 没读到任何面板 —— 数据根可能没生效'); exitCode = 3 } else {
    say('')
    say('=== 令牌解析值（两套主题）===')
    for (const t of Object.keys(results.dark[anyLabel]?.tokens ?? results.light[anyLabel].tokens)) {
      say(`  ${t.padEnd(14)} dark=${String(results.dark[anyLabel]?.tokens[t] ?? '-').padEnd(22)} light=${results.light[anyLabel].tokens[t]}`)
    }
    say('')
    say('=== 逐面板：采样背景是否随主题变化 + 对比度 ===')
    say('  ' + '面板'.padEnd(12) + 'dark 采样底'.padEnd(22) + 'light 采样底'.padEnd(22) + '随主题变?'.padEnd(11) + 'dark正文'.padEnd(9) + 'light正文'.padEnd(9) + 'dark最低')
    let unchanged = 0
    const lowContrast = []
    for (const label of Object.keys(results.dark)) {
      const d = results.dark[label]; const l = results.light[label]
      if (!l) continue
      const changed = d.sampleBg !== l.sampleBg
      if (!changed) unchanged += 1
      const rd = reduceSamples(d); const rl = reduceSamples(l)
      const cd = rd.worstContent?.contrast ?? null
      const cl = rl.worstContent?.contrast ?? null
      if (cd !== null && cd < 4.5) lowContrast.push(`${label} dark=${cd.toFixed(2)}`)
      if (cl !== null && cl < 4.5) lowContrast.push(`${label} light=${cl.toFixed(2)}`)
      say('  ' + label.padEnd(12) + String(d.sampleBg).padEnd(22) + String(l.sampleBg).padEnd(22)
        + (changed ? '是' : '否').padEnd(11)
        + (cd === null ? 'n/a' : cd.toFixed(2)).padEnd(9) + (cl === null ? 'n/a' : cl.toFixed(2)).padEnd(9)
        + (rd.worstAny === null ? 'n/a' : '(' + rd.worstAny.contrast.toFixed(2) + ' 弱化)'))
    }
    say('')
    say(`采样背景未随主题变化的面板: ${String(unchanged)} 个（0 才说明覆盖生效）`)
    say('注：**dark正文 / light正文** 两列 = 面板内**除弱化文字（`--nm-text-3`）外**最差的采样对比度；')
    say('    括号里的数是**含弱化文字**的最低值 —— 深色端弱化文字 3.75 是仓库早已登记的取舍，')
    say('    所以门槛只压在"正文"这两列上（见 scripts/theme-contrast-budget.mjs）。')
    say(`正文类对比度 <4.5: ${lowContrast.length === 0 ? '无' : lowContrast.join(' | ')}`)

    /**
     * 把逐面板对比度**落盘成机器可读**（2026-09-29 第 83 轮新增）。
     *
     * 为什么：上面这两行只是**打印**（`未随主题变化: N 个` / `对比度 <4.5: …`），
     * **既不落盘也不进退出码** ⇒ 主题一致性在真机这一侧**没有任何门禁**。
     * 而离线守卫（`theme-contrast.guard.spec.ts`）算的是**令牌自身**，
     * 证明不了"面板真的用了这套令牌"（第 75/76 轮那个 `--wx-*` 盲区就是这么来的）。
     *
     * 落盘之后，`scripts/theme-contrast-budget.mjs` 就能逐面板核对
     * **对比度数值**，而不是只看"变没变"这一个布尔。
     */
    const contrastOut = join(ROOT, '.tmp-e2e', 'theme-contrast.json')
    writeFileSync(contrastOut, JSON.stringify({
      generatedAt: new Date().toISOString(),
      metric: '多采样：面板内所有可见文本按 (color, 不透明祖先背景) 去重（上限 40 对），'
        + 'contrast = 除弱化文字（--nm-text-3）外的最低 WCAG 对比度；'
        + 'worstAny = 含弱化文字的最低值；alpha<1 的背景不参与合成（该对记 null）',
      panels: Object.keys(results.dark).map((label) => {
        const d = results.dark[label]; const l = results.light[label]
        const rd = reduceSamples(d); const rl = reduceSamples(l)
        const pack = (r, red) => ({
          // `contrast` 保持旧字段名，语义升级为"**正文类**最低对比度"（含弱化文字的最低值见 worstAny）。
          contrast: red.worstContent === null ? null : red.worstContent.contrast,
          color: red.worstContent?.color ?? r?.sampleColor ?? null,
          bg: red.worstContent?.bg ?? r?.sampleBg ?? null,
          text: red.worstContent?.text ?? r?.sampleText ?? null,
          worstAny: red.worstAny === null ? null : red.worstAny.contrast,
          worstAnyText: red.worstAny?.text ?? null,
          sampledPairs: red.pairs,
        })
        return {
          label,
          ...(hiddenMeta[label] !== undefined ? { tab: hiddenMeta[label], hidden: true } : {}),
          dark: pack(d, rd),
          light: pack(l, rl),
          themeChanged: d !== undefined && l !== undefined && d.sampleBg !== l.sampleBg,
        }
      }),
    }, null, 2) + '\n', 'utf8')
    say(`逐面板对比度已落盘：${contrastOut}`)

    // ── 纵向填充比（只作诊断，见 PROBE 里的说明） ──────────────────────────
    say('')
    say('=== 纵向填充比（**只发现布局塌陷**，不能用来判断"内容多少"）===')
    say('  ' + '面板'.padEnd(12) + '填充比'.padEnd(9) + '正文长度'.padEnd(10) + '在加载中'.padEnd(10) + '备注')
    const sparse = []
    const loading = []
    for (const label of Object.keys(results.dark)) {
      const d = results.dark[label]
      const pct = d.coverage === null || d.coverage === undefined ? 'n/a' : (d.coverage * 100).toFixed(0) + '%'
      const note = []
      if (d.panelFound !== true) note.push('未找到 panelBody（用 main 兜底 ⇒ 这一格的比值无意义）')
      if (d.loadingVisible === true) { note.push('仍有加载指示'); loading.push(label) }
      // ⚠️ 只在**真的找到 panelBody** 时才敢谈"填充比"：兜底到 main 的那几格量的是外壳布局。
      if (d.panelFound === true && typeof d.coverage === 'number' && d.coverage < 0.15) sparse.push(label)
      say('  ' + label.padEnd(12) + pct.padEnd(9) + String(d.panelTextLen).padEnd(10)
        + (d.loadingVisible === true ? '是' : '否').padEnd(10) + note.join('；'))
    }
    say('')
    say(`仍然显示加载指示的面板: ${loading.length === 0 ? '无' : loading.join('、')}`)
    say(`填充比 <15%（且确实找到了 panelBody）: ${sparse.length === 0 ? '无' : sparse.join('、')}`)
    say('')
    say('⚠️ 已知（**已定性**，2026-09-29）：「朋友圈洞察」「收藏与表情」在本工具连点页签时')
    say('    会停在加载态，并在**恰好 60s** 一次性出内容（实测 60055ms / 60292ms）。')
    say('    60s 正是 RPC 默认调用超时（src/backend/backend-rpc.js:18）⇒ 不是"卡死"，')
    say('    而是**请求排在串行 worker 队列尾部、等到超时窗口才轮到自己**。')
    say('    已排除：面板自身慢（直连 516ms）、点击路径相关（三条路径 512–529ms）、')
    say('    少量前置页签（2 个 → 524ms）、渲染问题（压力下 panelBody 只有加载态一个子元素）。')
    say('    触发条件是"**先访问约 10 个以上面板**"。用 `--stress` 可复跑并看到门槛。')
    say('    对**已登记队尾**的面板不计退出码；但**未登记**的慢面板会以退出码 4 报出 ⇒')
    say('    由"串行 worker 队列深度"以外的原因造成的慢，不会被这条放过。架构级修法')
    say('    （取消在途请求 / 多 worker）超出"逐接口优化"范围，且现场日志里没有这个形状。')
    say('    原 PERF-THEME-LEDGER 文档第三节五（已删除，原文见 git 历史）。')
    say('')
    say('注：**"填充比低"不等于"面板空"**。这个比值在"内容高于视口的滚动页"上没有留白含义')
    say('    （本机实测 panelBody 高 2535px vs 视口 770px）。判断内容多少请看"正文长度"列。')
    say('    判"可疑"要求**既低又不在加载中**，避免把"还没加载完"误报成"空面板"')
    say('    （这类误读在 2026-09 犯过一次：漏写 wechat/config.json 导致全空面板，见账本陷阱③）。')
    say('')
    say('注：采样是**多采样**——面板内所有可见文本按 `(color, 背景)` 去重（上限 40 对）；')
    say('    夹着渐变/图片底的对记 n/a（不做合成，避免霓虹皮肤那种假阳性）；')
    say('    弹窗类页签取「设置」弹窗本身，不取它背后那一页。')
    say('    token×token 的完整对比度矩阵由 theme-contrast.guard.spec.ts 离线覆盖。')
    if (unchanged > 0) exitCode = 3
  }
} finally {
  writeFileSync(OUT, log.join('\n') + '\n', 'utf8')
  if (app !== null) await app.close().catch(() => { /* 尽力 */ })
  rmSync(userData, { recursive: true, force: true })
  console.log('\n报告：' + OUT)
}
process.exit(exitCode)
