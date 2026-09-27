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
/** 文件夹具条数（面板分页 30 条一页 ⇒ 20 页；网格一行 4~6 格，够把"格子墙常驻 DOM"逼出来）。 */
const FILE_TOTAL = 600
/** DOM 节点硬上界：虚拟化后只渲染视口附近（含 overscan），300 已很宽松。 */
const MAX_DOM_NODES = 300
/** 收藏卡片的上界（卡片比消息行高，一屏十几张；200 已经宽松到能容纳 overscan + 测高抖动）。 */
const MAX_FAV_DOM_NODES = 200
/** 格子的上界（一屏 4~6 列 × 3~4 行 + overscan，200 同样宽松；渐进窗口在 600 条时必然是 600）。 */
const MAX_FILE_DOM_NODES = 200
/** 朋友圈夹具条数与每天几条（摊成 120 天，日期标签行也要跟着窗口走）。 */
const MOMENT_TOTAL = 1200
const MOMENTS_PER_DAY = 10
const MOMENT_USER = 'wxid_moments_owner'
/** 时间线行的上界（一屏 4~6 张卡片 + overscan 4 ⇒ 十几行；渐进窗口在 1200 条时必然是 1320 行）。 */
const MAX_MOMENT_DOM_ROWS = 80
/** 第 i 条附件的 md5（夹具与断言共用同一个算式，两端可达才谈得上"逐字对上")。 */
const fileMd5 = (i) => createHash('md5').update('supertime-file-' + i, 'utf8').digest('hex')
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

  // 文件夹具（#22 第三处：网格虚拟化）：`hardlink/hardlink.db` 的 `image_hardlink_info_v4`。
  // 名字取「md5 + .dat」—— 与真机一致（微信附件名本来就是哈希），前端 `fileKey` 会剥回 md5，
  // 于是 `data-file-key` 就是这一格该不该解码的键，两端可达可以逐字对上夹具。
  mkdirSync(join(decrypted, 'hardlink'), { recursive: true })
  const hdb = new DatabaseSync(join(decrypted, 'hardlink', 'hardlink.db'))
  hdb.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, file_name TEXT, file_size INTEGER, modify_time INTEGER, dir1 INTEGER, dir2 INTEGER)')
  const hins = hdb.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?,?,?,?,?,?)')
  hdb.exec('BEGIN')
  for (let i = 1; i <= FILE_TOTAL; i += 1) {
    const m = fileMd5(i)
    hins.run(m, m + '.dat', 1024 * i, 1700000000 + i, 1, 1)
  }
  hdb.exec('COMMIT')
  hdb.close()

  // 朋友圈夹具（#22 最后一处）：`sns/sns.db` 的 `SnsTimeLine`，按 `tid DESC` 出。
  // 1200 条摊到 120 天（每天 10 条）⇒ 时间线里既有动态行也有日期标签行，两样都要跟着窗口走。
  mkdirSync(join(decrypted, 'sns'), { recursive: true })
  const snadb = new DatabaseSync(join(decrypted, 'sns', 'sns.db'))
  snadb.exec('CREATE TABLE SnsTimeLine (tid INTEGER PRIMARY KEY, user_name TEXT, content TEXT)')
  const snains = snadb.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
  snadb.exec('BEGIN')
  for (let i = 1; i <= MOMENT_TOTAL; i += 1) {
    const day = Math.floor((i - 1) / MOMENTS_PER_DAY)
    const ts = 1700000000 + day * 86400 + i
    const text = i % 5 === 0 ? '第 ' + i + ' 条：' + '这条动态的正文故意写得长一些，卡片高度因此不同。'.repeat(4) : '第 ' + i + ' 条动态'
    const xml = '<msg><id><![CDATA[local_' + i + ']]></id><username><![CDATA[' + MOMENT_USER + ']]></username>'
      + '<createTime>' + String(ts) + '</createTime><contentDesc><![CDATA[' + text + ']]></contentDesc></msg>'
    snains.run(i, MOMENT_USER, xml)
  }
  snadb.exec('COMMIT')
  snadb.close()
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

  /*
   * —— 第三处：文件面板的网格（#22「推广」的最后一处长列表）——
   * 网格比列表多两件事：列数随容器宽度变（虚拟化数的是"行"），以及格子是异步解码的缩略图。
   * 这里量的还是同一个性质：**已加载的量与 DOM 格子数解耦**，两端各自可达。
   * 附件按 `modify_time DESC` 出 ⇒ 最新（i=FILE_TOTAL）在最前、最旧（i=1）在最后。
   */
  const filesBtn = win.getByRole('button', { name: '文件与存储', exact: true })
  await filesBtn.waitFor({ state: 'visible', timeout: 20000 })
  await filesBtn.click()
  await win.waitForSelector('[data-file-key]', { timeout: 20000 })
  /*
   * 滚动容器**每轮重新找**：这里曾经固定拿一次元素再反复滚，结果卡在第 2 页 ——
   * 首屏内容比容器还矮时，"能滚的祖先"这一判据会把指针交到外层页滚动容器上，
   * 于是内层那张格子墙（真正的 IO root）从头到尾没滚过，底部哨兵再也没进过视口。
   * 现在按 computed `overflow-y` 认（`auto`/`scroll` 才算），不依赖"此刻滚得动吗"。
   */
  const scrollFilesToBottom = () => win.evaluate(() => {
    const first = document.querySelector('[data-file-key]')
    let p = first ? first.parentElement : null
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      p = p.parentElement
    }
    if (!p) return null
    p.scrollTop = p.scrollHeight
    return { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, scrollTop: p.scrollTop }
  })
  let oldestSeen = false
  let fileBox = null
  for (let i = 0; i < 90 && !oldestSeen; i += 1) {
    fileBox = await scrollFilesToBottom()
    await win.waitForTimeout(220)
    oldestSeen = await win.locator(`[data-file-key="${fileMd5(1)}"]`).count() > 0
  }
  const fileScrollH = fileBox ? fileBox.scrollHeight : 0
  await scrollFilesToBottom()
  const fileNodesAtBottom = await win.locator('[data-file-key]').count()
  check(oldestSeen, `滚到底能看到最旧一格（data-file-key=${fileMd5(1).slice(0, 8)}…）`, `scrollHeight=${fileScrollH}`)
  check(fileScrollH > 3000, `滚动条长度证明远不止一屏已加载（scrollHeight ${fileScrollH}px）`, '')
  check(fileNodesAtBottom <= MAX_FILE_DOM_NODES,
    `底部 DOM 格子数有上界（实测 ${fileNodesAtBottom} ≤ ${MAX_FILE_DOM_NODES}）—— 渐进窗口在 600 条时必然是 600`, `nodes=${fileNodesAtBottom}`)

  await win.evaluate(() => {
    const first = document.querySelector('[data-file-key]')
    let p = first ? first.parentElement : null
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      p = p.parentElement
    }
    if (p) p.scrollTop = 0
  })
  await win.waitForTimeout(500)
  const fileNodesAtTop = await win.locator('[data-file-key]').count()
  check(await win.locator(`[data-file-key="${fileMd5(FILE_TOTAL)}"]`).count() > 0, `滚到顶能看到最新一格（i=${FILE_TOTAL}）`, '')
  check(fileNodesAtTop <= MAX_FILE_DOM_NODES, `回到顶部后 DOM 格子数仍有上界（实测 ${fileNodesAtTop}）`, `nodes=${fileNodesAtTop}`)
  await win.screenshot({ path: join(ROOT, '.tmp-e2e', 'n22-files-grid.png') }).catch(() => {})

  /*
   * —— 第四处：朋友圈时间线（#22 的最后一处）——
   * 这一处还多一条只有它有的线：媒体层的懒解密原先靠"渐进窗口渲染到第几组"重挂观察器，
   * 虚拟化之后渲染的是一个区间 ⇒ 面板把窗口指纹喂给媒体层。滚一遍看图片占位会不会卡死，
   * 是这条线唯一能被发现的方式（界面上不报错、后端也没收到请求）。
   */
  const momentsBtn = win.getByRole('button', { name: '朋友圈', exact: true })
  await momentsBtn.waitFor({ state: 'visible', timeout: 20000 })
  await momentsBtn.click()
  await win.waitForSelector('[data-moment-row]', { timeout: 20000 })
  const scrollMoments = (toTop) => win.evaluate((top) => {
    const first = document.querySelector('[data-moment-row]')
    let p = first ? first.parentElement : null
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      p = p.parentElement
    }
    if (!p) return null
    p.scrollTop = top ? 0 : p.scrollHeight
    return { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, scrollTop: Math.round(p.scrollTop) }
  }, toTop)
  // 「加载全部」是按钮驱动的（每页 500 条），点到位之后再量 DOM
  for (let i = 0; i < 6; i += 1) {
    const btn = win.getByRole('button', { name: /^加载全部/, exact: false })
    if (await btn.count() === 0) break
    await btn.first().click({ timeout: 4000 }).catch(() => {})
    await win.waitForTimeout(900)
  }
  let momentBox = null
  let momentRowsTotal = 0
  for (let i = 0; i < 25; i += 1) {
    momentBox = await scrollMoments(false)
    await win.waitForTimeout(220)
    momentRowsTotal = Number(await win.evaluate(() => {
      const el = document.querySelector('[data-moment-rows]')
      return el ? (el.dataset.momentRows ?? '0') : '0'
    }))
    if (momentRowsTotal > 0) break
  }
  const mountedRows = await win.locator('[data-moment-row]').evaluateAll((els) => els.map((e) => ({
    row: e.dataset.momentRow || '', idx: Number(e.dataset.index ?? '-1'),
  })))
  const maxIndex = mountedRows.reduce((a, b) => Math.max(a, b.idx), -1)
  const momentNodesAtBottom = mountedRows.length
  check(momentRowsTotal >= 100, `时间线确实是一张长列表（行 ${momentRowsTotal} = 动态 + 日期标签）`, `rows=${momentRowsTotal}`)
  // 「滚到底」的正确判据是"列表最后一行被挂上了"，而不是"tid=1 在不在"——
  // 面板能加载多少条受分页与作用域影响（那是另一件事），虚拟化要保证的是：窗口能走到行的末尾。
  check(maxIndex === momentRowsTotal - 1, `滚到底挂到了列表末尾那一行（末行下标 ${maxIndex} = 总行数 ${momentRowsTotal} − 1）`, `mounted=${momentNodesAtBottom}`)
  check(momentNodesAtBottom <= MAX_MOMENT_DOM_ROWS,
    `底部时间线 DOM 行有上界（实测 ${momentNodesAtBottom} ≤ ${MAX_MOMENT_DOM_ROWS}，总行数 ${momentRowsTotal}）—— 渐进窗口必然是 ${momentRowsTotal}`, `nodes=${momentNodesAtBottom}`)
  // 底部：那一天的标签行已滚出窗口，此刻必须由悬浮日期头补上"现在在哪一天"
  const floatAtBottom = await win.evaluate(() => document.querySelector('[data-moment-float-day]')?.dataset.momentFloatDay ?? '')
  // 滚回顶端：窗口要能走回去，并在那里量"顶端第一行是不是那一天的标签行"
  await scrollMoments(true)
  await win.waitForTimeout(500)
  const momentNodesAtTop = await win.locator('[data-moment-row]').count()
  const topRows = await win.locator('[data-moment-row]').evaluateAll((els) => els.map((e) => e.dataset.momentRow || ''))
  const floatAtTop = await win.evaluate(() => document.querySelector('[data-moment-float-day]')?.dataset.momentFloatDay ?? '')
  check(await win.locator(`[data-moment-row="${MOMENT_TOTAL}"]`).count() > 0, `滚到顶能看到最新一条（data-moment-row=${MOMENT_TOTAL}）`, '')
  check(momentNodesAtTop <= MAX_MOMENT_DOM_ROWS, `回到顶部后 DOM 行仍有上界（实测 ${momentNodesAtTop}）`, `nodes=${momentNodesAtTop}`)
  // 日期标签也算一行：顶端第一行就是最新那一天的标签行（标签与动态共用同一套下标）
  check(/^\d{4}-\d{2}-\d{2}$/.test(topRows[0] ?? ''), '日期标签也算一行：顶端第一行就是那一天的标签行', `rows=${topRows.slice(0, 3).join('|')}`)
  // 悬浮日期头：虚拟化让分组内 sticky 失效，换成按窗口顶端算 —— 顶端行本身就是标签时不重复出，
  // 而滚到底（那一天的标签行已滚出窗口）时必须由它补上"当前是哪一天"。
  check(floatAtTop === '' || floatAtTop === (topRows[0] ?? ''),
    `顶端不重复出日期头（悬浮头 ${floatAtTop || '不显示'}，行首 ${topRows[0] ?? ''}）`, '')
  check(floatAtBottom !== '' && floatAtBottom !== (topRows[0] ?? ''),
    `滚到底时悬浮日期头补上当前那一天（底部 ${floatAtBottom || '空'}，最新那天 ${topRows[0] ?? ''}）`, '')
  await win.screenshot({ path: join(ROOT, '.tmp-e2e', 'n22-moments.png') }).catch(() => {})

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
