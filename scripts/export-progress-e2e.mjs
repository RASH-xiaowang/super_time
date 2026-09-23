#!/usr/bin/env node
/**
 * M3 真机验收：导出进度条**真的在动**、「中止」**真的停下**、成功路径**真的落盘**。
 *
 * 为什么单独写一个脚本（`export-progress-job.spec.ts` 已经覆盖过网关行为）：那条用例证明的是
 * 后端会推事件、会取消；它**看不见中继** —— 事件要经 后端 → 主进程 → `ui-entry.tsx` → DOM 事件
 * → 面板 这五段才成为界面上的一格进度。整条链只能跑真应用：
 *   ① 合成一份 4 万条消息的解密根（直接写进临时 userData，应用默认就读它）；
 *   ② 用 Playwright 驱动真实 Electron，走界面：更多 → 导出消息 → 选 Excel/全部 → 导出；
 *   ③ 断言 `[role=progressbar]` 的 aria-valuenow 与「phase · done」文案都在往前走；
 *   ④ 点「中止导出」，断言进度行消失、按钮从「导出中…」回到「导出」、提示是**已取消**而不是失败、
 *      导出目录里没有 `.partial-*` 半成品（取消走的是 temp+rename，不留脏文件）；
 *   ⑤ 再按界面导一份「TXT · 100 条」，断言对话框关掉、标题栏报「已导出 100 条」、文件真在磁盘上。
 *
 * 单实例锁不是障碍：`requestSingleInstanceLock` 的锁文件在 userData 里，
 * `SUPERTIME_USER_DATA_DIR` 换一份 userData 就与正在跑的正式实例互不影响。
 *
 * 运行：node scripts/export-progress-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失（没有 playwright / electron）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
/** 够大到能看清进度：4 万条 ⇒ 收集 400 页、xlsx 200 个块。 */
const TOTAL = 40_000
const USER = 'wxid_m3e2e'
const SESSION_NAME = 'M3 进度夹具'

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

/** 造一份应用读得到的解密根（会话 + 单会话消息分片）。 */
function makeFixture(userData) {
  const decrypted = join(userData, 'wechat-data', 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, \'\')')
    .run(USER, SESSION_NAME, 1700000000 + TOTAL, 1700000000 + TOTAL)
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

/**
 * 读导出对话框里的进度：`{ bar: aria-valuenow | null, indeterminate, caption }`。
 *
 * 一次 `evaluate` 读完整套 DOM，而不是「先 count 再 getAttribute」分两次问 —— 分两次问会在
 * 自己中间留出一个竞态：进度行正好在那两步之间消失时，`getAttribute` 会去等一个已经不存在的
 * 元素，30 秒后超时把整条 e2e 打死（CI 上真红过一次：`中止后进度行收掉` 那个轮询循环里）。
 * 而「行消失了」本来就是我们要观测的**成功条件**，绝不该变成执行异常。
 */
async function readProgress(win) {
  return win.evaluate(() => {
    // 只看**导出对话框里**那根进度条：整个文档的 `querySelector` 会先撞上别处的
    // `[role="progressbar"]`（数据配置页的「检测账号」也有一根），于是采到的 caption
    // 是别的面板的文字 —— CI 上那条「样本 400：检测账号扫描本机微信账号…」就是这么来的。
    const box = document.querySelector('[role="dialog"]')
    const el = box ? box.querySelector('[role="progressbar"]') : null
    if (!el) return { bar: null, indeterminate: false, caption: '' }
    const now = el.getAttribute('aria-valuenow')
    const next = el.nextElementSibling
    return {
      bar: now === null ? null : Number(now),
      indeterminate: el.hasAttribute('data-indeterminate'),
      caption: (next?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }
  })
}

/**
 * 「现在这个窗口到底停在哪儿」的一份快照 —— **一次 evaluate 取全**（分多次问就会在
 * 界面自己变的中间留下没法解释的空隙）。
 *
 * 为什么要它：CI 上红过一次「中继事件 0 条 + 采到的 caption 是数据配置页的文字」，
 * 然后卡在等「中止导出」的 30 秒超时上 —— 报告里只看得见一个 TimeoutError，看不出
 * 界面是什么时候离开聊天面板的。有了这份快照，下一次红会自己说清楚。
 */
async function snapshot (win) {
  const s = await win.evaluate(() => ({
    url: String(location.href).slice(0, 120),
    bars: document.querySelectorAll('[role="progressbar"]').length,
    dialog: !!document.querySelector('[role="dialog"]'),
    stopBtn: Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('中止导出')),
    body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 220),
  }))
  return `url=${s.url} 进度条×${s.bars} 对话框=${s.dialog ? '开' : '关'} 中止按钮=${s.stopBtn ? '在' : '不在'} 页面文字「${s.body}」`
}

