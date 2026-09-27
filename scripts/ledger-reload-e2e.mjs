/**
 * P2-4 的真机打点：账本重算多贵、二次进页与事件风暴期间"旧值还在不在屏上"。
 *
 * 为什么需要它：审查报告 §P2-4 那句「同步活跃期约每 10s 重算一次约 250ms 的无缓存重查询」
 * 是**读代码得出的因果链**，台账里也照实写着「报告要求的『先真机打点』没做」。
 * 这条脚本把那句话说成可复跑的数 —— 真 Electron、真后端、真事件总线。
 *
 * ## 为什么量"画面上有没有"，不量"打了几次 RPC"
 *
 * 第一版想在渲染层给 `electronAPI.wechat.call` 套计数器，量出来一片 0：
 * `electronAPI` 是 **contextBridge 交给页面世界的只读快照**，从页面里改 `wechat.call` 静默无效
 * （手工直调照样通，但走的是原函数）。要拿到调用次数就得给宿主协议开一条"活账本"通道 ——
 * 为了测量去动产品面，不划算。
 * 于是这里量两件**用户看得见**的事，它们正是 P2-4 修复要兑现的东西：
 *   · 二次进入总览时资金数字是不是**首帧就在**（是 ⇒ 没有"等回源"这一说）；
 *   · 连发数据更新事件期间它会不会**闪回空 / 闪回骨架**（不闪 ⇒ 旧值立刻可画、复验在后台）。
 * 再加一次直调 `getLedger` 的真实耗时，把"约 250ms"换成一个带夹具口径的实测数。
 *
 * ## 两条哨兵（都是"这个信号能为假"的对照，不是走过场）
 *
 *  ① 骨架屏：`?skeleton=1` 是产品自己的调试开关（`overview-panel.tsx` 认它），打开就必须看得见
 *     骨架节点 —— 看不见说明选择器/钩子是坏的，后面所有"没闪骨架"的结论都不作数；
 *  ② 资金标记：离开总览之后屏上必须**没有**那个词 —— 不然"二次进入首帧就有"是同义反复。
 *
 * 页签切换必须**点导航按钮**：`WechatDataPanel` 只在挂载时读一次 `location.hash`（没有
 * `hashchange` 订阅），写 hash 不会换页 —— 第一版因此"切"了个寂寞，二次进入那条变成同义反复。
 *
 * 运行：node scripts/ledger-reload-e2e.mjs（或 npm run e2e:ledger-reload）
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 消息分片数与每片条数。 */
const SHARDS = 3
const PER_SHARD = 800
/** 资金行数（transfer + redEnvelope），决定账本两趟扫描的宽度。 */
const TRANSFERS = 60
const REDPACKETS = 40
const USER = 'wxid_a'
/** 事件风暴：连发几个「解密数据有更新」。真实同步活跃期约每 10s 一个，这里压到 300ms 一个。 */
const BURST = 6

const msgTable = (username) => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
const TRANSFER_XML = '<msg><appmsg><type>2000</type><wcpayinfo><paysubtype>3</paysubtype><feedesc>￥10.00</feedesc></wcpayinfo></appmsg></msg>'
const REDPACKET_XML = '<msg><appmsg><type>2001</type><wcpayinfo><feedesc>￥8.88</feedesc></wcpayinfo></appmsg></msg>'
/** 页面里两个信号的判据串（骨架：通用 `nm-skel` 与总览面板那套 CSS Module 哈希后的 `skeleton`）。 */
const IN_PAGE = {
  skelSel: '.nm-skel, [class*="skeleton"]',
  moneyMark: '资金快照',
}

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
const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail: String(detail) })

