/**
 * N18 验收：长列表（消息流）**DOM 节点数有硬上界**，且滚动到位、加载更多不跳位。
 *
 * 为什么需要它：这条验收要求在源码里看不出来 —— 当前实现是「渐进窗口」（`useProgressiveList` 的
 * `msgWinCount`，首屏 120 条，向上滚动时只增不减），所以**滚到底再滚回顶**之后，DOM 会把整段历史
 * 都留在页面上（1 万条消息就是 1 万个节点）。要证明它、以及证明改造后仍有上界，必须有一个能**真实
 * 滚动**的浏览器环境（仓库此前的 SSR 冒烟观测不到滚动）。
 *
 * 做法：合成一份 1 万条消息的解密数据根（直接写进临时 userData 的 `wechat-data/decrypted`，
 * 应用默认就会读它），用 Playwright 驱动真实 Electron：
 *   ① 点「加载更多」把 1 万条全部拉进内存（后端分页，按钮驱动）；
 *   ② 反复滚到顶，直到滚不动为止 —— 这一步会把「渐进窗口」的累积效果逼出来；
 *   ③ 断言：`[id^="msg-"]` 节点数 ≤ {@link MAX_DOM_NODES}、最早那条 `#msg-1` 可达、
 *      滚到底能到 `#msg-<total>`、以及「加载更多」不跳位（视图里那条消息的 rect.top 不位移）。
 *
 * 运行：node scripts/longlist-virtualization-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 合成消息总数（条目验收口径就是「1 万条」）。 */
const TOTAL = 10_000
/** 收藏夹具条数（#22 推广的第二处：面板分页 120 条一页，2400 条 = 20 页，够把"无界增长"逼出来）。 */
const FAV_TOTAL = 2400
/** DOM 节点硬上界：虚拟化后只渲染视口附近（含 overscan），300 已很宽松。 */
const MAX_DOM_NODES = 300
/** 收藏卡片的上界（卡片比消息行高，一屏十几张；200 已经宽松到能容纳 overscan + 测高抖动）。 */
const MAX_FAV_DOM_NODES = 200
const USER = 'wxid_n18'
const SESSION_NAME = 'N18 长列表夹具'

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

/**
 * 造一份「应用能直接读」的解密数据根：`<userData>/wechat-data/decrypted`。
 *
 * 表结构照抄各 spec 的夹具（`search-cursor.spec.ts` 等）：SessionTable + 每会话一张 `Msg_<md5(username)>`。
 * 文本长短交替，好让虚拟化面对**变高**项（全等高的夹具会让动态测高这条路径白跑）。
 * @param userData - 临时 userData 目录。
 */
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
  for (let i = 1; i <= TOTAL; i += 1) {
    // 长短交替 + 每 10 条一条特别长的：动态测高才有东西可测
    const body = i % 10 === 0
      ? `第 ${i} 条：` + '这是一条很长的消息，用来制造不同的行高。'.repeat(12)
      : (i % 2 === 0 ? `第 ${i} 条：短消息` : `第 ${i} 条：` + '中等长度'.repeat(6))
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, body, `srv${i}`, '')
  }
  mdb.exec('COMMIT')
  mdb.close()

  // 收藏夹具（#22 推广的第二处长列表）：`favorite/favorite.db` 的 `fav_db_item`，
  // 后端按 `update_time DESC` 出，所以 local_id 最大的那条排在列表**最前**。
  mkdirSync(join(decrypted, 'favorite'), { recursive: true })
  const fdb = new DatabaseSync(join(decrypted, 'favorite', 'favorite.db'))
  fdb.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT, fromusr TEXT, realchatname TEXT)')
  const fins = fdb.prepare('INSERT INTO fav_db_item VALUES (?,?,?,?,?,?)')
  fdb.exec('BEGIN')
  for (let i = 1; i <= FAV_TOTAL; i += 1) {
    const desc = i % 7 === 0 ? '摘要：' + '这一段故意写得长一些，让卡片高度真的不一样。'.repeat(4) : `收藏条目 ${i}`
    fins.run(i, 1, 1700000000 + i, `<fav><title>收藏 ${i}</title><desc>${desc}</desc><fromusr>wxid_fav_owner</fromusr></fav>`, 'wxid_fav_owner', '')
  }
  fdb.exec('COMMIT')
  fdb.close()
  return decrypted
}

const results = []
const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail: String(detail) })

