/**
 * H7 验收：后端「永不回包」时，界面必须**解除 loading 并给出可读错误**，而不是无限转圈。
 *
 * 为什么需要它：H7 把超时/重启机制抽进 `backend-rpc.js` 后，那一半由 16 项单测覆盖；
 * 但「界面在超时后确实会自己解套」属于**渲染层的承诺**，单测与源码断言都回答不了 ——
 * 而它一旦不成立，用户看到的就是一个永远转圈的界面（最典型的「看起来没坏」）。
 *
 * 做法（全部是真实链路，不用 mock）：
 *   ① 用 `SUPERTIME_DEBUG_HANG_METHODS=getSessions` 让 worker 对这条调用**不回包**
 *      （注入由主进程在 fork 时下发、打包态恒不生效，见 `src/backend/debug-gates.js`）；
 *   ② 用 `SUPERTIME_CALL_TIMEOUT_MS=1500` 把超时预算压到秒级，避免等 60 秒；
 *   ③ 打开「聊天会话」面板 → 断言 [role=alert] 出现「调用超时 … getSessions」，且骨架屏消失；
 *   ④ 切到「通讯录」（另一个方法）→ 断言它照常跑出空态 —— 证明超时没有让后续请求串台。
 *
 * 运行：node scripts/loading-recovery-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失（缺 playwright / electron.exe）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 被注入「永不回包」的方法：聊天会话面板挂载即调用它。 */
const HANG_METHOD = 'getSessions'
/** 压到秒级的调用超时（默认 60s，等不起）。 */
const CALL_TIMEOUT_MS = 1500

let _electron
try {
  ;({ _electron } = await import('playwright'))
} catch (e) {
  console.error('[前置] 缺少 playwright：', e.message)
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}

const results = []
const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail: String(detail) })
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

let app = null
let code = 0
const probeUserData = mkdtempSync(join(tmpdir(), 'super-time-loading-'))
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: probeUserData,
      SUPERTIME_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS),
      SUPERTIME_DEBUG_HANG_METHODS: HANG_METHOD,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
  await win.waitForLoadState('domcontentloaded')
  // 后端就绪（面板的数据调用要等它）
  await win.waitForTimeout(2500)

  // 空白数据下应用会先弹「首次配置向导」，它盖住主区域 —— 先关掉（「稍后再说」，会写进
  // localStorage 的 dismissed，之后不再弹），否则面板内容被它挡着，后续断言看到的全是向导文案。
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try {
    await later.waitFor({ state: 'visible', timeout: 5000 })
    await later.click()
  } catch { /* 没有向导（例如已有配置）也继续 */ }

  const logPath = join(probeUserData, 'wechat', 'logs', 'app.log')
  const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

  // ① 打开会话面板：它的挂载调用会命中注入，等主进程按预算收敛
  const chatsBtn = win.getByRole('button', { name: '聊天会话', exact: true })
  await chatsBtn.waitFor({ state: 'visible', timeout: 20000 })
  await chatsBtn.click()

  const alert = win.locator('[role="alert"]').first()
  let alertText = ''
  try {
    await alert.waitFor({ state: 'visible', timeout: 15000 })
    alertText = await alert.innerText()
  } catch {
    alertText = ''
  }
  check(alertText !== '', '超时后界面出现错误提示（而不是一直转圈）', alertText.slice(0, 160))
  check(/调用超时/.test(alertText), '提示文案说明是「调用超时」', alertText.slice(0, 160))
  check(alertText.includes(HANG_METHOD), '提示里带上了具体方法名（可诊断）', alertText.slice(0, 160))

  const skeletons = await win.locator('.nm-skel').count()
  check(skeletons === 0, 'loading 已解除（骨架屏元素清零）', `nm-skel=${skeletons}`)

  // ② 注入与超时都必须真的发生过（日志是主进程/worker 自己写的，不是界面自述）
  const log1 = readLog()
  check(/注入「永不回包」/.test(log1) && log1.includes(HANG_METHOD), 'worker 侧记录了注入命中', '')
  check(/调用超时/.test(log1), '主进程侧记录了超时收敛', '')

  // ③ 不串台：换一个方法（通讯录）。它必须**照常收尾** —— 要么空态（有数据源但没联系人），
  //    要么数据源错误；唯一不能出现的是「超时」（那才说明 pending 串了台）。
  //    本机跑的是空 userData，所以这里通常命中后者。
  const contactsBtn = win.getByRole('button', { name: '通讯录', exact: true })
  await contactsBtn.click()
  let settled = ''
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && settled === '') {
    const empty = await win.getByText('暂无联系人', { exact: true }).count().catch(() => 0)
    if (empty > 0) { settled = '暂无联系人（空态）'; break }
    const alerts = await win.locator('[role="alert"]').allInnerTexts().catch(() => [])
    const nonTimeout = alerts.filter((t) => !t.includes('调用超时'))
    if (nonTimeout.length > 0) { settled = nonTimeout[0].slice(0, 120); break }
    await win.waitForTimeout(300)
  }
  const timeoutAlerts = await win.locator('[role="alert"]', { hasText: '调用超时' }).count()
  check(settled !== '', '超时之后的下一条调用照常收尾（空态或数据源错误，都不是超时）', settled)
  // 顺带钉住文案：空数据源时面板必须说人话（中文 + 去哪配置），不能把 SQLite 英文原文甩给用户
  check(!/unable to open database file/i.test(settled) || settled.includes('数据配置'),
    '数据源缺失时是可执行的中文提示（而非原始英文报错）', settled.slice(0, 120))
  check(timeoutAlerts === 0, '新面板没有被上一条超时污染（无残留 alert）', `count=${timeoutAlerts}`)
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))
} catch (e) {
  console.error('测试执行异常:', e)
  code = 1
} finally {
  try { await app?.close() } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && existsSync(probeUserData); i += 1) {
    try { rmSync(probeUserData, { recursive: true, force: true }) } catch { await sleep(250) }
  }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.detail ? '  [' + r.detail + ']' : ''}`)
}
if (failed.length > 0 || code !== 0) {
  console.error(`\n❌ H7「超时解除 loading」端到端验证：${failed.length} 条不成立 / 共 ${results.length} 条`)
  process.exitCode = 1
} else {
  console.log(`\n✅ H7「超时解除 loading」端到端验证通过（${results.length} 项）`)
  process.exitCode = 0
}
