#!/usr/bin/env node
/**
 * H8 的验收项「导出期间 UI 保持可交互，其他面板查询不被阻塞超过 1 秒」—— 真机量一次。
 *
 * 这一条原先只打过**查询层**的桩：台账里那句「20 万条导出期间事件循环最长阻塞 73ms」
 * 量的是后端进程内部的循环占用，不是用户那侧的体感。用户真正会问的是
 * 「我正在导出，此时点别的面板要等多久」—— 那要穿过 渲染进程 → 主进程 → 后端 worker
 * 整条往返，只能跑真应用。（同一套骨架见 `export-progress-e2e.mjs` 的文件头说明。）
 *
 * 必须先量基线：第一次 RPC 往返本身就有冷启动代价（后端首次建会话列表索引、许可/隐私闸门
 * 初始化…），不拿基线对照就会把冷启动误读成「被导出阻塞」—— 第一版就栽过这个坑
 * （第一次探测 2547ms，而后面的探测 1–3ms）。
 *
 * 运行：node scripts/export-nonblocking-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const TOTAL = 40_000
const USER = 'wxid_m3nb'
/** 验收口径写死在这里：H8 要的是「不超过 1 秒」。 */
const LIMIT_MS = 1000

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

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail: String(detail) })
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail)}`)
}

function makeFixture(userData) {
  const decrypted = join(userData, 'wechat-data', 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, \'\')')
    .run(USER, 'H8 延迟夹具', 1700000000 + TOTAL, 1700000000 + TOTAL)
  sdb.close()
  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = 1; i <= TOTAL; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `第 ${i} 条消息`, i, '')
  mdb.exec('COMMIT')
  mdb.close()
  return decrypted
}

/** 渲染进程 → 主进程 → 后端 worker 的一次完整往返（就是用户点面板时发生的事）。 */
async function probe(win, method, args) {
  return win.evaluate(async ([m, a]) => {
    const t = performance.now()
    const res = await window.electronAPI.wechat.call(m, a)
    return { ms: Math.round(performance.now() - t), ok: !!(res && res.ok), err: res && res.error ? String(res.error.message ?? res.error) : '' }
  }, [method, args])
}

let app = null
const userData = mkdtempSync(join(tmpdir(), 'super-time-m3nb-'))
try {
  const decrypted = makeFixture(userData)
  const exportsDir = join(userData, 'wechat-data', 'exports')
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: userData,
      DSH_WECHAT_DATA_DIR: join(userData, 'wechat-data'),
      DSH_WECHAT_DECRYPTED_DIR: decrypted,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => { pageErrors.push(String(e.message).slice(0, 200)) })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try { await later.waitFor({ state: 'visible', timeout: 5000 }); await later.click() } catch { /* 没有向导 */ }
  await win.evaluate(() => {
    window.__prog = []
    window.addEventListener('dsh-wechat-export-progress', (e) => { window.__prog.push(e.detail) })
  })
  await win.getByRole('button', { name: '聊天会话', exact: true }).click()
  const sessionRow = win.getByText(USER, { exact: false }).first()
  await sessionRow.waitFor({ state: 'visible', timeout: 30000 })
  await sessionRow.click()
  await win.waitForTimeout(1200)

  // ── 基线：没有任何导出在跑时，同样的往返要多久 ─────────────────────
  const baseline = []
  for (const [m, a] of [['getSessions', {}], ['getSessions', {}], ['getSessions', {}]]) {
    baseline.push({ m, ...(await probe(win, m, a)) })
  }
  const baseMax = Math.max(...baseline.map((x) => x.ms))
  check(baseline.every((x) => x.ok), '基线探测本身都成功（否则后面的对照没有意义）',
    baseline.map((x) => `${x.m} ${x.ms}ms${x.ok ? '' : ' 失败'}`).join(' | '))
  console.log(`  ℹ 基线（无导出）：${baseline.map((x) => `${x.m}=${x.ms}ms`).join('  ')}  峰值 ${baseMax}ms`)

  // ── 起一个 4 万条的导出，跑的同时重复同样的探测 ────────────────────
  await win.getByRole('button', { name: '更多', exact: true }).click()
  await win.getByRole('menuitem', { name: /导出消息/ }).click()
  const exportBtn = win.getByRole('button', { name: '导出', exact: true })
  await exportBtn.waitFor({ state: 'visible', timeout: 15000 })
  await win.getByRole('button', { name: 'Excel', exact: true }).click()
  await win.getByRole('button', { name: '全部', exact: true }).click()
  await win.evaluate(() => { window.__prog = [] })
  await exportBtn.click()

  const during = []
  let sawRunning = false
  for (let i = 0; i < 6; i += 1) {
    const before = await win.evaluate(() => (window.__prog ?? []).length)
    const m = 'getSessions'
    const r = await probe(win, m, {})
    const after = await win.evaluate(() => (window.__prog ?? []).length)
    const running = after > before || r.ms > 30
    if (after > before) sawRunning = true
    during.push({ m, ...r, events: after - before })
    if (during.length >= 3 && sawRunning) break
    await sleep(120)
  }
  const durMax = Math.max(...during.map((x) => x.ms))
  console.log(`  ℹ 导出中：${during.map((x) => `${x.m}=${x.ms}ms(+${x.events}格进度)`).join('  ')}  峰值 ${durMax}ms`)
  check(sawRunning, '探测期间导出确实还在推进（否则这条什么也没证明）',
    `进度事件增量 ${during.map((x) => x.events).join('/')}`)
  check(during.every((x) => x.ok), '导出期间的其它查询都成功返回（没有超时、没有报错）',
    during.map((x) => x.ok ? `${x.m}=ok` : `${x.m}=失败:${x.err}`).join(' '))
  check(durMax < LIMIT_MS, `导出期间的查询往返都 < ${LIMIT_MS / 1000} 秒（H8 验收项）`,
    `峰值 ${durMax}ms（基线峰值 ${baseMax}ms）`)
  check(durMax <= Math.max(baseMax, 100) * 3 + 200, '相对基线没有量级退化（排除冷启动误读）',
    `导出中 ${durMax}ms vs 基线 ${baseMax}ms`)

  // ── 界面点得动吗：导出期间切到别的面板再切回来 ────────────────────
  const before = (await win.locator('body').innerText()).replace(/\s+/g, ' ')
  const other = win.getByRole('button', { name: '朋友圈', exact: true }).first()
  const target = (await other.count()) > 0 ? other : win.getByRole('button').filter({ hasText: /^(收藏|文件|设置)$/ }).first()
  const targetName = await target.innerText().catch(() => '?')
  await target.click()
  await win.waitForTimeout(900)
  const after = (await win.locator('body').innerText()).replace(/\s+/g, ' ')
  check(after !== before, `导出期间点「${targetName}」面板真的换了视图`, after.slice(0, 90))
  await win.getByRole('button', { name: '聊天会话', exact: true }).first().click()
  await win.waitForTimeout(600)

  if (await win.getByRole('button', { name: '中止导出', exact: true }).count() > 0) {
    await win.getByRole('button', { name: '中止导出', exact: true }).click()
    await sleep(1500)
  }
  const residue = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.includes('.partial-')) : []
  check(residue.length === 0, '收尾后导出目录没有 `.partial-*` 半成品', residue.join(', '))
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))
  writeFileSync(join(ROOT, '.tmp-e2e', 'h8-latency.json'), JSON.stringify({ baseline, during, baseMax, durMax }, null, 2), 'utf8')
} catch (e) {
  console.error('测试执行异常:', e)
  results.push({ ok: false, label: '执行期异常', detail: String(e).slice(0, 300) })
} finally {
  try { await app?.close() } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && existsSync(userData); i += 1) {
    try { rmSync(userData, { recursive: true, force: true }) } catch { await sleep(250) }
  }
}

const bad = results.filter((r) => !r.ok)
console.log(`\nH8 导出不阻塞验收：${results.length - bad.length}/${results.length} 成立`)
if (bad.length > 0) {
  console.log('未成立：')
  for (const b of bad) console.log(`  · ${b.label}${b.detail ? ' —— ' + b.detail : ''}`)
  process.exit(1)
}
process.exit(0)
