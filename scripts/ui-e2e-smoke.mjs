/**
 * 环境探针 / 端到端冒烟：本机到底有没有「浏览器环境」？
 *
 * 背景：`docs/RELEASE-PLAN.md` 里多条验收写着「**无浏览器环境**，未验证」——
 * 例如 L20（notice N 秒自动消失）、M14（滚动与虚拟化行为）、N17（双击只发一条请求）。
 * 这里的结论是：**不成立**。本机有一套可用的浏览器环境，而且不需要下载任何浏览器：
 *
 *   · Electron 44 自带 Chromium 152（`node_modules/electron/dist/electron.exe` 已在位）
 *   · Playwright 1.63 的 `_electron.launch()` 直接驱动它（**不依赖 ms-playwright 缓存**，
 *     所以 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 装出来的 playwright 也能用）
 *   · 首启三道闸门用主进程的调试开关越过（`SUPERTIME_SKIP_ONBOARDING=1`，仅非打包态生效），
 *     它在 `wechat:call` 里位于许可校验**之前**，连业务方法的许可证校验也一并豁免
 *     ⇒ 不需要签发真许可证
 *   · 另给一个临时 `SUPERTIME_USER_DATA_DIR`：单实例锁按 userData 区分，不会和
 *     正在运行的正式实例打架
 *
 * 本脚本做两件事：
 *   ① 断言这套链路成立（真实 Chromium / 真实布局 / preload 桥 / 真实指针点击）；
 *   ② 顺手验证一件此前被明确记为「无浏览器环境 ⇒ 未验证」的行为：
 *      **「待办日程」加一条待办后的提示真的会在 3 秒后自己消失**（L20 的验收口径）。
 *
 * 运行：node scripts/ui-e2e-smoke.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

let _electron
try {
  ;({ _electron } = await import('playwright'))
} catch (e) {
  console.error('[前置] 缺少 playwright：', e.message)
  console.error('       npm i --no-save playwright    # 驱动 Electron 不需要下载浏览器二进制')
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE, '（先跑 npm ci）')
  process.exit(2)
}

const results = []
const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail: String(detail) })
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 「已添加待办」：`Tasks.tsx` 走 `useTransientNotice()`，默认 3000ms（`DEFAULT_NOTICE_MS`）。 */
const NOTICE_TEXT = '已添加待办'
const NOTICE_MS = 3000

