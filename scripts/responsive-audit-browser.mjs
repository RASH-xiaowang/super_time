/**
 * 手机浏览器（局域网远程访问）响应式审计 · **真实 system Chrome × 四档手机视口**。
 *
 * 与桌面版 `scripts/responsive-audit.mjs` 的分工：
 *   · 桌面版：真实 Electron 窗口（`file://` + preload 桥）+ 6 档窗口尺寸 × 38 tab；
 *   · 本脚本：真实 **system Chrome**（`channel:'chrome'`）打开 `http://127.0.0.1:<port>/`
 *     —— 也就是手机连同一局域网时走的**同一条真实路径**（HTTP 服务 + `/api/auth` 令牌换
 *     Cookie + `/api/wechat/call` 远程调用 + SSE），在 375×667 / 390×844 / 414×896 /
 *     844×390 四档手机视口跑**同口径的五类布局检测**。
 *
 * ## 为什么必须单独一套（不是改桌面审计的参数）
 *   ① 浏览器模式下 **没有 Electron preload 桥**：`capabilities.isBrowser` 为真，标题栏被移除、
 *      三道本地闸门被跳过、换成 `BrowserSession` 令牌门 —— DOM 与 Electron 不是同一棵；
 *   ② 手机浏览器有真实的**动态视口**（地址栏收起/展开 → `vh` 变化）与**安全区**（刘海/手势条），
 *      这两件事在 Electron 窗口里恒等于 0，桌面审计永远测不出来；
 *   ③ 触摸目标 / hover-only 交互 / 输入法遮挡只在触摸设备上成立。
 *   所以：五类布局规则复用桌面检测器（`scripts/responsive-audit/detector.mjs` 的 `AUDIT_PAGE`，
 *   **不复制逻辑**），另外加一层浏览器特有问题探针 `PROBE_MOBILE`（本文件内）。
 *
 * ## 影子 profile + 影子数据根（绝不写用户真实配置）
 *   1. **userData**：与桌面审计同一套播种（`setup.mjs` 的 `seedProfile`）—— 复制真实
 *      `wechat/*.json` / `Local Storage` / `license.json` 到 `.tmp-e2e/browser-audit-profile/`，
 *      绕开单实例锁与首启闸门；真实 userData 一个字节都不写。
 *   2. **dataRoot**：远程访问的 `api_enabled` / `api_port` / `api_token` 住在**数据根**下
 *      （`<dataRoot>/config.json` + `secrets.json`，见 `src/backend/http-server.js` 的
 *      `readRemoteAccessConfig`），真实数据根里没有 `api_token`（用户没启用过远程访问）。
 *      为了不在真实数据根里塞临时令牌，本脚本播种一个**影子数据根**
 *      `.tmp-e2e/browser-audit-data/`：
 *        · `<root>/config.json` / `secrets.json` / 根级派生库：从真实数据根**复制**（首次），
 *          然后只改 `api_enabled:true` / `api_port` / `api_token`（每次运行重写）；
 *        · `decrypted/`、`whisper/`：**目录联接**（junction）到真实目录 —— 只读用途、体积 435MB/84MB
 *          不值得复制；
 *        · `decoded_images/`：首次**复制**（43MB）—— 图片解码会写缓存，写到影子副本里更干净。
 *      然后把影子 profile 的 `resolved.dataRoot` 指向影子数据根。于是：真实 userData 不写、
 *      真实数据根的配置不写，面板读到的仍是同一份真实数据（DB 经联接/副本读）。
 *
 * ## 四档视口与 `--selftest`
 *   默认 375×667 / 390×844 / 414×896 / 844×390（横屏）。视口通过 Playwright
 *   `page.setViewportSize` 逐档切换（同一 Chrome 上下文；Cookie 只登录一次）。
 *
 * ## 用法
 *   node scripts/responsive-audit-browser.mjs                       # 全量：38 tab × 4 档（≈4–6 分钟）
 *   node scripts/responsive-audit-browser.mjs --quick               # 只跑 390×844 + 844×390
 *   node scripts/responsive-audit-browser.mjs --only=overview,annual --viewports=375x667,844x390
 *   node scripts/responsive-audit-browser.mjs --selftest            # 检测器自检（5 类规则 + 浏览器探针 + cutout 夹具 = 7/7）
 *   node scripts/responsive-audit-browser.mjs --headed              # 显示真实 Chrome 窗口（人工观察）
 *   node scripts/responsive-audit-browser.mjs --cutout              # Wave 4：刘海/安全区矩阵（10 tab × 3 档，CDP 注入 env）
 *   node scripts/responsive-audit-browser.mjs --dynamic-toolbar     # Wave 4：地址栏收/展（375×667 ↔ 375×735）
 *
 * 模块拆分（M21 单文件 ≤1000 行）：`scripts/responsive-audit-browser/{config,probe,emulate,summary}.mjs`。
 * 常用参数：`--only=a,b` / `--viewports=WxH,...` / `--quick` / `--label=NAME` / `--out=DIR`
 *   / `--report-dir=DIR` / `--profile=DIR` / `--data-farm=DIR` / `--user-data=DIR`
 *   / `--port=5032`（期望端口，实际端口在 5032–5042 内自动探测）/ `--no-shots` / `--max-shots=N`
 *   / `--tab-wait=MS` / `--refresh-farm`（重新从真实数据根复制根级库）
 *   / `--keep-open`（跑完不关闭浏览器，便于人工看）/ `--device-scale=3`。
 *
 * 产物：`working/team/responsive/browser/<label>.json` + `.../shots/browser-<label>-*.jpg`
 *   + 控制台矩阵与 Top offenders。`--report-dir` 只用于报告类产物（当前不写自动 Markdown，
 *   人工报告见 `working/team/lan-mobile-report.md`）。
 *
 * 退出码：0 = 跑完（有问题也是基线，不算失败）；2 = 前置缺失；3 = 应用/浏览器未能就绪；1 = 脚本异常。
 *
 * ⚠️ 已知局限（报告里同口径复述）：
 *   · 明文 HTTP + 同一台机器上的 Chrome 模拟 —— 真机的地址栏高度、刘海、输入法、触摸滚动惯性
 *     与这里仍有差异；真机复核见 Wave 3 的手工清单。
 *   · 无头 Chrome 里 `env(safe-area-inset-*)` 恒为 0（没有物理安全区），只能验证「CSS 有没有
 *     消费 env()」，验证不了具体数值。
 *   · 输入法遮挡只能结构性检查（fixed 底栏高度占比），无法唤起真实软键盘。
 *   · 动态视口抖动用「切换视口高度后布局是否还装得下」近似，不能模拟地址栏收起的逐帧过程。
 *
 * @module scripts/responsive-audit-browser
 */
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync,
  copyFileSync, cpSync, symlinkSync, renameSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import {
  ROOT, EXE, hasFlag, opt, optInt, THRESHOLDS, RULE_ORDER,
  parseTabs, slug, defaultLabel, sleep, gitHead, detectUserDataDir, seedProfile,
} from './responsive-audit/setup.mjs'
import { AUDIT_PAGE } from './responsive-audit/detector.mjs'
import { buildSummary } from './responsive-audit/report.mjs'
// Wave 3 拆分：页面内专项探针 / 汇总打印（检测与输出逻辑一字未改）
import { PROBE_MOBILE } from './responsive-audit-browser/probe.mjs'
import { summarizeMobile, printBrowserSummary } from './responsive-audit-browser/summary.mjs'
// Wave 4：刘海/安全区 + 动态地址栏的 CDP 仿真（详见该模块文件头）
import {
  CUTOUT_PROFILES, SAFE_AREA_TABS, DYNAMIC_TOOLBAR_SIZES,
  detectSafeAreaSupport, applySafeArea, clearSafeArea,
  summarizeSafeArea, printSafeAreaSummary, collectSafeAreaCells,
  collectDynamicCells, summarizeDynamic, printDynamicSummary,
} from './responsive-audit-browser/emulate.mjs'