let app = null
const userData = mkdtempSync(join(tmpdir(), 'super-time-m3e2e-'))
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
  // 故意用**矮视口**（导出对话框的内容比它高）：CI runner 就是这种尺寸，而当时「中止导出」
  // 整颗按钮在视口之外点不到 —— 那暴露的是弹窗不可滚的产品缺陷（Playwright 报
  // element is outside of the viewport）。修好之后这条仍要用矮视口跑，
  // 否则同样的缺陷会再次只在 CI 现形。
  await win.setViewportSize({ width: 1280, height: 620 })
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => { pageErrors.push(String(e.message).slice(0, 200)) })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try { await later.waitFor({ state: 'visible', timeout: 5000 }); await later.click() } catch { /* 没有向导 */ }

  await win.getByRole('button', { name: '聊天会话', exact: true }).click()
  const sessionRow = win.getByText(USER, { exact: false }).first()
  await sessionRow.waitFor({ state: 'visible', timeout: 30000 })
  await sessionRow.click()
  await win.waitForTimeout(1200)

  const exportBtn = win.getByRole('button', { name: '导出', exact: true })

  /** 打开导出对话框（走界面：更多 → 导出消息）。模态开着时「更多」点不动，所以每次都得等它关掉。 */
  const openExportDialog = async () => {
    await win.getByRole('button', { name: '更多', exact: true }).click()
    await win.getByRole('menuitem', { name: /导出消息/ }).click()
    await exportBtn.waitFor({ state: 'visible', timeout: 15000 })
  }
  const dialogOpen = async () => (await exportBtn.count()) > 0

  // 先在渲染层装一个事件记录器：进度是**异步**推来的，100 条这种小导出可能在下一次轮询前就完了。
  // 有了它，「中继真的把事件送到 window」这件事不再依赖轮询窗口撞上。
  await win.evaluate(() => {
    window.__prog = []
    window.addEventListener('dsh-wechat-export-progress', (e) => { window.__prog.push(e.detail) })
  })

  // ── ① Excel · 100 条：总量已知 ⇒ 中继里每条进度都带 done/total ──────
  await openExportDialog()
  await win.getByRole('button', { name: 'Excel', exact: true }).click()
  await win.getByRole('button', { name: '100 条', exact: true }).click()
  await exportBtn.click()
  let knownEvents = []
  for (let i = 0; i < 80; i += 1) {
    const s = await readProgress(win)
    if (s.bar !== null && s.bar > 0) break
    knownEvents = await win.evaluate(() => window.__prog ?? [])
    if (knownEvents.some((e) => Number(e.total ?? 0) > 0)) break
    await sleep(80)
  }
  knownEvents = await win.evaluate(() => window.__prog ?? [])
  const known = knownEvents
  check(known.length > 0, '小导出也经中继推到渲染层（不止轮询那条兜底路）',
    // 一条都没到时把界面停在哪儿一起报出来：CI 上那种「事件 0 + 采到设置页文字」的红，
    // 光看数字分不清是桥接没通、还是窗口早就离开了聊天面板。
    `事件 ${known.length}${known.length === 0 ? '；' + (await snapshot(win)) : ''}`)
  check(known.every((e) => /^chats-export-/.test(String(e.jobId))), '事件都挂在本轮导出的 jobId 上',
    [...new Set(known.map((e) => String(e.jobId)))].join(','))
  check(known.some((e) => Number(e.total ?? 0) > 0 && Number(e.done ?? 0) > 0 && Number(e.done ?? 0) <= Number(e.total ?? 0)),
    '总量已知时进度给出可核对的 done ≤ total',
    known.slice(0, 4).map((e) => `${e.phase} ${e.done}/${e.total}`).join(' | '))
  let okMsg = ''
  for (let i = 0; i < 100; i += 1) {
    await sleep(150)
    okMsg = (await win.locator('body').innerText()).match(/已导出[^\n]*/)?.[0] ?? ''
    if (okMsg) break
  }
  check(/已导出 100 条/.test(okMsg), '成功提示给出条数与路径', okMsg || '(没等到)')
  check(!(await dialogOpen()), '导出完成后对话框自动关闭', '')
  const xlsx = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.xlsx')) : []
  check(xlsx.length === 1, '导出目录里正好一个 xlsx', xlsx.join(', '))
  // xlsx 是 zip，读明文没用；验大小量级即可（表头 + 100 行 ⇒ 几十 KB，绝不是全量）
  if (xlsx.length === 1) {
    const size = readFileSync(join(exportsDir, xlsx[0])).length
    check(size < 200_000, '产物只有 100 条的量级（不是把 4 万条全写了）', `字节 ${size}`)
  }

  // ── ② Excel · 全部：总量未知 ⇒ 走不定量态，然后中止 ────────────────
  await openExportDialog()
  await win.getByRole('button', { name: 'Excel', exact: true }).click()
  await win.getByRole('button', { name: '全部', exact: true }).click()
  await exportBtn.click()
  check(await win.getByRole('button', { name: '中止导出', exact: true }).count() > 0,
    '导出中给出「中止导出」入口', '')

  /** 同一阶段内的 done 序列（不同阶段的量纲不同：collect 是条、write 是字节）。 */
  const byPhase = new Map()
  const indeterminate = []
  const samples = []
  for (let i = 0; i < 400; i += 1) {
    const s = await readProgress(win)
    if (s.caption) {
      samples.push(s)
      const m = s.caption.match(/^(.+?) · (\d+)(?: \/ (\d+))?$/)
      if (m) {
        const ph = m[1] ?? ''
        byPhase.set(ph, [...(byPhase.get(ph) ?? []), Number(m[2])])
      }
      if (s.indeterminate) indeterminate.push(s)
    }
    // 采到同一阶段里两次增长就够定案了：再多等只会撞上「导出已完成」
    const grew = [...byPhase.values()].some((xs) => new Set(xs).size >= 2 && xs[xs.length - 1] > xs[0])
    if (grew && indeterminate.length > 0) break
    await sleep(100)
  }
  const grewPhase = [...byPhase.entries()].find(([, xs]) => new Set(xs).size >= 2 && xs[xs.length - 1] > xs[0])
  check(samples.length >= 2, '界面上采到多格进度（不是一次性快照）', `样本 ${samples.length}`)
  check(!!grewPhase, '同一阶段内的进度数字在往前走',
    grewPhase ? `${grewPhase[0]}: ${grewPhase[1].slice(0, 3).join(' → ')}` : `分阶段：${JSON.stringify([...byPhase.entries()].map(([k, v]) => [k, v.slice(0, 2)]))}`)
  check(indeterminate.length > 0, '总量未知时进度条走不定量态（而不是钉在 0%）',
    `样本 ${samples.length}：${samples.slice(0, 3).map((s) => s.caption).join(' | ')}`)

  // ── ③ 中止：停在终态、提示是取消而不是失败、不留半成品 ─────────────
  const stopBtn = win.getByRole('button', { name: '中止导出', exact: true })
  // 先**有界地**等它出现（最多 10 秒）：拿不到就把「中止」这一档记成一条带快照的失败并整段跳过，
  // 而不是让 Playwright 在 30 秒超时里把整条 e2e 打死 —— 那样后面的检查一条都不会跑，
  // 报告里只剩一个 TimeoutError（CI 上就是这么红过一次，且没人看得出界面当时停在哪儿）。
  let stopVisible = false
  for (let i = 0; i < 50 && !stopVisible; i += 1) {
    stopVisible = (await stopBtn.count()) > 0
    if (!stopVisible) await sleep(200)
  }
  check(stopVisible, '全量导出进行中时「中止导出」一直在（③ 这一档的前提）',
    stopVisible ? '' : '等满 10 秒仍没有这颗按钮；' + (await snapshot(win)))
  if (stopVisible) {
    // **真鼠标点击必须成功** —— 这一条本身就是断言：矮视口下弹窗溢出时必须滚得到那颗按钮
    // （CI 上第一轮红就是它：`element is outside of the viewport`，覆盖层不可滚 ⇒ 用户也点不到）。
    // 允许重试三次：进度事件会让那一带反复重渲染、节点短暂脱离 DOM；
    // 而「兜底改成 JS 点击」一旦用上就把这条检查判红 —— 不能悄悄把工作绕过缺陷的那一步吞掉。
    let domClickFallback = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await stopBtn.click({ timeout: 8000 })
        break
      } catch {
        if (attempt === 2) {
          domClickFallback = true
          await stopBtn.evaluate((el) => { el.click() })
        } else {
          await sleep(250)
        }
      }
    }
    check(!domClickFallback, '矮视口下「中止导出」用真鼠标就点得到（弹窗溢出必须可滚）',
      domClickFallback ? '退到了 DOM 级 click ⇒ 按钮仍在视口外/不可达' : '')
    let stopped = false
    for (let i = 0; i < 100; i += 1) {
      await sleep(150)
      const s = await readProgress(win)
      const again = await win.getByRole('button', { name: '导出', exact: true }).count()
      if (s.bar === null && !s.caption && again > 0) { stopped = true; break }
    }
    check(stopped, '中止后进度行收掉、按钮恢复（不卡在「导出中…」）', '')
    const header = await win.locator('body').innerText()
    check(/已取消导出/.test(header), '提示是「已取消导出」', header.match(/[^\n]*取消[^\n]*/)?.[0] ?? '(没找到)')
    check(!/导出失败/.test(header), '取消没有被报成失败', header.match(/导出失败[^\n]*/)?.[0] ?? '')
    const residue = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.includes('.partial-')) : []
    check(residue.length === 0, '导出目录里没有 `.partial-*` 半成品', residue.join(', '))
    const produced = existsSync(exportsDir) ? readdirSync(exportsDir) : []
    check(produced.length === 1, '被取消的导出没有新增产物（只有 ① 那一个 xlsx）', produced.join(', '))
  }
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))
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
console.log(`\nM3 导出进度真机验收：${results.length - bad.length}/${results.length} 成立`)
if (bad.length > 0) {
  console.log('未成立：')
  for (const b of bad) console.log(`  · ${b.label}${b.detail ? ' —— ' + b.detail : ''}`)
  process.exit(1)
}
process.exit(0)