/** 造一份够重的解密根：账本要扫的就是这些分片。 */
function makeFixture(userData) {
  const decrypted = join(userData, 'wechat-data', 'decrypted')
  for (const sub of ['session', 'message', 'contact', 'general']) mkdirSync(join(decrypted, sub), { recursive: true })
  const baseTs = Math.floor(new Date(2026, 8, 1, 9).getTime() / 1000)

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable VALUES (?, ?, ?, ?, 0, 1, ?)').run(USER, '打点夹具', baseTs, baseTs, '')
  sdb.close()

  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
  cdb.prepare('INSERT INTO contact (id, username, remark, nick_name) VALUES (1, ?, ?, ?)').run(USER, '张三', 'zhangsan')
  cdb.close()

  const gdb = new DatabaseSync(join(decrypted, 'general', 'general.db'))
  gdb.exec('CREATE TABLE transferTable (session_name TEXT, message_server_id INTEGER, second_message_server_id INTEGER, pay_receiver TEXT, pay_payer TEXT, begin_transfer_time INTEGER, invalid_time INTEGER)')
  gdb.exec('CREATE TABLE redEnvelopeTable (session_name TEXT, message_server_id INTEGER, sender_user_name TEXT, hb_status INTEGER)')
  const tIns = gdb.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < TRANSFERS; i += 1) tIns.run(USER, 1001 + i, 0, USER, 'wxid_b', baseTs + i * 60, 0)
  const rIns = gdb.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?, ?)')
  for (let i = 0; i < REDPACKETS; i += 1) rIns.run(USER, 2001 + i, USER, 1)
  gdb.close()

  const table = msgTable(USER)
  for (let shard = 1; shard <= SHARDS; shard += 1) {
    const mdb = new DatabaseSync(join(decrypted, 'message', `message_${shard}.db`))
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`)
    for (let i = 0; i < PER_SHARD; i += 1) {
      const n = (shard - 1) * PER_SHARD + i
      const isPay = n % 12 === 0
      const serverId = isPay ? 1001 + (n / 12) % (TRANSFERS + REDPACKETS) : 90000 + n
      ins.run(n + 1, baseTs + n, isPay ? 49 : 1, isPay ? TRANSFER_XML : `打点消息 #${n}`, serverId)
    }
    for (let i = 0; i < 20; i += 1) {
      ins.run(500000 + shard * 1000 + i, baseTs + i, 49, REDPACKET_XML, 2001 + ((shard - 1) * 20 + i) % REDPACKETS)
    }
    mdb.close()
  }
  return decrypted
}

