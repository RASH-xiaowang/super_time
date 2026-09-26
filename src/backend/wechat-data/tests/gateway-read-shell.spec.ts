/**
 * `gateway-read.ts` 的**壳层**契约（P1-7 点名的「28KB 读接口无独立 spec」）。
 *
 * 这一层按设计只有一行转发，所以它**不该**被用来测查询本身（`query/*.ts` 各自有 spec）。
 * 它真正没人管的是三类只有壳才有的东西：
 *   ① 方法面 —— `@Remote('…')` 那个字符串与装饰器一起构成了协议层的枚举口径。
 *      名字打错一个字母、或装饰器被误删，界面得到的是「这个方法不存在」，而**编译期一声不响**
 *      （`gateway-remote-surface.spec.ts` 只管整类逐名相同，看不见「本层声明了什么」）；
 *   ② 参数搬运 —— 转发是位置参数的搬运（`queryMoments(decrypted, offset, limit, …)` 里
 *      offset 在 limit **之前**；`queryRecords` 的 direction 藏在第 6 个参数**同一个对象**里）。
 *      这种换位编译器查不出来，只有对着「两页不相交」「asc/desc 互为逆序」这类判据才露馅；
 *   ③ 失败形状 —— 渲染层拿到 `undefined` 会直接崩在 `res.sessions.map(...)`，
 *      而「没有快照」这件事在壳层只有两种正确表达：给出口径内的空快照，或抛一句人话。
 *
 * 判据口径：每条都成对（不给 options vs 给 options、limit=0 vs limit=1），
 * 并且**能对着一个返回 `{}` 的桩失败** —— 所以每条都带了具体数字/具体文案，而不是 `toBeDefined()`。
 *
 * 夹具全部落在 `mkdtempSync(tmpdir())` 之下（`resolveDecryptedDir` 由 env 钉住，
 * `bootstrapWechatData` 在 env 已设时整段跳过 ⇒ 不往仓库里写任何东西；
 * 有一条用例专门回头检查这件事）。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WechatDataGateway } from '../src/gateway.ts'
import { GatewayRead } from '../src/gateway-read.ts'
import { getConfig } from '../src/query/config.ts'
import { listOperations } from '../src/query/operation-log.ts'
import { recordAsk } from '../src/query/ask-history.ts'
import { defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import { loadAdaptedWeights, saveAdaptedWeights } from '../src/query/retrieval/feedback.ts'
import type { RerankWeights } from '../src/query/retrieval/types.ts'
import type { WordCloudOptions, WordCloudResult } from '../src/query/wordcloud.ts'

/** 被测源文件：期望名单**从它自己身上解析**，不手抄（手抄的名单会跟着重构一起烂掉）。 */
const GATEWAY_READ_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gateway-read.ts')

const scratch: string[] = []
/** 每个网关实例注册的 effect 回收器（构造器起了实时同步轮询 + 30s 调度器，必须关掉）。 */
let disposers: Array<() => void> = []

afterEach(() => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  scratch.length = 0
})

/** 网关构造期只用到 reflect/effect/emit 三件（同 `gateway-operation-log.spec.ts` 的口径）。 */
function fakeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

interface Tree {
  /** 数据根（decrypted 的上一级）：操作日志/问答历史落在这里。 */
  root: string
  decrypted: string
  decoded: string
}

/**
 * 造一棵最小的解密树：通讯录 / 会话 / 消息分片 / 撤回缓存 / 支付 / 朋友圈 / 收藏。
 * 数字都是**算出来的**（每类目几条、偏移量第几个是谁），这样壳层漏传一个参数就会数字不符。
 * @param tag - 目录标签（也让 `cachedBySig` 的键不相交，用例之间不互相喂缓存）。
 * @returns 三个目录。
 */
function makeTree(tag: string): Tree {
  const root = mkdtempSync(join(tmpdir(), `wx-rshell-${tag}-`))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  const decoded = join(root, 'decoded')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  return { root, decrypted, decoded }
}

/** 只放两个目录、什么库都不建 —— 「这台机器根本没有快照」那一侧。 */
function makeEmptyTree(tag: string): Tree {
  return makeTree(tag)
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    create(db)
  } finally {
    db.close()
  }
}

/** 本地正午的秒级时间戳（`getDailyCounts` 用 localtime 分桶，两侧同口径才不会因时区翻车）。 */
function localNoon(y: number, m: number, d: number): number {
  return Math.floor(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000)
}

const msgTable = (username: string): string => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