let app = null
// 单实例锁按 userData 目录区分：另给一个临时 userData，就不会和正在运行的正式实例打架。
const probeUserData = mkdtempSync(join(tmpdir(), 'super-time-e2e-'))
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1', // 仅非打包态生效：越过引导/授权/隐私，并豁免业务方法的许可校验
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: probeUserData,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const consoleErrors = []
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)))
  await win.waitForLoadState('domcontentloaded')

  // ── ① 环境链路 ─────────────────────────────────────────────
  const userAgent = await win.evaluate(() => navigator.userAgent)
  const layout = await win.evaluate(() => {
    const r = document.body.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })
  check(/Electron\//.test(userAgent), '驱动的是真实 Chromium 内核',
    `${userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? ''} / ${userAgent.match(/Electron\/[\d.]+/)?.[0] ?? ''}`)
  check(layout.w > 0 && layout.h > 0, '有真实布局引擎（body 有尺寸）', JSON.stringify(layout))
  check(await win.evaluate(() => typeof window.electronAPI === 'object' && window.electronAPI !== null), 'preload 桥已注入')

  // 主界面挂载：跳过闸门后左侧导航的第一项就是可点的稳定锚点。
  //
  // 2026-10-15 加固：CI 上这一步曾以「端到端流程未能跑完 / locator.waitFor: Timeout」红过，
  // 而本机与 D 盘克隆都稳定绿 —— 报错里只有一句 Playwright 的超时，看不出**当时界面长什么样**。
  // 所以这里在等不到锚点时补一份现场快照（URL / 可见按钮名 / body 文本前 200 字 / 截图），
  // 让下一次红能直接读出「是没进主界面、还是进了但按钮名变了、还是窗口太小被裁掉」。
  const overviewNav = win.getByRole('button', { name: '数据总览', exact: true })
  try {
    await overviewNav.waitFor({ state: 'visible' })
  } catch (e) {
    const snapshot = await win.evaluate(() => ({
      url: location.href,
      title: document.title,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 40),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    })).catch(() => null)
    const shot = join(ROOT, 'ci-evidence', 'ui-e2e-smoke-fail.png')
    try { mkdirSync(join(ROOT, 'ci-evidence'), { recursive: true }); await win.screenshot({ path: shot }) } catch { /* 截图失败不掩盖原错 */ }
    throw new Error(`等不到「数据总览」导航按钮：${e && e.message ? e.message : String(e)}\n现场快照：${JSON.stringify(snapshot)}\n截图：${shot}`)
  }
  check(true, '跳过三道闸门后进入主界面')

  // 真调一次 Remote：这条路径正是被 `debugGates().skipGates` 豁免掉许可校验的那一段。
  // 之所以用 `listMethods` / `info` 而不是读 `Object.keys(electronAPI.wechat)`：桥面是固定的
  // 8 个成员，Remote 方法在**后端**有上百个，数桥上的键会得出一个误导性的小数字。
  // 两个调用都返回 `{ ok, value }` 信封（`main.js` 的 `wechat:call` 统一包装）。
  //
  // 2026-10-16 加固：`wechat:list-methods` 在 `getWechatBoot()` 还是 null 时返回
  // `{ ok: false, error: '后端未初始化' }`（见 src/backend/ipc-wechat.js）。而 `boot` 只在
  // worker `init()` 成功后才赋值 —— CI runner（共享 2 核 + 实时扫描）比本机慢约 24 倍，
  // 界面挂载（前端）远早于后端就绪，于是这里会拿到 `-1 个方法` 而**本机永远绿**。
  // 这不是「后端坏了」，是「问得太早」：轮询到 `ok: true` 再断言，把竞态从判据里去掉。
  const remote = await win.evaluate(async () => {
    const deadline = Date.now() + 60000
    let methodCount = -1
    let infoOk = false
    let lastError = ''
    for (;;) {
      const methods = await window.electronAPI.wechat.listMethods()
      const names = methods?.value ?? methods
      if (Array.isArray(names) && names.length > 0) {
        methodCount = names.length
        const info = await window.electronAPI.wechat.info()
        infoOk = info?.ok === true
        if (infoOk) break
      } else {
        lastError = methods?.error?.message ?? 'listMethods 未返回数组'
      }
      if (Date.now() > deadline) break
      await new Promise((r) => { setTimeout(r, 250) })
    }
    return { methodCount, infoOk, lastError }
  })
  check(remote.methodCount > 0, '后端 Remote 方法面可用，且许可校验被豁免（无需签真许可证）',
    remote.methodCount > 0 ? `${remote.methodCount} 个方法` : `等待后端就绪超时：${remote.lastError}`)
  check(remote.infoOk, '真实 Remote 调用返回 ok（走完整 IPC → 后端）')

  // ── ② 一件此前「无浏览器环境 ⇒ 未验证」的行为 ──────────────
  await win.getByRole('button', { name: '待办日程', exact: true }).click()
  const titleInput = win.locator('input[type="text"]').first()
  await titleInput.waitFor({ state: 'visible' })
  check(true, '真实点击切换面板（真的指针事件，不是 dispatchEvent 伪造）')

  await titleInput.fill('E2E 探针待办')
  const addBtn = win.getByRole('button', { name: '添加', exact: true })
  await addBtn.waitFor({ state: 'visible' })
  await addBtn.click()

  const notice = win.getByText(NOTICE_TEXT, { exact: true })
  const t0 = Date.now()
  await notice.waitFor({ state: 'visible', timeout: 10000 })
  check(true, `提示写入后可见（${Date.now() - t0}ms）`, NOTICE_TEXT)

  // 核心口径：**活满自己的时长**再消失。下限卡 2.2s（防「被别的定时器提前清掉」），
  // 上限卡 4.5s（防「根本不会消失」）。两边留余量，避免被调度抖动弄成偶发红。
  await sleep(2200)
  check(await notice.isVisible().catch(() => false), '2.2s 时提示仍在（没有被提前清掉）')

  const deadline = Date.now() + 4000
  let goneAtMs = -1
  while (Date.now() < deadline) {
    if (!(await notice.isVisible().catch(() => false))) { goneAtMs = Date.now() - t0; break }
    await sleep(60)
  }
  check(goneAtMs > 0, `提示按 ${NOTICE_MS}ms 口径自动消失`, goneAtMs > 0 ? `实测 ${goneAtMs}ms` : '超时仍在')
  check(goneAtMs < 0 || goneAtMs >= NOTICE_MS - 400, '消失时刻不早于声明时长', `${goneAtMs}ms ≥ ${NOTICE_MS - 400}ms`)

  check(consoleErrors.length === 0, '渲染层无 console error / pageerror', consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  // 2026-10-15：CI 上这一步稳定红，而 GitHub 的注解只显示「Process completed with exit code 1」——
  // 把完整错误（含上面那段现场快照）**原样打到 stdout**，注解里才看得到。
  const detail = e && e.message ? e.message : String(e)
  console.error('[ui-e2e-smoke] 端到端流程未能跑完：')
  console.error(detail)
  // GitHub Actions 的 `::error::` 会把消息直接显示在 PR 的注解里（无需登录看日志）。
  // 多行要转义成 `%0A`，否则只有第一行进注解。
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error::UI 冒烟失败：${detail.replace(/\r?\n/g, '%0A').slice(0, 4000)}`)
  }
  check(false, '端到端流程未能跑完', detail.split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  try { rmSync(probeUserData, { recursive: true, force: true }) } catch { /* ignore */ }
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
}
console.log(failed === 0
  ? '\n结论：本机**有**可用的浏览器环境（Electron 自带 Chromium + Playwright 驱动，零下载）。'
  : `\n结论：${failed} 项不成立 —— 上面的 FAIL 行就是原因。`)
process.exit(failed === 0 ? 0 : 1)