// Wave 3 拆分：视口常量与视口解析
import {
  MOBILE_UA, SCREENSHOT_QUALITY, parseBrowserViewports,
} from './responsive-audit-browser/config.mjs'

// ══════════════════════════════════════════════════════════════════════════
// 命令行（依赖 process.argv 与仓库路径的派生量；纯常量见 config.mjs）
// ══════════════════════════════════════════════════════════════════════════
const LABEL = opt('label', defaultLabel())
const OUT_DIR = resolve(ROOT, opt('out', join('working', 'team', 'responsive', 'browser')))
const SHOTS_DIR = join(OUT_DIR, 'shots')
const PROFILE_DIR = resolve(ROOT, opt('profile', join('.tmp-e2e', 'browser-audit-profile')))
const FARM_DIR = resolve(ROOT, opt('data-farm', join('.tmp-e2e', 'browser-audit-data')))
const PREFERRED_PORT = optInt('port', 5032)
const PORT_ATTEMPTS = 11
const DEVICE_SCALE = Number(opt('device-scale', '3')) || 3
const HEADED = hasFlag('headed')
const SELFTEST = hasFlag('selftest')
const NO_SHOTS = hasFlag('no-shots') || hasFlag('selftest')
const MAX_SHOTS = optInt('max-shots', 40)
const REFRESH_FARM = hasFlag('refresh-farm')
const KEEP_OPEN = hasFlag('keep-open')

/** 以 `/api/auth` 探测端口时必须带 Host 头；服务端只接受它绑定的地址（127.0.0.1 或 localhost）。 */
const HOST = '127.0.0.1'


// ══════════════════════════════════════════════════════════════════════════
// 影子数据根（remote access 配置的隔离）
// ══════════════════════════════════════════════════════════════════════════

/** 影子数据根里**首次复制**的目录（图片解码会写缓存，复制一份隔离写）。 */
const FARM_COPY_DIRS = new Set(['decoded_images'])

/**
 * 从真实 profile 配置里读真实数据根。
 * @param {string} srcUserData - 真实 userData。
 * @returns {string} 数据根绝对路径（读不到返回空串）。
 */
function resolveRealDataRoot (srcUserData) {
  try {
    const cfg = JSON.parse(readFileSync(join(srcUserData, 'wechat', 'config.json'), 'utf8'))
    if (typeof cfg?.resolved?.dataRoot === 'string' && cfg.resolved.dataRoot !== '') return cfg.resolved.dataRoot
    if (typeof cfg?.dataRoot === 'string' && cfg.dataRoot !== '') return cfg.dataRoot
  } catch { /* 下面兜底 */ }
  const fallback = join(homedir(), '.dsh', 'wechat-data')
  return existsSync(join(fallback, 'config.json')) ? fallback : ''
}

/** 从真实数据根把「配置/根级派生库」复制到影子数据根；目录按 LINK/COPY 策略处理。 */
function syncFarmTree (farmRoot, realRoot) {
  const created = { links: [], copies: [], files: [] }
  let entries = []
  try { entries = readdirSync(realRoot, { withFileTypes: true }) } catch (e) {
    throw new Error(`读不到真实数据根 ${realRoot}：${e.code ?? e.message}`)
  }
  for (const entry of entries) {
    if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue // SQLite 运行期产物不复制
    const from = join(realRoot, entry.name)
    const to = join(farmRoot, entry.name)
    if (entry.isDirectory()) {
      if (existsSync(to)) continue
      if (FARM_COPY_DIRS.has(entry.name)) {
        cpSync(from, to, { recursive: true })
        created.copies.push(entry.name)
      } else {
        // `decrypted` / `whisper` 以及未来新增的目录：一律**目录联接**（只读假设）。
        // 复制 435MB 的解密库只会拖慢每次启动，而联合目录对应用完全透明。
        symlinkSync(from, to, 'junction')
        created.links.push(entry.name)
      }
    } else if (!existsSync(to)) {
      copyFileSync(from, to)
      created.files.push(entry.name)
    }
  }
  return created
}

/**
 * 准备影子数据根：迁数据（首次）→ 每次覆盖 config.json/secrets.json 打开远程访问。
 *
 * 只改**影子**数据根里的这两个文件；真实数据根本身是只读来源。
 * @param {{farmRoot:string, realRoot:string, token:string, preferredPort:number, refresh:boolean}} opts
 * @returns {{root:string, token:string, port:number, created:object, warnings:string[]}}
 */