/** 建库（只在 `fullTree()` 里用一次，形状全部由用例反查）。 */
function fullTree(): Tree {
  const t = makeTree('full')
  // 通讯录：3 好友（Alice/Bob/Carol）+ 1 群成员（Mark）+ 1 群 + 1 公众号 ⇒ 全量 6、friend 3。
  makeDb(join(t.decrypted, 'contact', 'contact.db'), (db) => {
    db.exec(`CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, delete_flag INTEGER,
      alias TEXT, nick_name TEXT, remark TEXT, pin_yin_initial TEXT, quan_pin TEXT,
      remark_pin_yin_initial TEXT, remark_quan_pin TEXT, big_head_url TEXT, small_head_url TEXT,
      description TEXT, is_in_chat_room INTEGER, chat_room_notify INTEGER, flag INTEGER)`)
    const ins = db.prepare('INSERT INTO contact (id, username, local_type, delete_flag, nick_name, is_in_chat_room) VALUES (?,?,?,?,?,?)')
    // remark / 拼音列一律留空：走 `initialOf` 的第 ③ 步（显示名首字母），排序结果才是 A/B/C/M/O/R。
    ins.run(1, 'wxid_a', 1, 0, 'Alice', 0)
    ins.run(2, 'wxid_b', 1, 0, 'Bob', 0)
    ins.run(3, 'wxid_c', 1, 0, 'Carol', 0)
    ins.run(4, 'wxid_m', 3, 0, 'Mark', 1)
    ins.run(5, 'room1@chatroom', 0, 0, 'RoomOne', 0)
    ins.run(6, 'gh_official', 1, 0, 'OfficialX', 0)
    db.exec('CREATE TABLE chat_room (id INTEGER, username TEXT, owner TEXT, ext_buffer BLOB)')
    db.prepare('INSERT INTO chat_room VALUES (5, ?, ?, NULL)').run('room1@chatroom', 'wxid_a')
    db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
    db.prepare('INSERT INTO chatroom_member VALUES (5, 4)').run()
    // 疑点（不改产品码）：`query/group-info.ts:180` 直接 prepare 了 `chat_room_info_detail`
    // 而外层只有 `finally` 没有 `catch` —— 这张公告表不在时整条 `getGroupInfo` 抛
    // `no such table`（本文件第一次跑就是这么红的），而它的 JSDoc 承诺「未知的群给 null」，
    // 同一个函数里成员表的读取反倒是包了 try/catch。真实微信库里这张表在，所以夹具带上它；
    // 「缺这张表的快照」那一侧的形状留给修好之后的用例，这里不把抛错写成正确。
    db.exec('CREATE TABLE chat_room_info_detail (username_ TEXT, announcement_ TEXT, announcement_editor_ TEXT, announcement_publish_time_ INTEGER)')
    db.prepare('INSERT INTO chat_room_info_detail VALUES (?,?,?,?)').run('room1@chatroom', '本周六聚会', 'wxid_a', 1700000000)
  })
  // 会话：4 条，sort_timestamp 40/30/20/10 ⇒ 顺序 wxid_a, wxid_b, wxid_c, room1@chatroom。
  makeDb(join(t.decrypted, 'session', 'session.db'), (db) => {
    db.exec(`CREATE TABLE SessionTable (username TEXT, unread_count INTEGER, summary TEXT, draft TEXT,
      is_hidden INTEGER, last_timestamp INTEGER, sort_timestamp INTEGER, last_msg_type INTEGER,
      last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT,
      unread_first_msg_srv_id INTEGER)`)
    const ins = db.prepare(`INSERT INTO SessionTable (username, unread_count, summary, draft, is_hidden,
      last_timestamp, sort_timestamp) VALUES (?,?,?, ?,0,?,?)`)
    ins.run('wxid_a', 0, 'summary-a', '一条草稿', 40, 40)
    ins.run('wxid_b', 0, 'summary-b', '', 30, 30)
    ins.run('wxid_c', 0, 'summary-c', '', 20, 20)
    ins.run('room1@chatroom', 0, 'room summary', '', 10, 10)
  })
  // 消息分片：wxid_a 的 5 条（sort_seq 1..5 ⇒ 取两页看游标是否真的往前挪）；
  // 其中 3 条落在 2 月 10 日、2 条落在 2 月 11 日（日历统计用）。
  makeDb(join(t.decrypted, 'message', 'message_0.db'), (db) => {
    db.exec('CREATE TABLE Name2Id (user_name TEXT)')
    db.prepare('INSERT INTO Name2Id VALUES (?)').run('wxid_a')
    db.exec(`CREATE TABLE "${msgTable('wxid_a')}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER,
      local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER,
      message_content TEXT, server_id TEXT)`)
    const ins = db.prepare(`INSERT INTO "${msgTable('wxid_a')}" VALUES (?,?,?,?,?,?,?,?)`)
    const times = [localNoon(2023, 2, 10), localNoon(2023, 2, 10), localNoon(2023, 2, 10), localNoon(2023, 2, 11), localNoon(2023, 2, 11)]
    for (let i = 1; i <= 5; i += 1) {
      ins.run(i, i, 1, i % 2, times[i - 1] ?? 0, 1, `第${String(i)}条消息`, String(1000 + i))
    }
    // 合并转发记录（local_type 49）：`resolveChatHistory` 按 server_id 只认这一类。
    db.exec(`CREATE TABLE "${msgTable('wxid_b')}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER,
      local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
    db.prepare(`INSERT INTO "${msgTable('wxid_b')}" VALUES (?,?,?,?,?,?,?)`)
      .run(1, 1, 49, localNoon(2023, 2, 10), 1, '<msg><title>群聊记录</title></msg>', '2001')
    // 撤回缓存（`queryRevoked` 按表名后缀在分片里找它）：3 条，create_time 递增。
    db.exec(`CREATE TABLE wxid_a_weflow_anti_revoke_deleted_cache (local_id INTEGER, local_type INTEGER,
      real_sender_id INTEGER, create_time INTEGER, message_content TEXT)`)
    const rvi = db.prepare('INSERT INTO wxid_a_weflow_anti_revoke_deleted_cache VALUES (?,?,?,?,?)')
    for (let i = 1; i <= 3; i += 1) rvi.run(i, 1, 1, 1700000000 + i, `<msg><sysmsg type="sysmsgtemplate">${String(i)}</sysmsg></msg>`)
  })
  // 支付：3 笔转账（begin_transfer_time 100/200/300 ⇒ asc/desc 必须是逆序）。
  makeDb(join(t.decrypted, 'general', 'general.db'), (db) => {
    db.exec(`CREATE TABLE transferTable (transfer_id TEXT, transcation_id TEXT, message_server_id INTEGER,
      second_message_server_id INTEGER, session_name TEXT, pay_sub_type INTEGER, pay_receiver TEXT,
      pay_payer TEXT, begin_transfer_time INTEGER, last_modified_time INTEGER, invalid_time INTEGER,
      last_update_time INTEGER, delay_confirm_flag INTEGER)`)
    const ins = db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?, 0, 0, 0, 0)')
    ins.run('T1', 'X1', 9001, 'wxid_a', 'wxid_b', 'wxid_a', 100)
    ins.run('T2', 'X2', 9002, 'wxid_a', 'wxid_b', 'wxid_a', 200)
    ins.run('T3', 'X3', 9003, 'wxid_b', 'wxid_a', 'wxid_b', 300)
  })
  // 朋友圈：tid 1..5 按 DESC 出 ⇒ 4 别人发的 + tid 5 是**我自己**发的（is_self 由壳把 selfUsername 传下去）。
  makeDb(join(t.decrypted, 'sns', 'db_sns', 'sns.db'), (db) => {
    db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
    const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
    const authors = ['wxid_a', 'wxid_b', 'wxid_a', 'wxid_b', 'wxid_self']
    for (let i = 1; i <= 5; i += 1) ins.run(i, authors[i - 1] ?? '', `<desc>动态${String(i)}</desc>`)
  })
  // 收藏：update_time 100/200/300 ⇒ DESC 出 3,2,1。
  makeDb(join(t.decrypted, 'favorite', 'favorite.db'), (db) => {
    db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT, fromusr TEXT, realchatname TEXT)')
    const ins = db.prepare('INSERT INTO fav_db_item VALUES (?,?,?,?,?,?)')
    ins.run(1, 1, 100, '<desc>收藏一</desc>', 'wxid_a', '')
    ins.run(2, 1, 200, '<desc>收藏二</desc>', 'wxid_b', '')
    ins.run(3, 1, 300, '<desc>收藏三</desc>', 'wxid_a', '')
  })
  return t
}

/** 起一个真网关，把 wxid 钉死（不钉住会去扫注册表/默认目录，结果随机器变）。 */
function gateway(t: Tree): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', t.decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', t.decoded)
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  delete process.env['DSH_WECHAT_BASE_DIR']
  return new WechatDataGateway(fakeCtx())
}

/** 只读探针：名字 → 调用。**只有这些**方法被断言「不许写盘」（写类壳另有分组）。 */
function readProbes(gw: WechatDataGateway): Array<{ name: string; call: () => unknown }> {
  return [
    { name: 'getSessions', call: () => gw.getSessions() },
    { name: 'getContacts', call: () => gw.getContacts() },
    { name: 'getOverview', call: () => gw.getOverview() },
    { name: 'getOverviewInsights', call: () => gw.getOverviewInsights() },
    { name: 'getRegionMap', call: () => gw.getRegionMap() },
    { name: 'getRecords', call: () => gw.getRecords({ kind: 'transfers' }) },
    { name: 'getRevoked', call: () => gw.getRevoked() },
    { name: 'getStorageStats', call: () => gw.getStorageStats() },
    { name: 'getAnnual', call: () => gw.getAnnual() },
    { name: 'getGraph', call: () => gw.getGraph() },
    { name: 'getMoments', call: () => gw.getMoments() },
    { name: 'getMomentsAuthors', call: () => gw.getMomentsAuthors() },
    { name: 'getFavorites', call: () => gw.getFavorites() },
    { name: 'getMessages', call: () => gw.getMessages({ talker: 'wxid_a' }) },
    { name: 'getNewMessages', call: () => gw.getNewMessages({ talker: 'wxid_a', after: 0 }) },
    { name: 'getSearchIndexStatus', call: () => gw.getSearchIndexStatus() },
    { name: 'cancelSearch', call: () => gw.cancelSearch({ jobId: '从未注册' }) },
    { name: 'getGroupInfo', call: () => gw.getGroupInfo({ username: 'room1@chatroom' }) },
    { name: 'getPaymentStatus', call: () => gw.getPaymentStatus({ serverId: '9001' }) },
    { name: 'resolveChatHistory', call: () => gw.resolveChatHistory({ serverId: '1001' }) },
    { name: 'getDailyCounts', call: () => gw.getDailyCounts({ username: 'wxid_a', year: 2023, month: 2 }) },
    { name: 'listEditedMessages', call: () => gw.listEditedMessages() },
    { name: 'listSummaryRecords', call: () => gw.listSummaryRecords() },
    { name: 'getSelfUsername', call: () => gw.getSelfUsername() },
    { name: 'searchMembers', call: () => gw.searchMembers({ q: 'Alice' }) },
    { name: 'getVoiceTranscript', call: () => gw.getVoiceTranscript({ username: 'wxid_a', localId: 1 }) },
    { name: 'getContact360', call: () => gw.getContact360({ username: 'wxid_a' }) },
    { name: 'getGroupInsights', call: () => gw.getGroupInsights({ username: 'room1@chatroom' }) },
    { name: 'getCalls', call: () => gw.getCalls() },
    { name: 'getLedger', call: () => gw.getLedger() },
    { name: 'getMediaAssets', call: () => gw.getMediaAssets() },
    { name: 'getAssetInsights', call: () => gw.getAssetInsights() },
    { name: 'getOfficialAssets', call: () => gw.getOfficialAssets() },
    { name: 'getMomentsInsights', call: () => gw.getMomentsInsights() },
    { name: 'getMomentsMonthly', call: () => gw.getMomentsMonthly() },
    { name: 'getWordCloud', call: () => gw.getWordCloud() },
    { name: 'searchUnified', call: () => gw.searchUnified({ query: 'Alice' }) },
    { name: 'getAnnualReview', call: () => gw.getAnnualReview({ year: 2023 }) },
    { name: 'getAnnualReport', call: () => gw.getAnnualReport({ year: 2023 }) },
  ]
}

/** 目录树的稳定指纹：相对路径 + 大小 + mtime（读操作一旦落盘就必然动其中某项）。 */
function fingerprint(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(d, e.name)
      if (e.isDirectory()) {
        out.push(`${abs}|dir`)
        walk(abs)
        continue
      }
      const st = statSync(abs)
      out.push(`${abs}|${String(st.size)}|${String(st.mtimeMs)}`)
    }
  }
  out.push(`${dir}|root`)
  walk(dir)
  return out
}

/** 从源码里解析「本层声明的 @Remote 名 + 被装饰的方法名」成对表。 */
function declaredRemotes(src: string): Array<{ remote: string; key: string }> {
  const re = /@Remote\('([A-Za-z0-9_]+)'\)\s*\n\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\(/g
  return [...src.matchAll(re)].map((m) => ({ remote: m[1] ?? '', key: m[2] ?? '' }))
}

describe('方法面：gateway-read.ts 声明的每个 @Remote 都在实例上', () => {
  it('源码解析出的名单非空，且 @Remote 字符串与被装饰方法名一字不差', () => {
    const pairs = declaredRemotes(readFileSync(GATEWAY_READ_SRC, 'utf8'))
    // 防空转：口径失效时（改了装饰器写法）这条必须先红，否则后面的断言全是假的。
    expect(pairs.length, '从 gateway-read.ts 里一个 @Remote 都没解析出来 —— 抓取口径失效').toBeGreaterThan(40)
    const names = pairs.map((p) => p.remote)
    expect(new Set(names).size, '同一层里声明了两次同名端点').toBe(names.length)
    const mismatched = pairs.filter((p) => p.remote !== p.key).map((p) => `@Remote('${p.remote}') 装饰的是 ${p.key}()`)
    expect(mismatched, '端点名与方法名不一致 ⇒ 渲染层按其中一个名字调用必然 not found：\n  ' + mismatched.join('\n  ')).toEqual([])
  })

  it('每个声明名都出现在协议层枚举里、且真的挂在实例上（删装饰器=静默少接口）', () => {
    const gw = gateway(makeTree('surface'))
    const names = declaredRemotes(readFileSync(GATEWAY_READ_SRC, 'utf8')).map((p) => p.remote)
    const markers = new Set(remoteMethods(gw).map((m) => m.method))
    expect(markers.size, '协议层一个端点都没枚举到 —— 桩/夹具坏了').toBeGreaterThan(0)
    const unmarked = names.filter((n) => !markers.has(n))
    expect(unmarked, '这些 @Remote 声明没进方法面（装饰器被删/被挪走）：\n  ' + unmarked.join('\n  ')).toEqual([])
    const bag = gw as unknown as Record<string, unknown>
    const missing = names.filter((n) => typeof bag[n] !== 'function')
    expect(missing, '这些端点在实例上取不到：\n  ' + missing.join('\n  ')).toEqual([])
  })

  it('本层原型上的方法都带 @Remote（新加壳不许漏装饰器，也不许只留个名）', () => {
    const names = new Set(declaredRemotes(readFileSync(GATEWAY_READ_SRC, 'utf8')).map((p) => p.key))
    const own = Object.getOwnPropertyNames(GatewayRead.prototype)
      .filter((k) => k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(GatewayRead.prototype, k)?.value === 'function')
    expect(own.length, 'GatewayRead.prototype 上一个方法都没有 ⇒ 判据空转').toBeGreaterThan(40)
    const unmarked = own.filter((k) => !names.has(k))
    expect(unmarked, '这些壳方法没有 @Remote，渲染层看不见它：\n  ' + unmarked.join('\n  ')).toEqual([])
  })
})

describe('参数搬运：分页与归一化（不给 options vs 给 options 成对钉）', () => {
  it('getSessions：limit/offset/keyword 缺省与边界', () => {
    const gw = gateway(fullTree())
    const all = gw.getSessions()
    expect(all.sessions.map((s) => s.username), '不给 options 应当按 sort_timestamp DESC 全量出')
      .toEqual(['wxid_a', 'wxid_b', 'wxid_c', 'room1@chatroom'])
    expect(all.total).toBe(4)

    expect(gw.getSessions({ limit: 1 }).sessions.map((s) => s.username)).toEqual(['wxid_a'])
    expect(gw.getSessions({ limit: 1, offset: 1 }).sessions.map((s) => s.username)).toEqual(['wxid_b'])
    // limit=0 是「显式空页」而不是「回到全量」：`limit === undefined` 与 `limit === 0` 必须不同。
    const zero = gw.getSessions({ limit: 0 })
    expect(zero.sessions).toEqual([])
    expect(zero.total, 'total 是全量口径，分页不许把它一起清零').toBe(4)

    // 关键词：空串与全空格都等于「不过滤」（`q.trim()` 之后为假值）。
    expect(gw.getSessions({ keyword: '  ' }).total).toBe(4)
    expect(gw.getSessions({ keyword: 'undefined' }).total).toBe(0)
    expect(gw.getSessions({ keyword: 'room' }).sessions.map((s) => s.username)).toEqual(['room1@chatroom'])
    // 命中显示名（Alice 来自 contact.db）而不是 summary —— 关键字是在名字解析之后才比的。
    expect(gw.getSessions({ keyword: 'ali' }).sessions.map((s) => s.username)).toEqual(['wxid_a'])

    // 疑点（只记录不改产品码）：`offset` 在没给 `limit` 时被**整个忽略**
    // （querySessions 里 `limit === undefined ? sessions : slice(offset, offset + limit)`），
    // 而壳的签名把 offset 与 limit 并列声明成两个独立可选项。渲染层若只做「翻页时先给 offset」
    // 就会每页拿到同一份全量。此处钉的是**当前行为**，不是它合理。
    expect(gw.getSessions({ offset: 2 }).total, '当前实现：无 limit ⇒ offset 不生效').toBe(4)
  })

  it('getContacts：category 在分页之前生效，all/空串/缺省三者同义', () => {
    const gw = gateway(fullTree())
    const all = gw.getContacts()
    expect(all.total).toBe(6)
    expect(all.contacts.map((c) => c.displayName)).toEqual(['Alice', 'Bob', 'Carol', 'Mark', 'OfficialX', 'RoomOne'])
    expect(gw.getContacts({ limit: 2 }).contacts.map((c) => c.username)).toEqual(['wxid_a', 'wxid_b'])
    expect(gw.getContacts({ limit: 2, offset: 2 }).contacts.map((c) => c.username)).toEqual(['wxid_c', 'wxid_m'])

    const friend = gw.getContacts({ category: 'friend', limit: 1 })
    expect(friend.total, 'total 必须是**当前类目**的口径，否则页签数字随分页漂').toBe(3)
    expect(friend.contacts.map((c) => c.username)).toEqual(['wxid_a'])
    expect(friend.stats?.['friend']).toBe(3)
    expect(friend.stats?.['all'], 'stats.all 是全量口径（页签上的「全部」）').toBe(6)
    expect(gw.getContacts({ category: 'group' }).contacts.map((c) => c.username)).toEqual(['room1@chatroom'])
    expect(gw.getContacts({ category: 'nope' }).total).toBe(0)
    for (const c of ['all', '', '   '] as const) {
      const snap = gw.getContacts({ category: c })
      expect(snap.total, `category=${JSON.stringify(c)} 应当等于不过滤`).toBe(6)
      expect(snap.contacts.map((x) => x.username)).toEqual(all.contacts.map((x) => x.username))
    }
  })

  it('getMoments：offset 在 limit 之前转发，且 selfUsername 落到 is_self', () => {
    const gw = gateway(fullTree())
    const all = gw.getMoments()
    expect(all.total).toBe(5)
    expect(all.moments.map((m) => m.tid)).toEqual(['5', '4', '3', '2', '1'])
    expect(all.moments[0]?.is_self, '壳把 selfUsername 作为第 5 个参数传下去，否则「我」标签永远不亮').toBe(true)

    // 位置换位判据：queryMoments(decrypted, **offset, limit**, …)。
    // 若两个参数互换，这一页会变成 1 条（cap=1）而不是 2 条。
    const page = gw.getMoments({ offset: 1, limit: 2 })
    expect(page.moments.map((m) => m.tid)).toEqual(['4', '3'])
    expect(page.total, 'author 未过滤时 total 仍是全量').toBe(5)
    expect(gw.getMoments({ offset: 4, limit: 2 }).moments.map((m) => m.tid)).toEqual(['1'])
    // author 过滤在分页之前。
    const mine = gw.getMoments({ author: 'wxid_a' })
    expect(mine.moments.map((m) => m.tid)).toEqual(['3', '1'])
    expect(mine.total).toBe(2)
    expect(gw.getMoments({ author: 'wxid_a', limit: 1 }).moments.map((m) => m.tid)).toEqual(['3'])
  })

  it('getFavorites / getRevoked：limit 在前 offset 在后，边界值不退化成全量', () => {
    const gw = gateway(fullTree())
    expect(gw.getFavorites().favorites.map((f) => f.localId)).toEqual([3, 2, 1])
    expect(gw.getFavorites({ limit: 1, offset: 1 }).favorites.map((f) => f.localId)).toEqual([2])
    expect(gw.getFavorites({ limit: 1 }).total).toBe(3)
    expect(gw.getFavorites({ limit: 0 }).favorites).toEqual([])
    expect(gw.getFavorites({ q: ' wxid_b ' }).favorites.map((f) => f.localId), 'q 两侧空格该被 trim 掉后仍命中')
      .toEqual([2])

    const revoked = gw.getRevoked()
    expect(revoked.total).toBe(3)
    expect(revoked.items.length).toBe(3)
    const one = gw.getRevoked({ limit: 1, offset: 1 })
    expect(one.items.length).toBe(1)
    expect(one.items[0]?.create_time, 'ORDER BY create_time DESC ⇒ offset=1 是第二大').toBe(1700000002)
    expect(one.total, 'total 不受分页影响').toBe(3)
  })

  it('getRecords：kind 选表、direction 藏在「同一个 options 对象」里转发、未知 kind 给空快照', () => {
    const gw = gateway(fullTree())
    const desc = gw.getRecords({ kind: 'transfers' })
    expect(desc.total).toBe(3)
    const ids = (items: Array<Record<string, string | number | boolean | null>>): string[] =>
      items.map((i) => String(i['transfer_id'] ?? ''))
    expect(ids(desc.items)).toEqual(['T3', 'T2', 'T1'])
    // 壳的第 6 个实参就是 options 本身（from/to/direction 从那儿读）——漏传一个字符这条就红。
    const asc = gw.getRecords({ kind: 'transfers', direction: 'asc' })
    expect(ids(asc.items)).toEqual(['T1', 'T2', 'T3'])
    // from/to 也从同一个对象里读：begin_transfer_time 是 100/200/300，所以 from=200 该砍掉 T1。
    expect(ids(gw.getRecords({ kind: 'transfers', direction: 'asc', from: 200 }).items)).toEqual(['T2', 'T3'])
    expect(ids(gw.getRecords({ kind: 'transfers', direction: 'asc', to: 200 }).items)).toEqual(['T1', 'T2'])
    // limit 缺省 50 / 上限 500 都在 query 侧，但**只有壳**决定它们收到的是 undefined 还是 0。
    expect(ids(gw.getRecords({ kind: 'transfers', limit: 0 }).items)).toEqual([])
    expect(gw.getRecords({ kind: 'transfers', limit: 0 }).total, 'limit=0 ⇒ 空页，total 仍 3').toBe(3)
    const unknown = gw.getRecords({ kind: '没有这个类目' })
    expect(unknown.items).toEqual([])
    expect(unknown.total).toBe(0)
    // 关键词 + 时间范围：证明 `q` 确实从壳转到了 query 的第 5 个实参。
    expect(gw.getRecords({ kind: 'transfers', q: 'T2', from: 1 }).total).toBe(1)
    // 同一句去掉 `from`：这里以前是 **0**。`query/records.ts` 的 `combineWhere` 在
    // 「只有关键词、没有时间范围」那条分支上 `return base.trim()`，把拼接依赖的那个前导空格
    // 一起 trim 掉了 ⇒ SQL 变成 `FROM transferTableWHERE ...`，语法错误被 query 侧的
    // catch 压成「零条记录」。用户侧表现就是「记录页签一搜就空」。
    expect(gw.getRecords({ kind: 'transfers', q: 'T2' }).total, '只给关键词就搜不到 ⇒ 记录页一搜即空').toBe(1)
    expect(gw.getRecords({ kind: 'transfers', q: '不存在的关键字' }).total, '关键词该继续参与过滤，不许变成「全给」').toBe(0)
  })

  it('群公告表缺失只丢公告，不许把整条群资料变成异常', () => {
    const t = fullTree()
    // 老快照里没有 `chat_room_info_detail`（这张表是后来才加的）。`query/group-info.ts`
    // 以前直接 prepare 它、外层只有 finally 没有 catch ⇒ 整条 getGroupInfo 抛
    // `no such table`，群名/成员这些本来拿得到的东西也一起看不到了。
    makeDb(join(t.decrypted, 'contact', 'contact.db'), (db) => {
      db.exec('DROP TABLE chat_room_info_detail')
    })
    const gw = gateway(t)
    const missing = gw.getGroupInfo({ username: 'room1@chatroom' }).group
    expect(missing, '缺一张可选的表就把群资料整条判死').toBeTruthy()
    expect(missing?.announcement, '公告缺失就当没有，不是报错').toBe('')
    // 其余字段必须与「公告表在」的那份**逐项相同** —— 只该少掉公告，不该连群名/成员/设置一起丢。
    const present = gateway(fullTree()).getGroupInfo({ username: 'room1@chatroom' }).group
    expect(present?.name, '基线本身要拿得到群名，否则下面的比对是空转').toBe('RoomOne')
    // 只比「不该受影响」的那几项：公告相关的三个字段本来就是这张表提供的，缺表时它们是空/缺省。
    for (const key of ['username', 'name', 'owner', 'remark', 'totalMembers', 'myAlias', 'settings'] as const) {
      expect(missing?.[key], `公告表缺失波及了 ${key}`).toEqual(present?.[key])
    }
    expect(missing?.members.length, '成员来自另一条路径 ⇒ 不许因为公告表缺失被一起丢掉')
      .toBe(present?.members.length ?? 0)
  })

  it('getMessages / getNewMessages：游标让两页真正不相交，limit 与 after 各就各位', () => {
    const gw = gateway(fullTree())
    const first = gw.getMessages({ talker: 'wxid_a', limit: 2 })
    // 取的是「最新 2 条」，页内按 localId 升序回（与 messages.spec 同一口径）。
    expect(first.messages.map((m) => m.localId)).toEqual([4, 5])
    expect(first.total).toBe(5)
    const second = gw.getMessages({ talker: 'wxid_a', limit: 2, cursor: first.cursor })
    expect(second.messages.map((m) => m.localId), 'cursor 没被转发的话这一页会重复第一页').toEqual([2, 3])
    const overlap = second.messages.map((m) => m.localId).filter((id) => first.messages.some((m) => m.localId === id))
    expect(overlap, '翻页出现重复消息 ⇒ 游标形同虚设').toEqual([])
    expect(gw.getMessages({ talker: '不存在的人' })).toMatchObject({ messages: [], total: 0 })

    expect(gw.getNewMessages({ talker: 'wxid_a', after: 3 }).messages.map((m) => m.localId)).toEqual([4, 5])
    const one = gw.getNewMessages({ talker: 'wxid_a', after: 3, limit: 1 })
    expect(one.messages.length, 'limit 没转下去就会把 4、5 两条都给回来').toBe(1)
    expect([4, 5]).toContain(one.messages[0]?.localId)
    expect(gw.getNewMessages({ talker: 'wxid_a', after: 999 }).messages).toEqual([])
  })

  it('searchMembers：空查询给 like 口径的空快照，limit/roomUsername 转得下去', () => {
    const gw = gateway(fullTree())
    expect(gw.searchMembers({ q: '   ' })).toEqual({ items: [], total: 0, source: 'like' })
    const hit = gw.searchMembers({ q: ' Alice ' })
    expect(hit.items.map((i) => i.username)).toEqual(['wxid_a'])
    expect(hit.total).toBe(1)
    expect(gw.searchMembers({ q: 'Alice', limit: 0 }).items).toEqual([])
    const room = gw.searchMembers({ q: 'Mark', roomUsername: 'room1@chatroom' })
    expect(room.items.map((i) => i.username), 'roomUsername 没转下去就会走全局路径（返回的 source 也不同）')
      .toEqual(['wxid_m'])
  })

  it('getDailyCounts：year 在 month 之前转发，非法月份抛人话', () => {
    const gw = gateway(fullTree())
    const r = gw.getDailyCounts({ username: 'wxid_a', year: 2023, month: 2 })
    expect({ year: r.year, month: r.month }).toEqual({ year: 2023, month: 2 })
    expect(r.counts).toEqual({ '10': 3, '11': 2 })
    // 两个数字换位时 month=2023 会先撞上「无效月份」⇒ 上面那条通过就说明没换位。
    expect(() => gw.getDailyCounts({ username: 'wxid_a', year: 2023, month: 13 })).toThrow(/无效月份/)
    expect(() => gw.getDailyCounts({ username: 'wxid_a', year: 2023, month: 0 })).toThrow(/无效月份/)
  })

  it('getSelfUsername / getCalls / getLedger：无 options 也给出声明的形状', () => {
    const gw = gateway(fullTree())
    expect(gw.getSelfUsername()).toEqual({ username: 'wxid_self' })
    const calls = gw.getCalls()
    expect(Array.isArray(calls.peers), JSON.stringify(Object.keys(calls))).toBe(true)
    expect(Array.isArray(calls.recent)).toBe(true)
    expect(calls.total).toBe(0)
    expect(gw.getCalls({ topPeers: 1, recentLimit: 1 }).peers.length).toBeLessThanOrEqual(1)
    const ledger = gw.getLedger()
    expect(ledger.month, '不给 month 时快照要如实说「全量」').toBeNull()
    expect(ledger.summary.transfers).toBe(3)
    const feb = gw.getLedger({ month: '2023-02' })
    expect(feb.month).toBe('2023-02')
    expect(feb.summary.transfers, '转账的 begin_transfer_time 都在 1970 年，2023-02 该一条不剩')
      .toBe(0)
    expect(gw.getLedger({ month: '不像月份' }).summary.transfers).toBe(3)
  })

  it('cancelSearch：jobId 归一化与在飞槽位对齐（空白/非字符串/超长/未知都返回 ok:false）', () => {
    const gw = gateway(makeTree('cancel'))
    const bag = gw as unknown as { _searchJobs: Map<string, AbortController> }
    expect(gw.cancelSearch()).toEqual({ ok: false })
    expect(gw.cancelSearch({})).toEqual({ ok: false })
    expect(gw.cancelSearch({ jobId: '  ' })).toEqual({ ok: false })
    expect(gw.cancelSearch({ jobId: 123 as unknown as string })).toEqual({ ok: false })
    expect(gw.cancelSearch({ jobId: '从未注册' })).toEqual({ ok: false })

    const long = 'j'.repeat(100)
    const ctrl = new AbortController()
    // 搜索层是按 `normalizeJobId` 之后的键注册的（见 gateway-support.ts 的 64 字截断）。
    // 这里刻意只注册**截断后**的键：壳若少做截断，这条就找不到控制器而返回 ok:false。
    bag._searchJobs.set('j'.repeat(64), ctrl)
    expect(gw.cancelSearch({ jobId: long })).toEqual({ ok: true })
    expect(ctrl.signal.aborted, 'ok:true 却没真的 abort ⇒ 取消是个假动作').toBe(true)

    const other = new AbortController()
    // 槽位里的键同样是 normalize 过的（去空白 + 截断 64），所以这里也按规整后的键注册。
    bag._searchJobs.set('job-trim', other)
    expect(gw.cancelSearch({ jobId: '  job-trim  ' }), '两侧空格该被 trim 后命中同一个槽').toEqual({ ok: true })
    expect(other.signal.aborted).toBe(true)
    // 同一个槽不会被取消第二次（跑完的 job 已经没了）——防「ok 恒真」这种假实现。
    bag._searchJobs.delete('job-trim')
    expect(gw.cancelSearch({ jobId: 'job-trim' })).toEqual({ ok: false })
  })

  it('getWordCloud：壳只是转发，options 按**同一个引用**交给 wordcloud 域处理器', () => {
    const gw = gateway(fullTree())
    const handler = (gw as unknown as {
      wordcloudRemotes: () => { getWordCloud: (o?: WordCloudOptions) => WordCloudResult }
    }).wordcloudRemotes()
    const sentinel = { words: [{ text: 'sentinel', count: 9 }], scanned: 3 } as WordCloudResult
    const spy = vi.spyOn(handler, 'getWordCloud').mockReturnValue(sentinel)
    const opts: WordCloudOptions = { scope: 'chat', username: 'wxid_a', limit: 3 }
    expect(gw.getWordCloud(opts), '返回值不是域处理器给的那份 ⇒ 壳自己吞了').toBe(sentinel)
    expect(spy.mock.calls.length).toBe(1)
    expect(spy.mock.calls[0]?.[0]).toBe(opts)
    expect(gw.getWordCloud()).toBe(sentinel)
    expect(spy.mock.calls[1]?.[0], '不传 options 时应原样给 undefined，而不是塞一个空对象').toBeUndefined()
  })

  it('listEditedMessages / listSummaryRecords / getGroupInfo / getPaymentStatus：可选与必选参数的形状', () => {
    const gw = gateway(fullTree())
    expect(gw.listEditedMessages()).toEqual({ items: [], total: 0 })
    expect(gw.listEditedMessages({ sessionId: 'wxid_a' })).toEqual({ items: [], total: 0 })
    expect(gw.listSummaryRecords()).toEqual({ items: [], total: 0 })
    expect(gw.listSummaryRecords({ taskId: 7 }).items).toEqual([])
    expect(gw.getGroupInfo({ username: '不存在@chatroom' })).toEqual({ group: null })
    const group = gw.getGroupInfo({ username: 'room1@chatroom' })
    expect(group.group?.name, '群名读不到 ⇒ contact.db 那条转发的 username 传丢了').toBe('RoomOne')
    expect(gw.getPaymentStatus({ serverId: '9001' })).toMatchObject({
      found: true, kind: 'transfer', serverId: '9001',
      transfer: { transferId: 'T1', beginTime: 100 },
    })
    expect(gw.getPaymentStatus({ serverId: '不可能存在的id' })).toEqual({ found: false })
    // 只有合并转发（local_type 49）能按 server_id 解析回来 —— 这是 query 侧的口径，
    // 壳这里要钉的是「serverId 字符串原样传下去」（数字/文本两种存法都别在壳上转成 number）。
    expect(gw.resolveChatHistory({ serverId: '2001' })).toMatchObject({ found: true })
    expect(gw.resolveChatHistory({ serverId: '2001' }).message?.localId).toBe(1)
    expect(gw.resolveChatHistory({ serverId: '1003' }), '普通文本消息按 server_id 查不到（口径如此）')
      .toMatchObject({ found: false })
    expect(gw.resolveChatHistory({ serverId: '-1' })).toMatchObject({ found: false })
    expect(gw.getMomentsAuthors().reduce((a, x) => a + x.count, 0)).toBe(5)
    // 月度分布回的是**快照**（`months` + 可选 `readError`），不是裸数组：
    // 「库读不动」与「一条朋友圈都没有」从此是两件事（P1-1/#9）。夹具的 content 里
    // 没有 create_time ⇒ 月份为空，但「读得动」所以 readError 必须缺席。
    const monthlySnap = gw.getMomentsMonthly()
    expect(Array.isArray(monthlySnap.months)).toBe(true)
    expect(monthlySnap.readError, `夹具里的 sns.db 是好的，不该报 readError：${String(monthlySnap.readError)}`).toBeUndefined()
  })
})

describe('写类壳的默认值与操作日志（同一层里唯一会落盘的那几条）', () => {
  it('setCdnImageEnabled / setCdnImageLocalDecrypt：键名写进 config.json，日志给的是人话', () => {
    const t = makeTree('cdn')
    const gw = gateway(t)
    expect(gw.setCdnImageEnabled({ enabled: false })).toEqual({ ok: true })
    expect(gw.setCdnImageLocalDecrypt({ localDecrypt: false })).toEqual({ ok: true })
    const cfg = getConfig(t.decrypted)
    // 断言的是**落盘的键名**：写成别的键就永远读不回来，界面表现是「开关拨了不生效」。
    expect(cfg['cdn_enabled']).toBe(false)
    expect(cfg['cdn_local_decrypt']).toBe(false)
    expect(gw.setCdnImageEnabled({ enabled: true }).ok).toBe(true)
    expect(getConfig(t.decrypted)['cdn_enabled']).toBe(true)
    const rows = listOperations(t.decrypted).items
    expect(rows.map((r) => r.action)).toContain('set_cdn_image_enabled')
    const local = rows.filter((r) => r.action === 'set_cdn_image_local_decrypt')
    expect(local.length).toBe(1)
    expect(local[0]?.status).toBe('ok')
    expect(local[0]?.detail).toBe('服务端解密')
    // 日志按 id DESC 回来：两次的理由都要在（拨上去是「开启」、拨下来是「关闭」，不是恒真的一句）。
    expect(new Set(rows.filter((r) => r.action === 'set_cdn_image_enabled').map((r) => r.detail)))
      .toEqual(new Set(['关闭', '开启']))
  })

  it('deleteAskHistory：ids 不是数组时按空集处理（Array.isArray 那道闸），并留下 skip 行', () => {
    const t = makeTree('askhistory')
    const gw = gateway(t)
    // 少了壳里 `Array.isArray(options?.ids) ? options.ids : []` 这一句，这里就是 TypeError 而不是 removed:0。
    expect(gw.deleteAskHistory({ ids: 'not-an-array' as unknown as number[] })).toEqual({ removed: 0 })
    expect(gw.deleteAskHistory({ ids: [] })).toEqual({ removed: 0 })
    const skipped = listOperations(t.decrypted).items.filter((r) => r.action === 'delete_ask_history')
    expect(skipped.length).toBe(2)
    expect(skipped.every((r) => r.status === 'skip'), '一条没删却记 ok ⇒ 日志开始说谎').toBe(true)

    const id = recordAsk(t.decrypted, { question: '问题', answer: '回答' })
    expect(typeof id).toBe('number')
    expect(gw.deleteAskHistory({ ids: [Number(id)] })).toEqual({ removed: 1 })
    const deleteRows = listOperations(t.decrypted).items.filter((r) => r.action === 'delete_ask_history')
    // 日志按 id DESC：删掉 1 条那一次在最前面，且 detail 要如实写「1 条」。
    expect(deleteRows[0]).toMatchObject({ status: 'ok', target: '1', detail: '1 条问答记录' })
    expect(gw.deleteAskHistory({ ids: [Number(id)] })).toEqual({ removed: 0 })
    expect(listOperations(t.decrypted).items.filter((r) => r.action === 'delete_ask_history')[0])
      .toMatchObject({ status: 'skip', target: '0', detail: '0 条问答记录' })
    recordAsk(t.decrypted, { question: 'Another', answer: 'x' })
    expect(gw.clearAskHistory().removed).toBe(1)
    expect(listOperations(t.decrypted).items.find((r) => r.action === 'clear_ask_history')?.status).toBe('ok')
    expect(gw.clearAskHistory().removed).toBe(0)
  })

  it('resetRetrievalWeights：把在飞权重打回配置值，并真的落盘', () => {
    const t = makeTree('weights')
    const gw = gateway(t)
    const base = defaultRetrievalConfig().rerank.weights
    const drifted: RerankWeights = { ...base, sparse: base.sparse + 5 }
    saveAdaptedWeights(t.decrypted, drifted)
    expect(loadAdaptedWeights(t.decrypted)?.sparse).toBe(drifted.sparse)

    const r = gw.resetRetrievalWeights()
    expect(r.ok).toBe(true)
    expect(r.weights).toEqual(base)
    expect(loadAdaptedWeights(t.decrypted), '返回了默认值但盘上还是漂移值 ⇒ 只改内存不改文件')
      .toEqual(base)
    const row = listOperations(t.decrypted).items.find((x) => x.action === 'reset_retrieval_weights')
    expect({ category: row?.category, status: row?.status }).toEqual({ category: 'settings', status: 'ok' })
  })

  it('clearSessionDraft / clearAllSessionDrafts：更新数与「已清除 N 条草稿」的日志同口径', () => {
    const t = fullTree()
    const gw = gateway(t)
    expect(gw.getSessions({ keyword: 'wxid_a' }).sessions[0]?.draft).toBe('一条草稿')
    const r = gw.clearSessionDraft({ username: 'wxid_a' })
    expect({ ok: r.ok, updated: r.updated }).toEqual({ ok: true, updated: 1 })
    expect(gw.getSessions({ keyword: 'wxid_a' }).sessions[0]?.draft).toBe('')
    expect(gw.clearSessionDraft({ username: '根本没有这个会话' })).toMatchObject({ ok: true, updated: 0 })
    expect(gw.clearAllSessionDrafts()).toMatchObject({ ok: true, count: 0 })
    const rows = listOperations(t.decrypted).items.filter((x) => x.action === 'clear_session_draft')
    expect(rows.length).toBe(2)
    expect(rows[1]?.detail).toBe('已清除 1 条草稿')
    expect(rows[0]?.detail).toBe('已清除 0 条草稿')
    expect(rows[0]?.target).toBe('根本没有这个会话')
  })

  it('editChatMessage / deleteFavoriteItems：失败与空集都给出可读结果，并如实记一条 fail/skip', () => {
    const t = fullTree()
    const gw = gateway(t)
    expect(gw.editChatMessage({ username: 'wxid_a', localId: 9999, content: '改写' }))
      .toMatchObject({ ok: false })
    const edit = gw.editChatMessage({ username: 'wxid_a', localId: 1, content: '改写后的正文' })
    expect(edit.ok, JSON.stringify(edit)).toBe(true)
    // 直接读分片里那一格：绕开消息正文的 XML 解析口径，钉的是「壳把 username/localId/content
    // 三个位置参数搬对了」（搬错任意一个，这一格就不会是新正文）。
    const shard = new DatabaseSync(join(t.decrypted, 'message', 'message_0.db'), { readOnly: true })
    const raw = shard.prepare(`SELECT message_content AS c FROM "${msgTable('wxid_a')}" WHERE local_id = 1`).get() as { c?: string } | undefined
    shard.close()
    expect(raw?.c).toBe('改写后的正文')
    const listed = gw.listEditedMessages({ sessionId: 'wxid_a' })
    expect(listed.total).toBe(1)
    expect(listed.items[0]?.localId).toBe(1)
    expect(gw.listEditedMessages({ sessionId: '没有这个会话' }).items).toEqual([])

    expect(gw.deleteFavoriteItems({ ids: [] })).toEqual({ ok: true, deleted: 0 })
    expect(gw.deleteFavoriteItems({ ids: [2] })).toEqual({ ok: true, deleted: 1 })
    expect(gw.getFavorites().favorites.map((f) => f.localId)).toEqual([3, 1])
    expect(gw.deleteFavoriteItems({ ids: [4242] })).toEqual({ ok: true, deleted: 0 })
    const rows = listOperations(t.decrypted).items
    expect(rows.find((r) => r.action === 'delete_favorite_items' && r.detail === '删除 1 项')).toBeTruthy()
    expect(rows.find((r) => r.action === 'edit_chat_message' && r.status === 'fail' && r.target === 'wxid_a'))
      .toBeTruthy()
  })

  it('verifyDatabaseKey / openPath：拒绝要有理由，不许静默什么都不发生', async () => {
    const t = makeTree('openpath')
    const gw = gateway(t)
    const bad = gw.verifyDatabaseKey({ dbPath: join(t.root, 'nope.db'), encKeyHex: '00' })
    expect(bad.valid).toBe(false)
    expect(typeof bad.error).toBe('string')
    expect((bad.error ?? '').trim().length, '校验失败却不说明原因').toBeGreaterThan(0)
    expect(listOperations(t.decrypted).items.find((r) => r.action === 'verify_db_key')?.status).toBe('fail')

    // dataRoot = dirname(decrypted)：证明壳真的按「解密目录的上一级」来划范围。
    const inside = join(t.root, 'evil.exe')
    const execDenied = await gw.openPath({ path: inside }, new AbortController().signal)
    expect(execDenied.ok).toBe(false)
    expect(execDenied.path).toBe(inside)
    expect(execDenied.error ?? '', '数据根之内的 .exe 该按「可执行」拒，而不是被当成范围外')
      .toMatch(/可执行/)
    expect(execDenied.error ?? '').not.toMatch(/只能打开应用自己数据目录/)

    const outside = await gw.openPath({ path: resolve('package.json') }, new AbortController().signal)
    expect(outside.ok).toBe(false)
    expect(outside.error ?? '').toMatch(/数据目录/)

    const empty = await gw.openPath({ path: '   ' }, new AbortController().signal)
    expect(empty).toMatchObject({ ok: false, path: '   ' })
    expect(empty.error).toMatch(/没有给出/)
  })

  it('detectWechatAccounts：形状与 total 自洽（结果随机器，不许随机器崩）', () => {
    const t = makeTree('detect')
    const gw = gateway(t)
    const snap = gw.detectWechatAccounts()
    expect(Array.isArray(snap.accounts)).toBe(true)
    expect(snap.total).toBe(snap.accounts.length)
    const row = listOperations(t.decrypted).items.find((r) => r.action === 'detect_accounts')
    expect({ category: row?.category, status: row?.status, detail: row?.detail })
      .toEqual({ category: 'keys', status: 'ok', detail: `发现 ${String(snap.total)} 个账号` })
  })
})

describe('只读契约', () => {
  it('跑完整条只读面之后，解密树一字不动；数据根里只有操作日志被允许写', () => {
    const t = fullTree()
    const gw = gateway(t)
    const probes = readProbes(gw)
    // 先把每个探针各跑一遍并确认没有一个抛：抛了就没法判断「没写盘」是「没执行」还是「真的只读」。
    const thrown: string[] = []
    for (const p of probes) {
      try {
        expect(p.call(), p.name + ' 返回 undefined').toBeDefined()
      } catch (e) {
        thrown.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    expect(thrown, '这些只读端点在**有**快照时抛了：\n  ' + thrown.join('\n  ')).toEqual([])
    // 指纹取的是**整个数据根**（decrypted + 同级的操作日志/问答库 + decoded 缓存目录）：
    // 只比 decrypted 会被「其实只是写到了别处」蒙过去 —— 那条路才是用户磁盘上多出来的东西。
    const before = fingerprint(t.root)
    for (const p of probes) p.call()
    const after = fingerprint(t.root)
    const diff = after.filter((line, i) => line !== before[i])
    expect(before.length, '数据根一个文件都没有 ⇒ 这条判据是空转').toBeGreaterThan(4)
    const dirtySnapshot = diff.filter((l) => !l.includes('wechat_privacy.db'))
    expect(dirtySnapshot, '只读方法改了快照/缓存之外的东西：\n  ' + dirtySnapshot.join('\n  ')).toEqual([])
    // 唯一被允许动的是应用自己的操作日志，而**为什么**它会动是可枚举的：
    // `getAnnualReview` / `getAnnualReport` 两个壳各 `this.op('task', …)` 记一行。
    // 哪天有新的读壳开始偷偷写日志，这条会立刻点出多出来的动作名。
    const actions = [...new Set(listOperations(t.decrypted).items.map((r) => r.action))].sort()
    expect(actions, '读面上这些端点往操作日志里写了行').toEqual(['annual_review', 'generate_annual_report'])
  })

  it('构造网关与只读查询都不许在仓库里创建路径（此前有过 whisper/bin 那类事故）', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
    const watched = ['src', 'wechat', 'scripts', 'docs'].map((p) => join(repoRoot, p))
    const snapshot = (): string[] => watched.filter((p) => existsSync(p)).flatMap((p) => fingerprint(p))
    const t = fullTree()
    const gw = gateway(t)
    const before = snapshot()
    for (const p of readProbes(gw)) {
      try { p.call() } catch { /* 这里只关心「有没有往仓库里写」，形状由别的用例管 */ }
    }
    expect(gw.getContacts({ limit: 1 }).total).toBeGreaterThan(0)
    const after = snapshot()
    expect(after.filter((line, i) => line !== before[i]), '读接口动了仓库里的文件').toEqual([])
    expect(after.length).toBe(before.length)
  })

  it('没有快照时：不抛就给出声明的形状，绝不让 undefined 流到渲染层', () => {
    const t = makeEmptyTree('nosnapshot')
    const gw = gateway(t)
    const probes: Array<{ name: string; call: () => unknown }> = [
      ...readProbes(gw),
      { name: 'detectWechatAccounts', call: () => gw.detectWechatAccounts() },
      { name: 'verifyDatabaseKey', call: () => gw.verifyDatabaseKey({ dbPath: join(t.root, 'x.db'), encKeyHex: '00' }) },
    ]
    const leaks: string[] = []
    const unreadable: string[] = []
    const shapeless: string[] = []
    const returned: string[] = []
    const threw: string[] = []
    for (const p of probes) {
      try {
        const r: unknown = p.call()
        if (r === undefined || r === null) leaks.push(`${p.name} 返回 ${String(r)}`)
        else if (typeof r !== 'object') leaks.push(`${p.name} 返回了裸标量 ${typeof r}`)
        else if (!Array.isArray(r) && Object.keys(r).length === 0) shapeless.push(p.name)
        else returned.push(p.name)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.trim() === '') unreadable.push(p.name + '（抛了，但异常没有可读文案）')
        else threw.push(p.name)
      }
    }
    // 两条路都必须走得通：给形状，或抛一句人话。
    expect(leaks, '没有快照时这些端点把 undefined 交给了渲染层：\n  ' + leaks.join('\n  ')).toEqual([])
    expect(unreadable, '这些端点抛了却没人话，界面只能显示「请求失败」：\n  ' + unreadable.join('\n  ')).toEqual([])
    expect(shapeless, '这些端点返回 {}（快照字段全丢，界面只能白屏）：\n  ' + shapeless.join('\n  ')).toEqual([])
    expect(returned.length, '空转哨兵：一条都没跑出形状（返回/抛出的计数都不对）').toBeGreaterThan(0)
    expect(returned.length + threw.length).toBe(probes.length)
    // 具体口径（不是「有个对象就行」）：缺库时这几条必须明确说「没有」，而不是崩。
    expect(gw.getSearchIndexStatus()).toEqual({ exists: false, rows: 0, built_at: null, ready: false })
    expect(gw.getMoments()).toEqual({ moments: [], total: 0 })
    expect(gw.getMomentsAuthors()).toEqual([])
    expect(gw.getRecords({ kind: 'transfers' })).toEqual({ items: [], total: 0 })
    expect(gw.getPaymentStatus({ serverId: '1' })).toEqual({ found: false })
    expect(gw.getVoiceTranscript({ username: 'wxid_a', localId: 1 })).toEqual({ error: '未找到语音消息' })
    expect(gw.getSelfUsername()).toEqual({ username: 'wxid_self' })
    expect(gw.listEditedMessages()).toEqual({ items: [], total: 0 })
    expect(gw.deleteFavoriteItems({ ids: [1] })).toEqual({ ok: false, deleted: 0, error: '收藏库不存在' })
    expect(gw.clearSessionDraft({ username: 'wxid_a' })).toEqual({ ok: false, updated: 0, error: '解密 session.db 不存在' })
    // 会话/通讯录/收藏那条路径是**直接开库**：库不存在时 node:sqlite 抛错。壳没兜，所以渲染层
    // 会拿到异常 —— 这正是本用例要钉住的现状：抛的必须是「打不开库文件」，不能是 undefined。
    const openFail: string[] = []
    for (const name of ['getSessions', 'getContacts', 'getFavorites'] as const) {
      try {
        void (gw as unknown as Record<string, () => unknown>)[name]?.()
      } catch (e) {
        openFail.push(name + ' => ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    expect(openFail.length, '这三条在无快照时居然静默返回了').toBe(3)
    expect(openFail.every((l) => /open|CANTOPEN|unable to open/i.test(l)), openFail.join(' | ')).toBe(true)
  })
})