const userData = mkdtempSync(join(tmpdir(), 'super-time-ledger-probe-'))
let app = null
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
      DSH_WECHAT_DATA_DIR: join(userData, 'wechat-data'),
      DSH_WECHAT_DECRYPTED_DIR: join(userData, 'wechat-data', 'decrypted'),
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))

  /** 装页面探针（骨架新增计数 + 「这一格真的画在屏上吗」）。页面重新加载之后必须再装一次。 */
  const installProbe = () => win.evaluate((cfg) => {
    window.__skel = 0
    // 页签是保活的（切走不卸载），所以"屏上有没有"必须问**可见性**，不能只查 innerText ——
    // 只查文本的话，藏在折叠页签里的同一句标题会让"离开之后应该没有"永远为假。
    window.__money = () => [...document.querySelectorAll('h1, h2, h3, h4, div, span, p, section')]
      .filter((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(cfg.moneyMark))
      .some((el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null))
    const obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n instanceof HTMLElement && (n.matches(cfg.skelSel) || n.querySelector(cfg.skelSel))) window.__skel += 1
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
  }, IN_PAGE)
  const skel = () => win.evaluate(() => window.__skel ?? -1)
  const skelDom = () => win.evaluate((sel) => document.querySelectorAll(sel).length, IN_PAGE.skelSel)
  const money = () => win.evaluate(() => (window.__money ? window.__money() : false))
  const settled = async () => {
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(6000)
    const later = win.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.count() > 0) await later.first().click().catch(() => {})
    await win.waitForTimeout(1500)
  }
  /**
   * 切页签：**必须点导航按钮** —— `WechatDataPanel` 只在挂载时读一次 `location.hash`
   * （没有 `hashchange` 订阅），写 hash 不会换页；第一版就因此"切"了个寂寞，
   * 于是"离开总览之后标记消失"这条假对照反而一直为真，量出来的全是假绿。
   *
   * 导航是分组折叠的：第一次点可能只是把那一组展开，所以要**点到位**（以 `location.hash`
   * 真的变成这一页为凭），而不是点过就算 —— `setActive` 会把页签键写回 hash，这就是一条
   * 能分辨"点没点上"的现成信号。
   * @param key - 页签键（`location.hash` 应当变成 `#key`）。
   * @param label - 导航按钮上的中文标签。
   * @param waitMs - 到位之后再等待多久（0 = 立刻返回，用于"只等一帧"那种判据）。
   */
  const gotoTab = async (key, label, waitMs = 2000) => {
    const btn = win.getByRole('button', { name: label, exact: true }).first()
    await btn.waitFor({ state: 'visible', timeout: 15000 })
    let hash = ''
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await btn.click({ timeout: 5000 }).catch(() => {})
      await win.waitForTimeout(500)
      hash = await win.evaluate(() => location.hash)
      if (hash === '#' + key) break
    }
    if (hash !== '#' + key) throw new Error(`点不到页签 ${label}（当前 hash=${hash}，点了 4 次）`)
    await win.waitForTimeout(waitMs)
  }

  await settled()

  // ── 哨兵①：产品自带的强制骨架态必须看得见骨架节点 ──────────────────────────
  await win.evaluate(() => { location.search = '?skeleton=1' })
  await settled()
  const forced = await skelDom()
  check(forced > 0, `骨架信号是真的（?skeleton=1 强制态下 DOM 里有 ${forced} 个骨架节点）`,
    '看不见 ⇒ 选择器或钩子坏了，后面"没闪骨架"的结论一律不作数')

  // ── 真路径：总览画得出资金数字；离开之后必须没有（哨兵②）────────────────────
  await win.evaluate(() => { location.search = '' })
  await settled()
  await installProbe()
  await gotoTab('overview', '数据总览', 3000)
  check(await money(), '总览画出资金快照（夹具里有 100 笔资金行）', '')
  await gotoTab('chats', '聊天会话', 1500)
  check(!(await money()), '离开总览后屏上没有那一格 ⇒ 上面那条不是恒真（页签是保活的，所以要问可见性）', await win.evaluate(() => location.hash))

  // ── ② 二次进入：只等一帧就查（缓存生效时"立刻"就在）─────────────────────────
  const skelBefore = await skel()
  await gotoTab('overview', '数据总览', 0)
  await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
  const reentryPaint = await money()
  const reentrySkel = (await skel()) - skelBefore
  check(reentryPaint, '二次进入总览**只等一帧**就有资金数字（没有"等回源"的空窗）',
    '这条量的就是 P2-4 ① 那半句：`apiGetLedger` 原先没有任何缓存')
  check(reentrySkel === 0, `二次进入没有挂骨架（新增 ${reentrySkel} 个）`, '')

  // ── ③ 一次账本重算到底多贵（直调两次：第二次会踩到后端的读缓存）─────────────
  const timed = await win.evaluate(async () => {
    const one = async () => {
      const t0 = performance.now()
      await window.electronAPI.wechat.call('getLedger', [{ month: '2026-09' }])
      return Math.round(performance.now() - t0)
    }
    const first = await one()
    const second = await one()
    return { first, second }
  })
  check(timed.first > 0, `一次账本重算实测 ${String(timed.first)}ms（夹具 ${SHARDS}×${PER_SHARD} 条消息 + ${TRANSFERS + REDPACKETS} 笔资金行）`,
    `第二次=${String(timed.second)}ms（后端读缓存命中）`)

  // ── ④ 事件风暴：数字不许闪回空、骨架不许冒出来、主线程不许被堵 ──────────────
  const burstSkelBefore = await skel()
  const flicker = await win.evaluate(async (n) => {
    let gone = 0
    let samples = 0
    for (let i = 0; i < n; i += 1) {
      window.dispatchEvent(new CustomEvent('dsh-wechat-data-updated'))
      for (let k = 0; k < 12; k += 1) {
        await new Promise((r) => { setTimeout(r, 30) })
        samples += 1
        if (!window.__money || !window.__money()) gone += 1
      }
    }
    return { gone, samples }
  }, BURST)
  await win.waitForTimeout(2500)
  const burstSkel = (await skel()) - burstSkelBefore
  const gaps = await win.evaluate(() => new Promise((resolve) => {
    const out = []
    let last = performance.now()
    let n = 0
    const tick = () => {
      const now = performance.now()
      out.push(now - last)
      last = now
      n += 1
      if (n < 24) requestAnimationFrame(tick)
      else resolve(out)
    }
    requestAnimationFrame(tick)
  }))
  const maxGap = Math.round(Math.max(...gaps))
  check(flicker.gone === 0, `风暴 ${BURST} 个事件、采样 ${flicker.samples} 次：资金数字一次都没从屏上消失`,
    flicker.gone > 0 ? `消失 ${flicker.gone} 次` : '')
  check(burstSkel === 0, `风暴期间也没有挂骨架（新增 ${burstSkel} 个）`, '')
  check(maxGap < 500, `风暴之后主线程最大帧间隔 ${maxGap}ms（重算在后台与另一个进程里）`, `frames=${gaps.length}`)
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))

  await win.screenshot({ path: join(ROOT, '.tmp-e2e', 'p24-ledger-reload.png') }).catch(() => {})
  console.log(`[算料] 强制骨架态节点数=${forced} / 二次进入：首帧有数字=${reentryPaint} 骨架新增=${reentrySkel} / `
    + `一次账本重算=${timed.first}ms（第二次 ${timed.second}ms）/ 风暴 ${BURST} 事件：数字消失=${flicker.gone}/${flicker.samples} `
    + `骨架新增=${burstSkel} / 最大帧间隔=${maxGap}ms`)
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
  ? `\n✅ P2-4 打点通过（${results.length} 项）`
  : `\n❌ P2-4 打点：${failed.length} 条不成立 / 共 ${results.length} 条`)
process.exitCode = failed.length === 0 ? 0 : 1