function prepareDataFarm (opts) {
  const { farmRoot, realRoot, token, preferredPort, refresh } = opts
  const warnings = []
  if (!existsSync(join(realRoot, 'config.json'))) throw new Error(`真实数据根缺少 config.json：${realRoot}`)
  mkdirSync(farmRoot, { recursive: true })
  if (refresh) {
    // 只重刷配置类文件（根级 .db 保留缓存，避免每次复制 164MB 归档库）。
    for (const name of ['config.json', 'secrets.json', 'keys.json', 'all_keys.json', 'sync-state.json']) {
      const from = join(realRoot, name)
      if (existsSync(from)) copyFileSync(from, join(farmRoot, name))
    }
  }
  const created = syncFarmTree(farmRoot, realRoot)
  if (created.links.length > 0) warnings.push(`目录联接（指向真实数据根，只读用途）：${created.links.join(' / ')}`)
  if (created.copies.length > 0) warnings.push(`首次复制目录：${created.copies.join(' / ')}`)
  if (created.files.length > 0) warnings.push(`首次复制根级文件：${created.files.join(' / ')}`)

  // 每次运行都从真实数据根取一份干净的 config/secrets 再打补丁（避免上一轮写脏的值残留）。
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(join(realRoot, 'config.json'), 'utf8')) } catch { /* 上面已校验 */ }
  cfg.api_enabled = true
  cfg.api_port = preferredPort
  writeFileSync(join(farmRoot, 'config.json'), JSON.stringify(cfg, null, 2) + '\n')

  let secrets = {}
  try { secrets = JSON.parse(readFileSync(join(realRoot, 'secrets.json'), 'utf8')) } catch { warnings.push('真实数据根没有可解析的 secrets.json（新建一份）') }
  secrets.api_token = token
  writeFileSync(join(farmRoot, 'secrets.json'), JSON.stringify(secrets, null, 2) + '\n')

  return { root: farmRoot, token, port: preferredPort, created, warnings }
}

/**
 * 把影子 profile 的 dataRoot 系列字段指到影子数据根（应用启动时按这份配置解析数据根）。
 * @param {string} profileDir - 影子 userData。
 * @param {string} farmRoot - 影子数据根。
 */
function patchProfileDataRoot (profileDir, farmRoot) {
  const cfgPath = join(profileDir, 'wechat', 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { /* seedProfile 已保证存在 */ }
  const decrypted = join(farmRoot, 'decrypted')
  const decoded = join(farmRoot, 'decoded_images')
  cfg.resolved = { ...(cfg.resolved ?? {}), dataRoot: farmRoot, decrypted, decoded, configFile: join(farmRoot, 'config.json') }
  cfg.dataRoot = farmRoot
  cfg.decryptedDir = decrypted
  cfg.decodedImagesDir = decoded
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
}


// ══════════════════════════════════════════════════════════════════════════
// 浏览器侧驱动
// ══════════════════════════════════════════════════════════════════════════

/** AUDIT_PAGE 的入参（阈值与桌面审计完全一致）。 */
const AUDIT_PAYLOAD = {
  tol: THRESHOLDS.viewportOverflowPx,
  maxPerRule: THRESHOLDS.perRuleCap,
  overlapPct: THRESHOLDS.occlusionOverlapPct,
  visualPct: THRESHOLDS.occlusionVisualPct,
  docOverflowPx: THRESHOLDS.docOverflowPx,
}

/** 手机浏览器里「主界面已挂载」的判据：令牌门不在、移动底栏/侧栏/主区出现。 */
const SHELL_WAIT_FN = () => {
  const gate = document.getElementById('ra-token')
  const mobileNav = document.querySelector('nav[aria-label="主导航"]')
  const aside = document.querySelector('aside')
  const main = document.querySelector('main')
  const dialog = document.querySelector('[role="dialog"]')
  return !gate && !!(mobileNav || aside || main || dialog)
}

/**
 * 等浏览器里应用主界面挂载（令牌门通过 + 壳出现）。
 * @param {import('playwright').Page} page
 * @param {number} timeout
 */
async function waitBrowserShell (page, timeout = 60000) {
  await page.waitForFunction(SHELL_WAIT_FN, null, { timeout })
}

/**
 * 深链进入一个 tab：写 hash → reload。
 * `WechatDataPanel` 只在挂载时读 `location.hash`（无 hashchange 监听），Electron 与浏览器同一条代码，
 * 所以进入姿势必须一致：先改 hash 再整页重载（Cookie 会话在 context 里，重载不丢登录）。
 * @param {import('playwright').Page} page
 * @param {string} tab
 */
async function gotoBrowserTab (page, tab) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.evaluate((t) => { location.hash = `#${t}` }, tab).catch(() => {})
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitBrowserShell(page)
      return attempt
    } catch (e) {
      lastErr = e
      await sleep(700)
    }
  }
  throw lastErr ?? new Error('gotoBrowserTab 失败')
}

/** 读「当前正在看的那一层」的文本长度与骨架数（落定判据，与桌面审计同口径）。 */
async function readBrowserState (page) {
  return page.evaluate(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')]
      .find((d) => { const r = d.getBoundingClientRect(); return r.width > 200 && r.height > 200 })
    const sc = dlg ?? document.querySelector('main') ?? document.body
    const text = (sc.innerText || '').replace(/\s+/g, ' ').trim()
    const skel = (dlg ?? document).querySelectorAll('[class*="skeleton"], [class*="Skeleton"], .nm-skel').length
    return { len: text.length, skel, dialog: !!dlg, hash: location.hash, vw: innerWidth, vh: innerHeight }
  })
}

/**
 * 等面板落定：至少 `tabWaitMinMs`，且文本长度连续 2 次（≈500ms）不变 + 无骨架，最长 6s。
 * @param {import('playwright').Page} page
 */
async function waitBrowserSettled (page) {
  const t0 = Date.now()
  let prevLen = -1
  let stable = 0
  let last = null
  while (Date.now() - t0 < THRESHOLDS.tabWaitMaxMs) {
    await sleep(250)
    last = await readBrowserState(page)
    if (last.len === prevLen && last.skel === 0) stable++
    else stable = 0
    prevLen = last.len
    if (Date.now() - t0 >= THRESHOLDS.tabWaitMinMs && stable >= 2) break
  }
  return { ...last, settledMs: Date.now() - t0 }
}

/**
 * 改浏览器视口尺寸并等布局沉降。
 * @param {import('playwright').Page} page
 * @param {{w:number,h:number}} vp
 */
async function setBrowserViewport (page, vp) {
  await page.setViewportSize({ width: vp.w, height: vp.h })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await sleep(THRESHOLDS.resizeSettleMs)
  const actual = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 }))
  return { ...actual, matched: Math.abs(actual.vw - vp.w) <= 2 && Math.abs(actual.vh - vp.h) <= 2 }
}

// ══════════════════════════════════════════════════════════════════════════
// 服务端:启动 Electron（影子 profile + 影子数据根）→ 等 HTTP 就绪
// ══════════════════════════════════════════════════════════════════════════