let app = null
const userData = mkdtempSync(join(tmpdir(), 'super-time-n18-'))
try {
  makeFixture(userData)
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: userData,
      // 让后端读**合成**的解密根（否则「no data source configured」→ 会话列表为空）
      DSH_WECHAT_DATA_DIR: join(userData, 'wechat-data'),
      DSH_WECHAT_DECRYPTED_DIR: join(userData, 'wechat-data', 'decrypted'),
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)

  // 空白/合成数据下会先弹「首次配置向导」，关掉它（否则主区域被盖住）
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try { await later.waitFor({ state: 'visible', timeout: 5000 }); await later.click() } catch { /* 没有向导 */ }

  // 打开「聊天会话」→ 点进夹具会话
  const chatsBtn = win.getByRole('button', { name: '聊天会话', exact: true })
  await chatsBtn.waitFor({ state: 'visible', timeout: 20000 })
  await chatsBtn.click()
  // 会话行显示的是 username（显示名要 contact.db；本夹具没造它）
  const sessionRow = win.getByText(USER, { exact: false }).first()
  try {
    await sessionRow.waitFor({ state: 'visible', timeout: 20000 })
  } catch (e) {
    // 诊断：面板里到底显示了什么 + 应用日志（后端读的是哪个数据根）
    const body = await win.locator('body').innerText().catch(() => '')
    console.error('[诊断] 面板可见文本：', body.replace(/\s+/g, ' ').slice(0, 600))
    const logPath = join(userData, 'wechat', 'logs', 'app.log')
    console.error('[诊断] userData：', userData)
    console.error('[诊断] app.log：', existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n') : '(无)')
    throw e
  }
  await sessionRow.click()
  await win.waitForTimeout(1500)

  // 滚动容器：从消息节点往上找第一个「可滚动」祖先（CSS Modules 的类名是哈希的，不能写死）
  const box = await win.locator('[id^="msg-"]').first().evaluateHandle((el) => {
    let p = el.parentElement
    while (p && p.scrollHeight <= p.clientHeight + 4) p = p.parentElement
    return p
  })
  // 载入更多：按钮驱动（hasMore 为假时按钮消失）
  const loadMoreBtn = win.getByRole('button', { name: '加载更多', exact: true })
  // 「加载更多不跳位」：先拉几页，滚到中间，记下**当前视口里最上面那条**的位置，
  // 再点一次「加载更多」——那条消息必须还在原位（±40px），否则用户会觉得列表被拽走了。
  let clicks = 0
  for (; clicks < 6; clicks += 1) {
    if (await loadMoreBtn.count() === 0) break
    await loadMoreBtn.click({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(150)
  }
  const boxEarly = await win.locator('[id^="msg-"]').first().evaluateHandle((el) => {
    let p = el.parentElement
    while (p && p.scrollHeight <= p.clientHeight + 4) p = p.parentElement
    return p
  })
  // 「加载更多」不跳位：按钮就在滚动区**顶部**，所以先把视口滚到顶，取「按钮下方第一条可见消息」
  // 作为锚点，再点一次「加载更多」——那条消息必须还在视口里的同一位置（±40px）。
  // （注意：不能先滚到中间再点 —— Playwright 会把屏幕外的按钮滚进视野，测的就不是「不跳位」了。）
  await boxEarly.evaluate((el) => { el.scrollTop = 0 })
  await win.waitForTimeout(400)
  const anchorBefore = await win.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[id^="msg-"]'))
    const vis = rows.find((r) => r.getBoundingClientRect().top >= 0)
    return vis ? { id: vis.id, top: Math.round(vis.getBoundingClientRect().top) } : null
  })
  if (anchorBefore && await loadMoreBtn.count() > 0) {
    await loadMoreBtn.click()
    await win.waitForTimeout(900)
    const anchorAfter = await win.evaluate((id) => {
      const el = document.getElementById(id)
      return el ? Math.round(el.getBoundingClientRect().top) : null
    }, anchorBefore.id)
    const drift = anchorAfter === null ? null : Math.abs(anchorAfter - anchorBefore.top)
    check(anchorAfter !== null && drift !== null && drift <= 40,
      `加载更多不跳位（锚点 ${anchorBefore.id} 位移 ${drift === null ? '丢失' : drift + 'px'}）`, `before=${anchorBefore.top} after=${anchorAfter}`)
  } else {
    check(false, '加载更多不跳位（用例前提不成立：没找到锚点或按钮已消失）', '')
  }

  for (; clicks < 400; clicks += 1) {
    if (await loadMoreBtn.count() === 0) break
    try { await loadMoreBtn.click({ timeout: 3000 }) } catch { break }
    await win.waitForTimeout(120)
  }
  await win.waitForTimeout(800)
  const nodeCountAfterLoad = await win.locator('[id^="msg-"]').count()
  check(true, `已点「加载更多」${clicks} 次，当前 DOM 节点 ${nodeCountAfterLoad}`, '')
  check(clicks < 400, '后端分页能拉到最老一条（按钮消失）', `clicks=${clicks}`)

  // 滚到顶：反复滚，直到滚不动（渐进窗口会在这期间不断累积）
  let topReached = false
  for (let i = 0; i < 200; i += 1) {
    await box.evaluate((el) => { el.scrollTop = 0 })
    await win.waitForTimeout(150)
    const atTop = await box.evaluate((el) => el.scrollTop <= 2)
    if (atTop) { topReached = true; break }
  }
  await win.waitForTimeout(500)
  check(topReached, '能滚到列表顶部', '')

  const domNodes = await win.locator('[id^="msg-"]').count()
  check(domNodes <= MAX_DOM_NODES, `DOM 节点数有硬上界（实测 ${domNodes} ≤ ${MAX_DOM_NODES}）`, `nodes=${domNodes}`)
  check(await win.locator(`#msg-1`).count() > 0, '最老一条（#msg-1）在顶部可达', '')

  // 滚到底：最后一条可见
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await win.waitForTimeout(600)
  const lastVisible = await win.locator(`#msg-${TOTAL}`).count()
  check(lastVisible > 0, `滚到底能看到最后一条（#msg-${TOTAL}）`, '')

  /*
   * —— 第二处：收藏面板（#22「推广」那半条）——
   * 收藏原先也是渐进窗口（首屏 120、滚到底再增、只增不减）。这里把同一把尺子套上去：
   * 分页翻到底 ⇒ 记 DOM 里卡片数（必须与已加载条数解耦），再看两端是否各自可达。
   * 卡片选择器用 `data-fav-id`（后端按 update_time DESC 出，所以最大 id 在最前、最小 id 在最后）。
   */
  const favBtn = win.getByRole('button', { name: '收藏与表情', exact: true })
  await favBtn.waitFor({ state: 'visible', timeout: 20000 })
  await favBtn.click()
  await win.waitForSelector('[data-fav-id]', { timeout: 20000 })

  // 找到卡片所在的滚动容器（CSS Modules 类名是哈希的，按"能滚的祖先"找）
  const favBox = await win.locator('[data-fav-id]').first().evaluateHandle((el) => {
    let p = el.parentElement
    while (p && p.scrollHeight <= p.clientHeight + 4) p = p.parentElement
    return p
  })
  // 反复滚到底把分页翻完（哨兵在容器底部，靠 IntersectionObserver 触发下一页）
  let favLoaded = 0
  for (let i = 0; i < 120; i += 1) {
    await favBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await win.waitForTimeout(260)
    const n = Number(((await win.locator('body').innerText()).match(/全部 \((\d+)\)/) || [])[1] ?? '0')
    if (n >= FAV_TOTAL) { favLoaded = n; break }
    if (i > 4 && n === favLoaded) {
      // 连续两轮没长大 ⇒ 分页已经停了（没有下一页可翻），别再空转
      await win.waitForTimeout(600)
      if (n === favLoaded) break
    }
    favLoaded = n
  }
  check(favLoaded >= FAV_TOTAL, `收藏分页能翻到全部（实测「全部 (${favLoaded})」，夹具 ${FAV_TOTAL} 条）`, '')

  await win.waitForTimeout(400)
  // 滚到底要**反复滚**：最后几页是刚追加的，`measureElement` 会在这期间把估高换成真实高度，
  // 于是 scrollHeight 自己会长 —— 一次 `scrollTop = scrollHeight` 会差几行没到底
  // （消息流那侧没有分页，一次就够；这里必须循环，否则测的是"没滚到位"而不是"到不了底"）。
  let atFavBottom = false
  for (let i = 0; i < 15 && !atFavBottom; i += 1) {
    await favBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await win.waitForTimeout(250)
    atFavBottom = await win.locator('[data-fav-id="1"]').count() > 0
  }
  const favNodesAtBottom = await win.locator('[data-fav-id]').count()
  check(atFavBottom, '滚到底能看到最旧一条（data-fav-id=1）', '')
  check(favNodesAtBottom <= MAX_FAV_DOM_NODES,
    `收藏 DOM 卡片数有硬上界（底部实测 ${favNodesAtBottom} ≤ ${MAX_FAV_DOM_NODES}，已加载 ${favLoaded} 条）`, `nodes=${favNodesAtBottom}`)

  await favBox.evaluate((el) => { el.scrollTop = 0 })
  await win.waitForTimeout(600)
  const favNodesAtTop = await win.locator('[data-fav-id]').count()
  check(await win.locator(`[data-fav-id="${FAV_TOTAL}"]`).count() > 0, `滚到顶能看到最新一条（data-fav-id=${FAV_TOTAL}）`, '')
  check(favNodesAtTop <= MAX_FAV_DOM_NODES,
    `回到顶部后 DOM 卡片数仍有上界（实测 ${favNodesAtTop} ≤ ${MAX_FAV_DOM_NODES}）—— 渐进窗口的形状在这里必红`, `nodes=${favNodesAtTop}`)

  await win.screenshot({ path: join(ROOT, '.tmp-e2e', 'n18-longlist.png') }).catch(() => {})
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))
} catch (e) {
  console.error('测试执行异常:', e)
  results.push({ ok: false, label: '执行期异常', detail: String(e).slice(0, 200) })
} finally {
  try { await app?.close() } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && existsSync(userData); i += 1) {
    try { rmSync(userData, { recursive: true, force: true }) } catch { await sleep(250) }
  }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.detail ? '  [' + r.detail + ']' : ''}`)
console.log(failed.length === 0
  ? `\n✅ N18 长列表验收通过（${results.length} 项）`
  : `\n❌ N18 长列表验收：${failed.length} 条不成立 / 共 ${results.length} 条`)
process.exitCode = failed.length === 0 ? 0 : 1