/**
 * 在 5032–5042 里轮询「哪个端口是本次应用的远程访问服务」，并用令牌换一次会话验证身份。
 *
 * 为什么靠轮询而不是读日志：`api_port` 被占用时 http-server 会自动 +1 重试（`PORT_ATTEMPTS`），
 * 日志端口解析属于实现细节；而「首页能拿到 + `/api/auth` 接受本脚本的临时令牌」是**用户的真实
 * 登录路径**，用它发现端口同时证明了「Host 白名单 + 令牌读取 + 会话下发」三条链路都通。
 * @param {string[]} ports
 * @param {string} token
 * @param {number} timeoutMs
 * @returns {Promise<{port:number, baseUrl:string}>}
 */
async function waitHttpServer (ports, token, timeoutMs) {
  const t0 = Date.now()
  let lastDiag = ''
  while (Date.now() - t0 < timeoutMs) {
    for (const port of ports) {
      const baseUrl = `http://${HOST}:${port}`
      try {
        const home = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) })
        const text = home.ok ? await home.text() : ''
        if (!home.ok || !text.includes('Super Time')) { lastDiag = `GET / → ${home.status}`; continue }
        const auth = await fetch(`${baseUrl}/api/auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(3000),
        })
        const body = await auth.json().catch(() => null)
        if (auth.ok && body?.ok) return { port, baseUrl }
        lastDiag = `POST /api/auth → ${auth.status} ${JSON.stringify(body?.error ?? '').slice(0, 120)}`
      } catch (e) {
        lastDiag = `${e.name === 'TimeoutError' ? '请求超时' : (e.code ?? e.message)}`
      }
    }
    await sleep(500)
  }
  throw new Error(`等待远程访问 HTTP 服务（端口 ${ports.join('/')}）超时。最后诊断：${lastDiag}`)
}

/**
 * 启动影子 profile 的 Electron 并等远程访问服务可用。
 * @param {{profileDir:string, farmRoot:string, token:string, preferredPort:number}} opts
 * @returns {Promise<{app:import('playwright').ElectronApplication, port:number, baseUrl:string, httpLogs:string[], warnings:string[]}>}
 */
async function launchElectronApp (opts) {
  const { profileDir, farmRoot, token, preferredPort } = opts
  const warnings = []
  const { _electron } = await import('playwright')
  const launchEnv = {
    ...process.env,
    SUPERTIME_USER_DATA_DIR: profileDir,
    // 影子数据根（双保险：profile config 的 resolved.dataRoot 已指向它，这里再显式给后端环境变量）。
    DSH_WECHAT_DATA_DIR: farmRoot,
    // 只在回环地址监听：Host 白名单只接受绑定地址，用 127.0.0.1 访问。
    SUPERTIME_REMOTE_ACCESS_LOOPBACK_TEST: '1',
  }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  if (launchEnv.SUPERTIME_SKIP_ONBOARDING !== undefined) warnings.push('外部环境带 SUPERTIME_SKIP_ONBOARDING（界面会有调试横幅）')
  const app = await _electron.launch({ executablePath: EXE, args: [ROOT], cwd: ROOT, env: launchEnv })
  const httpLogs = []
  // 日志只用于诊断（端口以 HTTP 探测为准）；拿不到 stdout 不算失败。
  try {
    const proc = app.process()
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.on('data', (buf) => {
        const line = String(buf).trim()
        if (line.includes('[remote-access]')) httpLogs.push(line.slice(0, 200))
      })
    }
  } catch { warnings.push('拿不到 Electron 进程 stdout —— 端口将以 HTTP 探测为准') }

  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForLoadState('domcontentloaded').catch(() => {})
  // 等 Electron 主界面挂载：证明 profile 播种/闸门正常（否则后端可能不会走到「就绪」）。
  try {
    await win.waitForFunction(SHELL_WAIT_FN, null, { timeout: 60000 })
  } catch {
    const diag = await win.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240)).catch(() => '(取不到)')
    warnings.push(`Electron 主界面未在 60s 内挂载（body=「${diag}」）—— 继续尝试远程服务`)
  }
  const ports = Array.from({ length: PORT_ATTEMPTS }, (_, i) => preferredPort + i)
  const { port, baseUrl } = await waitHttpServer(ports, token, 120000)
  return { app, port, baseUrl, httpLogs, warnings }
}

// ══════════════════════════════════════════════════════════════════════════
// 会话启动（三种模式共用：影子 profile / 影子数据根 / 远程服务 / Chrome / 登录）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 启动一次「影子 profile + 影子数据根 + 真实远程访问服务 + system Chrome + `?t=` 登录」会话。
 *
 * Wave 4 的 `--cutout` / `--dynamic-toolbar` 与默认四档审计**共用这一份启动逻辑**（Wave 3 时
 * 它内联在 `runBrowserAudit` 里；拆出来是为了避免三份复制在「改一处忘两处」上漂）。
 * 任何一步失败都会先关掉已建资源再抛，调用方不必关心半开状态。
 * @returns {Promise<object>} 会话上下文：page/context/browser/electronApp/closeAll + 数据根与构建时间。
 */
async function bootBrowser () {
  for (const p of [PROFILE_DIR, FARM_DIR]) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }
  mkdirSync(OUT_DIR, { recursive: true })
  if (!NO_SHOTS) mkdirSync(SHOTS_DIR, { recursive: true })

  const srcUserData = resolve(ROOT, opt('user-data', '') || detectUserDataDir())
  const token = randomBytes(16).toString('hex')
  const tRunStart = Date.now()
  const tBuild = (() => {
    try { return new Date(statSync(join(ROOT, 'src', 'client', 'ui-dist', 'index.html')).mtimeMs).toISOString() } catch { return 'unknown' }
  })()
  console.log('─'.repeat(78))
  console.log(`手机浏览器审计  label=${LABEL}  git=${gitHead()}  node=${process.version}`)
  console.log(`真实 profile：${srcUserData}`)
  console.log('─'.repeat(78))

  // ① 影子 profile（userData 隔离）
  const profile = seedProfile(PROFILE_DIR, srcUserData)
  console.log(`影子 profile：${PROFILE_DIR}`)
  console.log(`  真实数据根：${profile.dataRoot || '(未确定)'}`)
  console.log(`  配置复制：${profile.copied.join(' / ') || '(无)'}`)
  console.log(`  首启闸门：${profile.gates === 'seeded' ? '复制真实状态（无调试横幅）' : '回退 SKIP_ONBOARDING（含调试横幅）'}`)
  const realRoot = resolveRealDataRoot(srcUserData) || profile.dataRoot
  if (!realRoot) throw new Error('无法确定真实数据根（profile config 无 resolved.dataRoot）')

  // ② 影子数据根（远程访问配置隔离 + 指向真实数据）
  const farm = prepareDataFarm({ farmRoot: FARM_DIR, realRoot, token, preferredPort: PREFERRED_PORT, refresh: REFRESH_FARM })
  patchProfileDataRoot(PROFILE_DIR, farm.root)
  console.log(`影子数据根：${farm.root}`)
  console.log(`  来源（只读）：${realRoot}`)
  for (const w of farm.warnings) console.log(`  · ${w}`)
  console.log(`  远程访问：api_enabled=true / api_port=${farm.port} / api_token=<临时 ${token.length} 字符>（只写影子数据根）`)

  const warnings = [...profile.reasons, ...farm.warnings]
  const consoleErrors = []
  let electronApp = null
  let browser = null
  /** 幂等清理：正常收尾与异常路径都走这里。 */
  const closeAll = async () => {
    if (browser) { const b = browser; browser = null; await b.close().catch(() => {}) }
    if (electronApp) { const a = electronApp; electronApp = null; await a.close().catch(() => {}) }
  }

  try {
    // ③ 起 Electron（影子 profile + 影子数据根）→ 等远程访问服务
    const launched = await launchElectronApp({ profileDir: PROFILE_DIR, farmRoot: farm.root, token, preferredPort: farm.port })
    electronApp = launched.app
    warnings.push(...launched.warnings)
    const baseUrl = launched.baseUrl
    console.log(`远程访问服务就绪：${baseUrl}（端口 ${launched.port}）`)
    for (const line of launched.httpLogs) console.log(`  · ${line}`)

    // ④ 真 system Chrome（手机 UA / 触摸 / DPR=3；视口由各模式切换）
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ channel: 'chrome', headless: !HEADED })
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      userAgent: MOBILE_UA,
    })
    context.setDefaultTimeout(60000)
    const page = await context.newPage()
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      if (/Failed to load resource/i.test(m.text())) return
      if (consoleErrors.length < 100) consoleErrors.push(m.text().slice(0, 180))
    })
    page.on('pageerror', (e) => { if (consoleErrors.length < 100) consoleErrors.push('pageerror: ' + String(e.message).slice(0, 180)) })

    // ⑤ 登录：走用户真实路径 —— 带一次性配对码打开首页，由 BrowserSession 换 Cookie。
    await page.goto(`${baseUrl}/?t=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitBrowserShell(page, 60000)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const cookieOk = await page.evaluate(async () => {
      const r = await fetch('/api/status', { credentials: 'same-origin' })
      return { status: r.status, ok: r.ok }
    }).catch((e) => ({ status: 0, ok: false, error: e.message }))
    if (!cookieOk.ok) throw new Error(`浏览器会话未建立（/api/status → ${JSON.stringify(cookieOk)}）`)
    console.log(`浏览器登录：OK（/api/status ${cookieOk.status}；Cookie 会话已建立，地址栏配对码被抹掉）`)

    return {
      page, context, browser, electronApp, closeAll, baseUrl, token, warnings, consoleErrors,
      tBuild, tRunStart, srcUserData, profile, farm, realRoot, launched,
    }
  } catch (e) {
    await closeAll()
    throw e
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 自检（不依赖 Electron / 真实数据）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 检测器自检：向空页面注入 5 类夹具，断言 `AUDIT_PAGE` 五条规则都会开火；
 * 断言 `PROBE_MOBILE` 在手机视口返回可用观测值；再用 **CDP 安全区覆盖**做一次 cutout 夹具
 * （Wave 4：注入 44/34 后 env(safe-area-inset-*) 必须真的非 0、100dvh 必须等于 innerHeight）。
 * 退出码 0/1。
 */
async function runSelftest () {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await context.newPage()
  // 夹具故意横向溢出：必须锁死 minimum/maximum-scale，否则 Chrome 移动端模拟会「缩小适配」
  // 到 1560px 宽（innerWidth 跟着变），自检就会在错误的视口里量。真实应用没有这层干预
  // （见脚本头「已知局限」：视口失配会被记录到 actual.sizeMatched，不会被当成正常格）。
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, viewport-fit=cover"></head><body style="margin:0"></body></html>')
  await page.evaluate(() => {
    const html = [
      // ① 文档横向溢出
      '<div id="st-wide" style="position:absolute;left:0;top:0;width:2000px;height:8px;background:#123">wide</div>',
      // ② 元素越界
      '<button id="st-oob" type="button" style="position:absolute;left:0;top:20px;width:calc(100vw + 120px);height:32px">越界按钮</button>',
      // ③ 裁切
      '<div id="st-clip" style="position:absolute;left:0;top:70px;width:120px;height:40px;overflow:hidden">'
        + '<span style="white-space:nowrap">这是一段绝对不会换行因此必然被裁切的长文本 fixture</span></div>',
      // ④ 遮挡
      '<div id="st-overlay" style="position:fixed;left:0;top:40%;width:100vw;height:80px;z-index:99999;background:#000;color:#fff">覆盖层 fixture</div>',
      '<button id="st-covered" type="button" style="position:absolute;left:20px;top:calc(40% + 20px);width:240px;height:40px">被遮挡按钮</button>',
      // ⑤ 有文本但不可见
      '<span id="st-hidden" style="display:none">这段文字 fixture 不可见</span>',
      // ⑥ 小触摸目标（手机探针：矮按钮）
      '<button id="st-tiny" type="button" style="position:absolute;left:0;top:200px;height:20px;width:60px">矮按钮</button>',
    ].join('')
    document.body.insertAdjacentHTML('beforeend', html)
  })
  const result = await page.evaluate(AUDIT_PAGE, AUDIT_PAYLOAD)
  const mobile = await page.evaluate(PROBE_MOBILE)
  const expect = {
    'doc-overflow': null,
    'out-of-viewport': 'st-oob',
    clipped: 'st-clip',
    occluded: 'st-covered',
    hidden: 'st-hidden',
  }
  const failed = []
  console.log('\n── 浏览器检测器自检（--selftest）──')
  console.log(`  视口 ${result.viewport.vw}×${result.viewport.vh}；issues=${result.issues.length}`)
  for (const [rule, id] of Object.entries(expect)) {
    const hit = result.issues.some((i) => i.rule === rule && (!id || i.id === id || (i.sel || '').includes(id)))
    console.log(`  ${hit ? 'PASS' : 'FAIL'}  ${rule.padEnd(16)} ${id ? `期望命中 #${id}` : '期望规则开火（文档级）'}`)
    if (!hit) failed.push(rule)
  }
  const mobileOk = mobile.viewport.vw === 390 && mobile.hasViewportFitCover === true && mobile.tinyTargets.count >= 1 && mobile.metaViewport.includes('width=device-width')
  console.log(`  ${mobileOk ? 'PASS' : 'FAIL'}  mobile-probe       期望 viewport=390 / viewport-fit=cover / 至少 1 个 <44px 触摸目标；实得 vw=${mobile.viewport.vw} fit=${String(mobile.hasViewportFitCover)} tiny=${mobile.tinyTargets.count}`)
  if (!mobileOk) failed.push('mobile-probe')

  // ── Wave 4 cutout 夹具：CDP 注入安全区 → env() 必须生效且被 100dvh 高度链消费 ──
  const cdp = await context.newCDPSession(page)
  const cap = await detectSafeAreaSupport(cdp)
  let cutoutOk = false
  let cutoutDetail = cap.command ? '' : '（本机 Chrome 无安全区覆盖命令）'
  if (cap.command) {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, viewport-fit=cover"></head><body style="margin:0"></body></html>')
    await applySafeArea(cdp, { top: 44, right: 0, bottom: 34, left: 0 })
    const cut = await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:-9px;top:-9px;padding-top:env(safe-area-inset-top);'
        + 'padding-bottom:env(safe-area-inset-bottom);height:100dvh;box-sizing:border-box'
      document.body.appendChild(el)
      const cs = getComputedStyle(el)
      const out = {
        top: Math.round(Number.parseFloat(cs.paddingTop) || 0),
        bottom: Math.round(Number.parseFloat(cs.paddingBottom) || 0),
        dvh: Math.round(el.getBoundingClientRect().height),
        ih: window.innerHeight,
        supportsDvh: CSS.supports('height', '100dvh'),
      }
      el.remove()
      return out
    })
    cutoutOk = cut.top === 44 && cut.bottom === 34 && cut.supportsDvh && Math.abs(cut.dvh - cut.ih) <= 1
    cutoutDetail = `注入 44/34 → env top=${cut.top} bottom=${cut.bottom}；100dvh=${cut.dvh} vs innerHeight=${cut.ih}（命令 ${cap.command}）`
    await clearSafeArea(cdp)
  }
  for (const n of cap.notes) console.log(`  · ${n}`)
  console.log(`  ${cutoutOk ? 'PASS' : 'FAIL'}  cutout-fixture     ${cutoutDetail}`)
  if (!cutoutOk) failed.push('cutout-fixture')

  console.log(`  自检结果：${failed.length === 0 ? '7/7 通过' : `失败 ${failed.join(', ')}`}`)
  await browser.close()
  return failed.length === 0 ? 0 : 1
}

// ══════════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════════

/**
 * 跑一次手机浏览器审计。
 * @returns {Promise<number>} 退出码。
 */
async function runBrowserAudit () {
  const ALL_TABS = parseTabs()
  const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean)
  const TABS = ONLY.length > 0 ? ALL_TABS.filter((t) => ONLY.includes(t.tab)) : ALL_TABS
  const VIEWPORTS = parseBrowserViewports()
  if (TABS.length === 0) { console.error('[前置] --only 过滤后没有可跑的页签'); return 2 }
  // 阴影 profile / 影子数据根 / 真实远程访问服务 / system Chrome / ?t= 登录 —— 三种模式共用
  const ctx = await bootBrowser()
  const {
    page, baseUrl, browser, electronApp, warnings, consoleErrors, tBuild, tRunStart,
    srcUserData, profile, farm, realRoot, launched,
  } = ctx
  const cells = []
  console.log(`页签 ${TABS.length}/${ALL_TABS.length}  视口 ${VIEWPORTS.map((v) => v.label).join(' / ')}  Chrome channel=chrome headless=${String(!HEADED)}`)
  console.log(`  远程访问服务：${baseUrl}（端口 ${launched.port}）`)

  try {
    // ⑥ 逐 tab × 逐视口
    let shotsTaken = 0
    for (const [tabIndex, tabInfo] of TABS.entries()) {
      const tabT0 = Date.now()
      const navAttempt = await gotoBrowserTab(page, tabInfo.tab)
      const settled = await waitBrowserSettled(page)
      const rowCounts = []
      for (const vp of VIEWPORTS) {
        const actual = await setBrowserViewport(page, vp)
        let result = null
        let mobile = null
        let error = ''
        try {
          result = await page.evaluate(AUDIT_PAGE, AUDIT_PAYLOAD)
          mobile = await page.evaluate(PROBE_MOBILE)
        } catch (e) {
          error = (e?.message ?? String(e)).split('\n')[0].slice(0, 200)
        }
        const cell = {
          tab: tabInfo.tab,
          label: tabInfo.label,
          hidden: tabInfo.hidden,
          viewport: vp.label,
          device: vp.device ?? '',
          requested: { w: vp.w, h: vp.h },
          actual: { w: actual.vw, h: actual.vh, dpr: actual.dpr, sizeMatched: actual.matched },
          settled: { loadAttempt: navAttempt, settledMs: tabT0 ? Date.now() - tabT0 : null },
          error,
          result,
          mobile,
          screenshot: '',
        }
        if (!error && result) {
          const counts = {}
          for (const rule of RULE_ORDER) counts[rule] = result.issues.filter((i) => i.rule === rule).length
          cell.counts = counts
          cell.total = result.issues.length
          rowCounts.push(`${vp.label.replace('x', '×')}:${String(result.issues.length).padStart(2)}`)
          const anyHigh = result.issues.some((i) => i.severity === 'high')
          if (!NO_SHOTS && shotsTaken < MAX_SHOTS && (counts['doc-overflow'] > 0 || anyHigh)) {
            const file = `browser-${slug(LABEL)}-${slug(tabInfo.tab)}-${slug(vp.label)}.jpg`
            try {
              await page.screenshot({ path: join(SHOTS_DIR, file), type: 'jpeg', quality: SCREENSHOT_QUALITY })
              cell.screenshot = `shots/${file}`
              shotsTaken++
            } catch { /* 截图失败不影响数据 */ }
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

    // ⑦ 汇总 + 落盘
    const durationMs = Date.now() - tRunStart
    const summary = buildSummary(cells, TABS, VIEWPORTS)
    const mobileSummary = summarizeMobile(cells)
    const meta = {
      tool: 'scripts/responsive-audit-browser.mjs',
      version: 1,
      label: LABEL,
      at: new Date().toISOString(),
      durationMs,
      git: gitHead(),
      node: process.version,
      chrome: browser.version(),
      headless: !HEADED,
      uiDistBuiltAt: tBuild,
      root: ROOT,
      userDataSource: srcUserData,
      realDataRoot: realRoot,
      shadowDataRoot: farm.root,
      shadowProfile: PROFILE_DIR,
      remoteAccess: { host: HOST, port: launched.port, auth: 'POST /api/auth + 一次性配对码 ?t=', session: 'cookie' },
      profileGates: profile.gates,
      viewports: VIEWPORTS,
      thresholds: THRESHOLDS,
      tabsParsed: ALL_TABS.length,
      tabsRun: TABS.map((t) => ({ tab: t.tab, label: t.label, hidden: t.hidden })),
      consoleErrors: consoleErrors.slice(0, 50),
      screenshots: shotsTaken,
      warnings,
      limitations: [
        '明文 HTTP + 同一台机器上的 system Chrome 模拟 —— 真机的地址栏高度、刘海/手势条、软键盘、触摸滚动惯性仍有差异。',
        '无头 Chrome 的 env(safe-area-inset-*) 恒为 0，只能验证「CSS 是否消费 env()」，不能验证具体数值。',
        '输入法遮挡只做结构性检查（fixed 底部层占视口高度比例），无法唤起真实软键盘。',
        '动态视口抖动以「改视口高度后布局是否仍装得下」近似，不能模拟地址栏收起的逐帧过程。',
        '与桌面 Electron 390 档的差异需按「壳不同」（标题栏移除/令牌门/能力差异）解释，不能直接当回归。',
      ],
    }
    const jsonDoc = { meta, summary, mobileSummary, cells }
    const jsonPath = join(OUT_DIR, `${slug(LABEL)}.json`)
    const tmp = `${jsonPath}.tmp`
    writeFileSync(tmp, JSON.stringify(jsonDoc, null, 2), 'utf8')
    renameSync(tmp, jsonPath)

    printBrowserSummary({ summary, mobileSummary, cells, VIEWPORTS, durationMs, labels: { LABEL } })
    console.log(`\nJSON：${jsonPath}`)
    console.log(`截图：${NO_SHOTS ? '(--no-shots)' : SHOTS_DIR}`)

    if (KEEP_OPEN) {
      // 人工观察模式：保留 Electron（远程服务）与 Chrome 窗口，直到 Ctrl+C。
      console.log('\n--keep-open：浏览器与 Electron 均保持运行，按 Ctrl+C 退出（临时 profile/数据根在 .tmp-e2e/）')
      await new Promise(() => {})
    }
    // 收尾（正常模式）：上下文自带幂等 closeAll，异常路径也走同一份清理
    await ctx.closeAll()
    return 0
  } finally {
    await ctx.closeAll()
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Wave 4：刘海/安全区（--cutout）与动态地址栏（--dynamic-toolbar）仿真模式
// ══════════════════════════════════════════════════════════════════════════

/** 写一份模式 JSON 到 OUT_DIR（先 tmp 再 rename，避免中断留下半截文件）。 */
function writeRunJson (doc) {
  const jsonPath = join(OUT_DIR, `${slug(LABEL)}.json`)
  const tmp = `${jsonPath}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  renameSync(tmp, jsonPath)
  return jsonPath
}

/** 截图回调（失败不影响数据；--no-shots 时返回空串）。 */
function makeShotCallback () {
  return async (page, name) => {
    if (NO_SHOTS) return ''
    const file = `safe-${slug(LABEL)}-${slug(name)}.jpg`
    try {
      await page.screenshot({ path: join(SHOTS_DIR, file), type: 'jpeg', quality: SCREENSHOT_QUALITY })
      return `shots/${file}`
    } catch { return '' }
  }
}

/**
 * 仿真模式的公共 meta（字段与默认模式对齐，便于并排比较；额外字段由 `extra` 提供）。
 * @param {object} ctx - `bootBrowser()` 返回的会话上下文。
 * @param {object} extra - 模式特有字段（mode/profiles/tabsRun/cdp/sizes/…）。
 */
function buildEmuMeta (ctx, extra) {
  return {
    tool: 'scripts/responsive-audit-browser.mjs',
    version: 2,
    mode: extra.mode,
    label: LABEL,
    at: new Date().toISOString(),
    durationMs: Date.now() - ctx.tRunStart,
    git: gitHead(),
    node: process.version,
    chrome: ctx.browser.version(),
    headless: !HEADED,
    uiDistBuiltAt: ctx.tBuild,
    root: ROOT,
    userDataSource: ctx.srcUserData,
    realDataRoot: ctx.realRoot,
    shadowDataRoot: ctx.farm.root,
    shadowProfile: PROFILE_DIR,
    remoteAccess: { host: HOST, port: ctx.launched.port, auth: 'POST /api/auth + 一次性配对码 ?t=', session: 'cookie' },
    consoleErrors: ctx.consoleErrors.slice(0, 50),
    warnings: ctx.warnings,
    limitations: [
      'CDP 安全区是矩形近似，不是真实刘海形状（保守判据）。',
      '仿真在无头 Chrome 里完成：地址栏收起/展开是「改视口高度」的近似，不是真实逐帧动画。',
      '无头环境无法唤起软键盘，输入法遮挡只做结构性检查。',
      '未在真机/真实浏览器 UI chrome 下复核（Wave 4 只做仿真；真机清单见报告）。',
    ],
    ...extra,
  }
}

/** `--keep-open`：保留 Electron/Chrome 现场供人工观察。 */
async function keepOpen () {
  console.log('\n--keep-open：浏览器与 Electron 均保持运行，按 Ctrl+C 退出（临时 profile/数据根在 .tmp-e2e/）')
  await new Promise(() => {})
}

/** 从 `--only` 解析本次要跑的页签（缺省 = Wave 4 覆盖的 10 个）。 */
function resolveEmuTabs () {
  const all = parseTabs()
  const only = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean)
  const picked = only.length > 0 ? all.filter((t) => only.includes(t.tab)) : all.filter((t) => SAFE_AREA_TABS.includes(t.tab))
  return picked.map((t) => ({ tab: t.tab, label: t.label, hidden: t.hidden }))
}

/**
 * 刘海/安全区矩阵模式（`--cutout`）：3 档（iPhone 刘海 / Android 挖孔 / 横屏刘海）× 10 个页签。
 *
 * 每个格子：注入安全区 → 深链进入 tab → 等落定 → 再注入（防导航重置）→ `PROBE_SAFE_AREA`
 * （env 实测 / 四条 band / 高度链 / 底栏 / 弹窗）+ `AUDIT_PAGE` 五类规则回归。
 * @returns {Promise<number>} 退出码。
 */
async function runCutoutMode () {
  const tabs = resolveEmuTabs()
  if (tabs.length === 0) { console.error('[前置] --only 过滤后没有可跑的页签'); return 2 }
  const want = opt('viewports', '').split(',').map((s) => s.trim()).filter(Boolean)
  const profiles = want.length > 0 ? CUTOUT_PROFILES.filter((p) => want.includes(p.label)) : CUTOUT_PROFILES
  if (profiles.length === 0) {
    console.error(`[前置] --viewports 与 cutout 档位不匹配（可选：${CUTOUT_PROFILES.map((p) => p.label).join(', ')}）`)
    return 2
  }
  const ctx = await bootBrowser()
  try {
    const cdp = await ctx.context.newCDPSession(ctx.page)
    const cap = await detectSafeAreaSupport(cdp)
    console.log(`刘海/安全区仿真：${tabs.length} tab × ${profiles.length} 档（${profiles.map((p) => `${p.label}[${p.insets.top}/${p.insets.bottom}/${p.insets.left}]`).join(' / ')}）`)
    console.log(`  CDP 安全区命令：${cap.command ?? '不可用 → 降级为只跑几何/高度链检查'}`)
    for (const n of cap.notes) console.log(`  · ${n}`)
    const collected = await collectSafeAreaCells({
      page: ctx.page,
      cdp,
      tabs,
      profiles,
      goto: gotoBrowserTab,
      settle: waitBrowserSettled,
      setViewport: setBrowserViewport,
      runAudit: (p) => p.evaluate(AUDIT_PAGE, AUDIT_PAYLOAD),
      screenshot: makeShotCallback(),
      emulationAvailable: !!cap.command,
    })
    await clearSafeArea(cdp)
    const summary = summarizeSafeArea(collected.cells)
    const meta = buildEmuMeta(ctx, {
      mode: 'cutout',
      profiles: profiles.map((p) => ({ label: p.label, w: p.w, h: p.h, insets: p.insets, device: p.device })),
      tabsRun: tabs.map((t) => t.tab),
      cdp: { command: cap.command, fallback: cap.fallback, notes: cap.notes, assumedByTask: 'Emulation.setDisplayCutoutOverride（本机 Chrome 155 协议中不存在，改用 setSafeAreaInsetsOverride）' },
      screenshots: collected.cells.filter((c) => c.screenshot).length,
    })
    const jsonPath = writeRunJson({ meta, summary, cells: collected.cells })
    printSafeAreaSummary({ summary, profiles, tabs: tabs.map((t) => t.tab), durationMs: meta.durationMs })
    const bad = collected.cells.filter((c) => c.verdict && c.verdict.violations.length > 0)
    if (bad.length > 0) {
      console.log('\n有问题的格子：')
      for (const c of bad) console.log(`  [${c.profile}] ${c.tab}: ${c.verdict.violations.map((v) => v.kind).join(', ')}`)
    }
    console.log(`\nJSON：${jsonPath}`)
    console.log(`截图：${NO_SHOTS ? '(--no-shots)' : SHOTS_DIR}`)
    if (KEEP_OPEN) await keepOpen()
    await ctx.closeAll()
    return 0
  } catch (e) {
    await ctx.closeAll()
    console.error(`\n[异常] ${e?.stack ?? e}`)
    return 1
  }
}

/**
 * 动态地址栏模式（`--dynamic-toolbar`）：同一页在「地址栏可见高度 → 收起高度 → 复位」
 * 三次观测，断言 `100dvh` 高度链跟随 `innerHeight`、固定底栏贴底、底部按钮不出视口、复位无漂移。
 *
 * 另外静态扫一遍样式表里的 `vh` 单位声明（真机 `vh`=大视口、`dvh`=动态视口；无头 Chrome
 * 两者相同，所以这一项只能提示风险、不能断言故障）。
 * @returns {Promise<number>} 退出码。
 */
async function runDynamicToolbarMode () {
  const tabs = resolveEmuTabs()
  if (tabs.length === 0) { console.error('[前置] --only 过滤后没有可跑的页签'); return 2 }
  const ctx = await bootBrowser()
  try {
    console.log(`动态地址栏仿真：${tabs.length} tab；视口 ${DYNAMIC_TOOLBAR_SIZES.barVisible.label} ↔ ${DYNAMIC_TOOLBAR_SIZES.barHidden.label}`)
    const collected = await collectDynamicCells({
      page: ctx.page,
      tabs,
      sizes: DYNAMIC_TOOLBAR_SIZES,
      goto: gotoBrowserTab,
      settle: waitBrowserSettled,
      setViewport: setBrowserViewport,
    })
    const summary = summarizeDynamic(collected.cells, collected.vhUnits)
    const meta = buildEmuMeta(ctx, {
      mode: 'dynamic-toolbar',
      sizes: DYNAMIC_TOOLBAR_SIZES,
      tabsRun: tabs.map((t) => t.tab),
      vhUnits: collected.vhUnits,
      limitations: [
        ...buildEmuMeta(ctx, { mode: 'dynamic-toolbar' }).limitations,
        '桌面 Chrome 里 dvh==vh==innerHeight，仿真只能验证「布局链跟随视口高度/固定栏不悬空」，验证不了真机 vh(大视口) 与 dvh(动态视口) 的差异本身；后者用静态 vh 单位扫描提示。',
      ],
    })
    const jsonPath = writeRunJson({ meta, summary, cells: collected.cells })
    printDynamicSummary({ summary, tabs: tabs.map((t) => t.tab), sizes: DYNAMIC_TOOLBAR_SIZES, durationMs: meta.durationMs })
    const bad = collected.cells.filter((c) => c.findings && c.findings.length > 0)
    if (bad.length > 0) {
      console.log('\n有问题的格子：')
      for (const c of bad) console.log(`  ${c.tab}: ${c.findings.map((f) => f.kind).join(', ')}`)
    }
    console.log(`\nJSON：${jsonPath}`)
    if (KEEP_OPEN) await keepOpen()
    await ctx.closeAll()
    return 0
  } catch (e) {
    await ctx.closeAll()
    console.error(`\n[异常] ${e?.stack ?? e}`)
    return 1
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 入口
// ══════════════════════════════════════════════════════════════════════════

process.exitCode = await (async () => {
  if (SELFTEST) return runSelftest()
  try {
    if (hasFlag('cutout')) return await runCutoutMode()
    if (hasFlag('dynamic-toolbar')) return await runDynamicToolbarMode()
    return await runBrowserAudit()
  } catch (e) {
    console.error(`\n[异常] ${e?.stack ?? e}`)
    return 1
  }
})()
