/**
 * 「重读查询必须让出事件循环」（CODE-AUDIT-2026-09-26 P1-2，§七 第二批 #11）。
 *
 * ## 这笔账为什么值得单独立一条守卫
 *
 * `node:sqlite` 全是同步 API ⇒ 一个不 await 的查询 = **把承载全部请求的那条事件循环钉住**。
 * 实测后果：世界板块自身只要 13ms，排在一次 15 秒的词云后面
 * 等到的是 **17,008ms**；生产日志里有 `analyzeVisibleMessages` 54,103ms。用户侧的表现
 * 从来不是「这个查询慢」，而是**别的面板一起转圈** —— 所以判据必须量「有没有让别人跑」。
 *
 * ## 判据怎么量（不依赖墙上时钟）
 *
 * 起一个 `setImmediate` 自我调度的探针，与查询**并发**跑；查询结束后读探针计数。
 * 同步实现期间探针一个 tick 都拿不到（微任务/宏任务都被压在同一个 task 后面），
 * 让出一次就多一个 tick。于是「让出次数」变成可数的东西，CI 机器慢 20 倍也不影响结论。
 *
 * ## 还有两件事顺带钉住
 *
 *  · `cachedBySigAsync` 的**同键合流**：让出之后两次冷算真的会同时在跑，
 *    不合流就等于把 54 秒跑两遍（事件循环更堵）。
 *  · `withDbAsync` 存在的理由：把异步回调塞进同步的 `withDb`，连接会在**第一次让出时**
 *    就被关掉 —— 小库上恒绿、大库上偶发「database is not open」，是最难查的那一类。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { startTickProbe } from '../../tests/helpers/tick-probe.ts'

import { withDb, withDbAsync } from '../src/query/db-open.ts'
import { cachedBySigAsync, fileSigOf } from '../src/query/meta.ts'
import { decryptAllImageDats } from '../src/query/decrypt-images.ts'
import { resolveSnsVideoCoverDataUrlsAsync, snsVideoIndexForTest } from '../src/query/sns-video.ts'
import { queryPrivacyScan, PRIVACY_YIELD_EVERY_ROWS } from '../src/query/privacy.ts'
import { queryStorageStats } from '../src/query/storage.ts'
import { queryOverviewInsights, SNS_YIELD_EVERY_ROWS } from '../src/query/overview-insights.ts'
import { queryWordCloud } from '../src/query/wordcloud.ts'
import { YIELD_EVERY_CHARS, YIELD_EVERY_ROWS } from '../src/query/search-build.ts'

const scratch: string[] = []
const roots: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots.length = 0
})

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex')

/**
 * 探针本身在 `src/backend/tests/helpers/tick-probe.ts`（账本那条用例共用同一份实现，
 * 免得两处各写一个「一次让出 = 一个 tick」的计数口径）。
 */
const tickProbe = startTickProbe

/**
 * 造一个「有几个消息分片、每片一张 Msg_ 表」的数据根。
 * @param rows - 每张表写多少行（行很小，主要是让循环真的跑起来）。
 */
function makeMsgTree(rows: number, shards = ['message_0.db', 'message_1.db']): string {
  const dir = mkdtempSync(join(tmpdir(), 'yield-'))
  scratch.push(dir)
  const dec = join(dir, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  for (const shard of shards) {
    const db = new DatabaseSync(join(dec, 'message', shard))
    db.exec('CREATE TABLE Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (create_time INTEGER, local_type INTEGER, real_sender_id INTEGER, message_content TEXT)')
    const ins = db.prepare('INSERT INTO Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa VALUES (?,?,?,?)')
    // W2-13.1：开事务。本机实测（台账里有原始数字）—— 同一个 makeMsgTree(2000)，
    // **不开事务** 4259ms、开事务 12ms，差 355 倍；而查询本体只要 7ms。
    // 也就是说这条用例 95% 的时间花在「造数据」而不是「跑查询」上：
    // A 类榜首要从 22.9s 压下来，唯一该动的地方是这里，而不是生产代码或判据。
    db.exec('BEGIN')
    for (let i = 0; i < rows; i += 1) ins.run(1_700_000_000 + i, 1, 0, '文本')
    db.exec('COMMIT')
    db.close()
  }
  return dec
}

describe('总览分析必须让出事件循环', () => {
  it('多个消息分片 ⇒ 分片之间真的让出过（探针拿得到 tick）', async () => {
    const dec = makeMsgTree(2_000)
    const stop = tickProbe()
    const r = await queryOverviewInsights(dec, 'wxid_a')
    const ticks = stop()
    expect(r.messages.total, '夹具没真的跑出统计 ⇒ 下面的让出判断是空转').toBeGreaterThan(0)
    console.log(`[算料|yield] 2 分片 × 2000 行：探针 ticks=${String(ticks)}`)
    // 让出点 = 2 个分片边界 ⇒ 下界 3。少一处就掉到 2。
    expect(ticks, '一次都没让出 = 这条查询把事件循环从头钉到尾（排队放大器的本体）').toBeGreaterThanOrEqual(3)
  })

  it('单分片但朋友圈行数超过一档 ⇒ 行级让出也真的发生', async () => {
    const dec = makeMsgTree(500, ['message_0.db'])
    // 朋友圈表：行数刻意超过 SNS_YIELD_EVERY_ROWS，让行级让出至少触发一次。
    const sns = join(dec, 'sns', 'db_sns')
    mkdirSync(sns, { recursive: true })
    const db = new DatabaseSync(join(sns, 'sns.db'))
    db.exec('CREATE TABLE SnsTimeLine (content TEXT)')
    const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?)')
    db.exec('BEGIN')   // W2-13.1：不开事务时 2001 条要两秒以上
    for (let i = 0; i < SNS_YIELD_EVERY_ROWS + 1; i += 1) ins.run('<media>x</media>')
    db.exec('COMMIT')
    db.close()
    const stop = tickProbe()
    const r = await queryOverviewInsights(dec, 'wxid_a')
    const ticks = stop()
    expect(r.moments.total, `朋友圈夹具没读到 ${String(SNS_YIELD_EVERY_ROWS + 1)} 行`).toBe(SNS_YIELD_EVERY_ROWS + 1)
    console.log(`[算料|yield] 1 分片 + ${String(SNS_YIELD_EVERY_ROWS + 1)} 条朋友圈：探针 ticks=${String(ticks)}`)
    // 让出点 = 1 个分片边界 + 满一档 1 次 + 收尾 1 次 = 3 ⇒ 下界 4。
    expect(ticks, '只有分片边界让出、整表扫一口气跑完 ⇒ 大账号仍然会钉住循环')
      .toBeGreaterThanOrEqual(4)
  })

  it('坏掉的朋友圈库：让出之后照样关得掉（读过的文件删得掉 = 没漏句柄）', async () => {
    const dec = makeMsgTree(10, ['message_0.db'])
    const sns = join(dec, 'sns', 'db_sns')
    mkdirSync(sns, { recursive: true })
    const bad = join(sns, 'sns.db')
    writeFileSync(bad, '这不是 SQLite', 'utf8')
    const r = await queryOverviewInsights(dec, 'wxid_a')
    expect(r.moments.total, '坏库必须被跳过而不是把整个总览带走').toBe(0)
    // Windows：连接还开着的话这句必定 EPERM/EBUSY。
    rmSync(bad)
    expect(existsSync(bad)).toBe(false)
  })
})

describe('withDbAsync 存在的理由（把 await 塞进同步 withDb 会怎样）', () => {
  it('同步 withDb + 异步回调：连接在第一次让出时就被关掉 ⇒ 游标读不动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbo-'))
    scratch.push(dir)
    const file = join(dir, 'x.db')
    const w = new DatabaseSync(file)
    w.exec('CREATE TABLE t (a INTEGER)')
    w.prepare('INSERT INTO t VALUES (1)').run()
    w.close()
    // 这就是「顺手用 withDb 包一下异步逻辑」的真实后果：不抛才奇怪。
    await expect(withDb(file, async (db) => {
      await new Promise<void>((r) => { setImmediate(r) })
      return (db.prepare('SELECT a FROM t').all() as Array<{ a: number }>).length
    })).rejects.toThrow()
    // 异步版同一份数据必须读得到。
    expect(await withDbAsync(file, async (db) => {
      await new Promise<void>((r) => { setImmediate(r) })
      return (db.prepare('SELECT a FROM t').all() as Array<{ a: number }>).length
    })).toBe(1)
  })

  it('withDbAsync 在回调抛错时也必须关连接（否则 Windows 上再也换不掉这个文件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbo2-'))
    scratch.push(dir)
    const file = join(dir, 'y.db')
    const w = new DatabaseSync(file)
    w.exec('CREATE TABLE t (a INTEGER)')
    w.close()
    await expect(withDbAsync(file, async () => { throw new Error('算不动') })).rejects.toThrow('算不动')
    rmSync(file)
    expect(existsSync(file), '抛错路径上漏了 close ⇒ 文件删不掉（P0-1 那一族）').toBe(false)
  })
})

describe('cachedBySigAsync：命中、合流与失败', () => {
  it('同一签名只算一次；签名变了必须重算', async () => {
    let loads = 0
    const f = (sig: string): Promise<number> => {
      loads += 1
      return Promise.resolve(loads)
    }
    expect(await cachedBySigAsync('k1', 'a', () => f('a'))).toBe(1)
    expect(await cachedBySigAsync('k1', 'a', () => f('a')), '第二次不该重新算').toBe(1)
    expect(loads).toBe(1)
    expect(await cachedBySigAsync('k1', 'b', () => f('b')), '签名变了还回旧值').toBe(2)
    expect(loads).toBe(2)
  })

  it('并发同键只跑一份 loader（让出之后真的会撞见这种情况）', async () => {
    let loads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    const call = (): Promise<number> => {
      loads += 1
      return gate.then(() => loads)
    }
    const p1 = cachedBySigAsync('k2', 'a', call)
    const p2 = cachedBySigAsync('k2', 'a', call)
    release?.()
    const [v1, v2] = await Promise.all([p1, p2])
    expect(loads, '两个并发调用各算了一份 ⇒ 54 秒的查询被跑了两遍').toBe(1)
    expect(v2).toBe(v1)
    // 结算之后同键再问：走缓存，不再起 loader。
    expect(await cachedBySigAsync('k2', 'a', call)).toBe(v1)
    expect(loads).toBe(1)
  })

  it('loader 失败不写缓存、也不留在飞表里（下一次必须能重试）', async () => {
    let n = 0
    const boom = async (): Promise<number> => {
      n += 1
      throw new Error('第一次坏了')
    }
    await expect(cachedBySigAsync('k3', 'a', boom)).rejects.toThrow('第一次坏了')
    expect(await cachedBySigAsync('k3', 'a', async () => { n += 1; return n }), '失败被当成结果缓存住了').toBe(2)
    expect(n).toBe(2)
  })
})

describe('隐私体检也要让出（同一族：60 万行量级的整表扫）', () => {
  /**
   * 造一个「两个消息分片 + 一个会话」的数据根。
   * 表名必须是 `Msg_<md5(username)>`（隐私扫描按会话用户名反查表名），
   * 否则 `fileInfos` 是空的 —— 那样只剩分片边界的让出，行级判据就成空转了。
   */
  function makePrivacyTree(rowsByShard: number[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'yield-priv-'))
    scratch.push(dir)
    const dec = join(dir, 'decrypted')
    mkdirSync(join(dec, 'message'), { recursive: true })
    mkdirSync(join(dec, 'session'), { recursive: true })
    const table = 'Msg_' + md5('wxid_a')
    const sdb = new DatabaseSync(join(dec, 'session', 'session.db'))
    sdb.exec('CREATE TABLE SessionTable (username TEXT)')
    sdb.prepare('INSERT INTO SessionTable VALUES (?)').run('wxid_a')
    sdb.close()
    rowsByShard.forEach((rows, i) => {
      const db = new DatabaseSync(join(dec, 'message', `message_${String(i)}.db`))
      db.exec(`CREATE TABLE ${table} (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
      const ins = db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`)
      db.exec('BEGIN')   // W2-13.1：5006 行不开事务时是这一条用例 5.3s 的主要来源
      for (let k = 0; k < rows; k += 1) ins.run(k + 1, 1_700_000_000 + k, 1, '邮箱 a1@ex.com')
      db.exec('COMMIT')
      db.close()
    })
    return dec
  }

  it('分片之间 + 每张表 + 每 5000 行，三类让出都真的发生', async () => {
    const dec = makePrivacyTree([PRIVACY_YIELD_EVERY_ROWS + 1, 5])
    const stop = tickProbe()
    const r = await queryPrivacyScan(dec, 1_000_000)
    const ticks = stop()
    expect(r.total_hits, '夹具没真的扫到命中 ⇒ 下面的让出判断是空转').toBeGreaterThan(0)
    console.log(`[算料|yield] 隐私体检 2 分片（${String(PRIVACY_YIELD_EVERY_ROWS + 1)} + 5 行）：探针 ticks=${String(ticks)}`)
    // 让出点 = 探测 2 次（每分片）+ 扫描 2 次（每表）+ 行级 1 次（5001 行满一档）= 5 ⇒ 下界 6。
    expect(ticks, '三类让出点（分片 / 每表 / 每 5000 行）少任何一处都会掉到 6 以下')
      .toBeGreaterThanOrEqual(6)
  })
})

describe('存储统计也要让出（msg/file 整树 stat + 每条大文件都可能翻遍分片）', () => {
  /** 造 `wechatBaseDir/msg/file/<月份>/…` + 一个能读出三条大文件的 message_resource.db。 */
  function makeStorageTree(): { base: string; dec: string; largeRows: number } {
    const dir = mkdtempSync(join(tmpdir(), 'yield-stor-'))
    scratch.push(dir)
    const base = join(dir, 'raw')
    const dec = join(dir, 'decrypted')
    for (const month of ['2026-08', '2026-09']) {
      mkdirSync(join(base, 'msg', 'file', month), { recursive: true })
      writeFileSync(join(base, 'msg', 'file', month, '报告.pdf'), 'x'.repeat(4000 + month.length), 'utf8')
    }
    mkdirSync(join(dec, 'message'), { recursive: true })
    const db = new DatabaseSync(join(dec, 'message', 'message_resource.db'))
    db.exec(`
      CREATE TABLE MessageResourceDetail (message_id INTEGER, type INTEGER, size INTEGER, packed_info BLOB, data_index TEXT, create_time INTEGER);
      CREATE TABLE MessageResourceInfo (message_id INTEGER, chat_id INTEGER, sender_id INTEGER, message_svr_id INTEGER);
      CREATE TABLE ChatName2Id (user_name TEXT);
      CREATE TABLE SenderName2Id (user_name TEXT);`)
    const insD = db.prepare('INSERT INTO MessageResourceDetail VALUES (?,?,?,?,?,?)')
    const insI = db.prepare('INSERT INTO MessageResourceInfo VALUES (?,?,?,?)')
    db.prepare('INSERT INTO ChatName2Id VALUES (?)').run('wxid_a')
    db.prepare('INSERT INTO SenderName2Id VALUES (?)').run('wxid_a')
    for (let i = 1; i <= 3; i += 1) {
      insD.run(i, 1, 4000 + i, null, String(i), 1_700_000_000 + i)
      insI.run(i, 1, 1, 9000 + i)
    }
    db.close()
    return { base, dec, largeRows: 3 }
  }

  it('月份目录之间 + 每条大文件之间都让出', async () => {
    const { base, dec, largeRows } = makeStorageTree()
    const stop = tickProbe()
    const r = await queryStorageStats(dec, base)
    const ticks = stop()
    expect(r.large_files.length, '夹具没真的产出大文件 ⇒ 下面的让出判断是空转').toBe(largeRows)
    console.log(`[算料|yield] 存储统计 2 个月份目录 + ${String(largeRows)} 条大文件：探针 ticks=${String(ticks)}`)
    // 让出点 = 2（月份）+ 3（每条大文件）= 5 ⇒ 下界 6。
    expect(ticks, '两处让出点（月份目录 / 每条大文件）少任何一处都会掉到 6 以下')
      .toBeGreaterThanOrEqual(6)
  })

  it('F1：同签名二次查询走缓存（让出点数掉到基线），改数据后签名变了必须重算', async () => {
    const { base, dec } = makeStorageTree()
    // 冷跑基线：探针口径是 `ticks == 让出次数 + 1`，所以「零让出」= 1。
    const baselineStop = tickProbe()
    const baseline = baselineStop()
    expect(baseline, '探针基线应当恰好是 1（见 tick-probe 的口径说明）').toBe(1)
    const cold = tickProbe()
    const first = await queryStorageStats(dec, base)
    const coldTicks = cold()
    expect(coldTicks, '冷跑居然没有让出 ⇒ 夹具或让出点有问题').toBeGreaterThan(baseline)
    // 第二次：同签名 ⇒ 直接吃缓存，不该再有让出（这就是 F1 的收益：92ms → ~0ms）。
    const warm = tickProbe()
    const second = await queryStorageStats(dec, base)
    const warmTicks = warm()
    console.log(`[算料|yield] 存储统计冷=${String(coldTicks)} tick / 热=${String(warmTicks)} tick（基线 1 = 零让出）`)
    /**
     * ⚠️ 判据以**对象同一性**为主（2026-09-29 改）：tick 探针数的是事件循环转数，
     * 全量并行时定时器会被饿着/抖动，"热跑 tick 恰好等于基线""热跑 tick < 冷跑 tick"
     * 两种写法都**偶发**失败（实测：同一条用例先后以这两种口径各红一次）。
     * 而 `cachedBySigAsync` 命中时返回的是**缓存里那一份同一个对象** ⇒ `toBe` 是
     * 与负载无关的硬证据：返回了新对象就一定重算过。tick 只留一个宽松上界做旁证。
     */
    expect(warmTicks, '热跑的让出点数应当接近基线（允许负载带来的额外转圈）').toBeLessThanOrEqual(baseline + 4)
    expect(second, '热跑没走缓存 ⇒ 返回的不是同一份对象（cachedBySigAsync 没包住整个查询）').toBe(first)
    // 改库（signature 变）⇒ 必须重算，不能把旧值端上来。
    const db = new DatabaseSync(join(dec, 'message', 'message_resource.db'))
    const sigBefore = fileSigOf(join(dec, 'message', 'message_resource.db'))
    db.prepare('INSERT INTO MessageResourceDetail VALUES (?,?,?,?,?,?)').run(4, 1, 99999, null, '4', 1_700_000_100)
    db.prepare('INSERT INTO MessageResourceInfo VALUES (?,?,?,?)').run(4, 1, 1, 9004)
    db.close()
    /**
     * ⚠️ 这里**不再需要** `utimesSync` 推 mtime（2026-09-29 第 20 轮）。
     *
     * 曾经的失败输出是决定性的（`SUPERTIME_CACHE_TRACE=1`）：
     * ```
     * [算料|sig] 插入前=…4940830600:20480  插入后=…4940830600:20480   ← mtime 一个数字都没变
     * [cache-trace] hit storage-stats:… sig=…4940830600:20480…        ← 于是命中旧值
     * ```
     * 即 **NTFS 对最后写入时间懒刷新**，stat 类签名有固有陈旧窗口（文档： 通道④）。
     * 现在签名里加了 **SQLite 的文件变更计数器**（头部偏移 24，每次修改/checkpoint 自增，
     * 与文件时间无关）⇒ 插入后签名**必然**变化，这条断言不再依赖 mtime，也就回到了
     * "真的写了一条数据 ⇒ 必须重算"这个原始契约。
     */
    console.log(`[算料|sig] 插入前=${sigBefore} 插入后=${fileSigOf(join(dec, 'message', 'message_resource.db'))}`)
    const third = await queryStorageStats(dec, base)
    expect(third.total_size, '文件签名变了仍回旧值 ⇒ 缓存把「数据变了」这一维丢了').not.toBe(first.total_size)
  })
})

describe('词云也要让出（2026-09-28 补：上一轮漏登记的模块）', () => {
  it('多个消息分片 ⇒ 分片之间真的让出过（探针拿得到 tick）', async () => {
    const dec = makeMsgTree(2_000)
    const stop = tickProbe()
    const r = await queryWordCloud(dec, { scope: 'global' })
    const ticks = stop()
    // 防空转：夹具必须真的产出词，否则下面的 tick 判断量的是「没跑」而不是「让出了」。
    expect(r.scanned, '夹具没扫到正文 ⇒ 下面的让出判断是空转').toBeGreaterThan(0)
    console.log(`[算料|yield] 词云 2 分片 × 2000 行：探针 ticks=${String(ticks)}`)
    // 让出点 = 进入扫描前 1 次 + 2 个分片边界 ⇒ 下界 3。少一处就掉回 2。
    expect(ticks, '词云又变回「从头钉到尾」的同步扫（同屏其它请求会被它堵住）').toBeGreaterThanOrEqual(3)
  })

  it('单分片但正文行数超过一档 ⇒ 行级让出也真的发生', async () => {
    const dec = makeMsgTree(YIELD_EVERY_ROWS + 1, ['message_0.db'])
    const stop = tickProbe()
    const r = await queryWordCloud(dec, { scope: 'global' })
    const ticks = stop()
    expect(r.scanned, `夹具没读到 ${String(YIELD_EVERY_ROWS + 1)} 行正文`).toBe(YIELD_EVERY_ROWS + 1)
    console.log(`[算料|yield] 词云 1 分片 × ${String(YIELD_EVERY_ROWS + 1)} 行：探针 ticks=${String(ticks)}`)
    // 让出点 = 进入前 1 + 行级满一档 1 + 分片边界 1 ⇒ 下界 3。
    expect(ticks, '只有分片边界让出、整表扫一口气跑完 ⇒ 大账号仍然会钉住循环').toBeGreaterThanOrEqual(3)
  })

  /**
   * **字符级**阈值必须真的生效（2026-09-28 实测后补的判据）。
   *
   * 为什么单独立一条：上面那条用 2000 行**短**正文触发的是**行数**阈值，
   * 对"行少但每行很长"的形状完全无感 —— 而朋友圈正是后者。
   * 本机真实数据实测（`working/probe-wordcloud.txt`）：只有行阈值时
   * `wordcloud(moments)` 的**最长独占 111ms**；加上 `YIELD_EVERY_CHARS`
   * 之后降到 **13ms**。真实数据进不了单测，所以这里用"少行 × 超长正文"
   * 把同一个形状搬进夹具 —— 把字符阈值摘掉，这条必红。
   */
  it('行数远不够一档、但正文累计超过字符档 ⇒ 字符级让出也真的发生', async () => {
    const PER_ROW = 2000
    const ROWS = Math.ceil((YIELD_EVERY_CHARS * 2) / PER_ROW)
    expect(ROWS < YIELD_EVERY_ROWS, '夹具行数本身就够一档 ⇒ 这条测不到字符阈值').toBe(true)
    const long = '项目'.repeat(PER_ROW / 2)
    const root = mkdtempSync(join(tmpdir(), 'yield-'))
    scratch.push(root)
    const msgDir = join(root, 'message')
    mkdirSync(msgDir, { recursive: true })
    const table = 'Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const db = new DatabaseSync(join(msgDir, 'message_0.db'))
    db.exec(`CREATE TABLE "${table}" (create_time INTEGER, local_type INTEGER, message_content TEXT)`)
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?)`)
    db.exec('BEGIN')
    for (let i = 0; i < ROWS; i += 1) ins.run(1_700_000_000 + i, 1, long)
    db.exec('COMMIT')
    db.close()

    const stop = tickProbe()
    const r = await queryWordCloud(root, { scope: 'global' })
    const ticks = stop()
    expect(r.scanned, '夹具没读到正文 ⇒ 下面的让出判断是空转').toBe(ROWS)
    console.log(`[算料|yield] 词云 ${String(ROWS)} 行 × ${String(long.length)} 字符（行数不足一档）：探针 ticks=${String(ticks)}`)
    // 让出点 = 进入前 1 + 字符级至少 1 + 分片边界 1 ⇒ 下界 3。
    // 摘掉 `YIELD_EVERY_CHARS` 会掉到 2（只剩进入前与分片边界）。
    expect(ticks, '长正文没按字符让出 ⇒ 行少但很长的朋友圈仍会独占事件循环（实测 111ms）')
      .toBeGreaterThanOrEqual(3)
  })
})

describe('批量解码也要让出（attach 树收集不能退回同步驱动器）', () => {
  it('目录数超过让出档时，收集阶段真的让出过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yield-decrypt-'))
    scratch.push(root)
    const attach = join(root, 'msg', 'attach')
    mkdirSync(attach, { recursive: true })
    for (let i = 0; i < 65; i += 1) {
      mkdirSync(join(attach, 'd' + String(i).padStart(2, '0')))
    }
    const stop = tickProbe()
    const res = await decryptAllImageDats(root, join(root, 'decoded'), undefined, 0, 1)
    const ticks = stop()
    expect(res.total, '夹具没有 .dat，结果应为空批').toBe(0)
    // 默认每 60 个目录让出一次；65 个目录至少会触发一次（ticks = 让出数 + 1）。
    expect(ticks, '批量解密的目录收集仍是一次跑完，worker 会被 attach 树钉住').toBeGreaterThanOrEqual(2)
  })
})

describe('朋友圈视频索引扫描也要让出（整月 md5 冷扫不能钉住 worker）', () => {
  it('冷扫超过一个文件批次时，探针拿得到 tick', async () => {
    const base = mkdtempSync(join(tmpdir(), 'yield-sns-video-'))
    scratch.push(base)
    const dir = join(base, 'cache', '2026-01', 'Sns', 'Video', 'd0')
    mkdirSync(dir, { recursive: true })
    const md5s: string[] = []
    for (let i = 0; i < 40; i += 1) {
      const content = `cover-${String(i)}`
      md5s.push(createHash('md5').update(content).digest('hex'))
      writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.jpg`), content)
    }
    snsVideoIndexForTest().clear()
    const stop = tickProbe()
    const got = await resolveSnsVideoCoverDataUrlsAsync(base, [md5s[0] ?? ''])
    const ticks = stop()
    expect(got.get(md5s[0] ?? '')?.url, '夹具应当命中第一张封面').toBeDefined()
    // 每 32 个文件让出一次；40 个文件的冷扫至少一次（ticks = 让出数 + 1）。
    expect(ticks, '整月索引又变成一口气同步扫描').toBeGreaterThanOrEqual(2)
  })
})

/**
 * P1-2 点名的五个模块 + 2026-09-28 性能修复补的四个（`analyzeVisibleMessages` 均 36s /
 * `getRemoteImages` 峰值 86.5s / 封面与媒体取数）。**全部收完之后**这张表从「只能变小的棘轮」
 * 升级成零容忍清单：少任何一个让出点就红；再加新的同步重查询也要一并进这张表
 * （`[算料]` 会把名单打出来，空清单会被下面那条长度哨兵判红，所以它不会悄悄退化成恒真）。
 */
const P1_2_MODULES = [
  'overview-insights.ts',
  'privacy.ts',
  'storage.ts',
  'ledger.ts',
  'graph.ts',
  // 2026-09-28 性能修复（PERF-AUDIT-172）：日志里三个最慢的非本地取数模块。
  // 路径不同（`laya/` 与 `query/`），下面按模块名在**两个目录**里找。
  'analysis.ts',
  'remote-image.ts',
  'article-cover.ts',
  // 2026-09-28（本轮补）：`wordcloud.ts` 是上一轮**漏登记**的一个 —— 它的遮罩换成
  // Aho-Corasick 后单次冷算已压到 ~2 秒，但那 2 秒仍是**同步**占满 worker
  // （`wordcloud-perf.wiring.spec.ts` 头注记着实测：同屏「世界板块」自身 13ms
  // 被推迟到 17,008ms）。日志口径 `getWordCloud` 24 次 / 均 7.06s / 峰值 13.9s。
  'wordcloud.ts',
  // 2026-09-28（本轮补，真实数据探针 `working/probe-stall.txt`）：
  // `moments-insights.ts` 冷跑 **228ms 且一次都不让出** —— 是本次实测里
  // 「让出 0 且 >50ms」中最长的一个。根因是整张 SnsTimeLine 被 `.all()` 物化
  // 且提醒清单里又全表 `iterate()` 了一遍。
  'moments-insights.ts',
  // 2026-09-28（同一轮补）：`asset-insights.ts` 冷跑 **155ms 且一次都不让出** ——
  // 它要逐张打开全部消息分片（本机 146MB + 46MB + …）扫 `local_type=47`。
  'asset-insights.ts',
  // 2026-09-28（同一轮补）：`annual.ts` 冷跑 **117ms 且一次都不让出** ——
  // 逐张 `Msg_*` 表跑 `DISTINCT strftime(...)`（本机 351 张表）。
  'annual.ts',
  // 2026-09-28（本轮补）：`calls.ts` 冷跑 **87ms 且一次都不让出** ——
  // 逐张分片把 type-50 行 `.all()` 出来、再对每行做 XML 解析。
  'calls.ts',
  // 2026-09-28（本轮补）：`sessions.ts` 冷跑 **78ms 且一次都不让出** ——
  // 诊断（`working/diag-sessions.ts`）显示 `SessionTable` 读取只要 1ms，
  // 78ms 几乎全在「逐会话解析未读最早时间」那一圈（41 次 ×约 1.4ms）。
  'sessions.ts',
  // 2026-09-28（本轮补）：`overview.ts` 冷跑 **78ms 且一次都不让出** ——
  // 最后一个"整段独占"接口。两处热点：逐张分片找反撤回表（`countRevokedAcrossShards`）、
  // 以及 `SnsTimeLine` 全表的作者统计游标。
  'overview.ts',
  // 2026-09-28（本轮补）：`official-assets.ts` 冷跑 **39ms 且一次都不让出** ——
  // 受测集里最后一个独占项：逐张消息分片把公众号会话的整张 `Msg_*` 拉出来数条数。
  'official-assets.ts',
  // 注：`keys/image-key-resolver.ts` 的模板扫描（最多 500 个目录的 BFS）本轮也改成了
  // 可让出，但它**不在本清单里**：让出原语 `yieldToLoop` 属于查询层，`keys/` 不该反向依赖，
  // 所以让它做成生成器（`scanV2TemplatesSteps`）+ 由调用方 `remotes/keysdec.ts`
  // 传入让出节流（`templateScanYield`，每 8 个目录一次）。
  // 这条链路的证据在 `working/probe-remote.txt`：`verifyImageKey` 由 1603ms/0 让出
  // 降到片段上界 108ms、43 次让出。
  //
  // 2026-09-28（本轮补，真实 @Remote 探针播种真实 year 后才测到）：
  // 三个年报接口共用同一类"整年消息逐条 CPU 重活"的扫描，占用量级都是秒：
  //   · `getAnnualReport`  2254ms / 0 让出 → 片段上界 3ms、992 次让出
  //   · `getAnnualReview`  2150ms / 0 让出 → 36ms、66 次
  //   · `exportAnnualReport` 4048ms / 0 让出 → 5ms、842 次
  'annual-report.ts',
  'annual-review.ts',
  // 2026-09-28（本轮补）：`image-original-batch.ts` 的盘点扫描（逐张消息分片读
  // `local_type=3` 的行 + 逐条解析 img XML）。真实 @Remote 探针实测
  // `planOriginalFetch` 冷跑 **1719ms 且一次都不让出** —— 用户点一下「盘点原图覆盖率」
  // 整个后端停摆 1.7 秒。现在走生成器 + `scanImageOriginalPlanAsync`（分片级让出）。
  'image-original-batch.ts',
  // 2026-09-28（同一轮补）：`daily-summary.ts` 的 `collectRange` 要逐张分片枚举 `Msg_*`
  // 表再读行。真实 @Remote 探针实测 `generatePeriodSummary` 冷跑 **448ms / 0 让出**
  // （当时最长独占项）、`generateDailySummary` **230ms / 0 让出**、`extractTasks`
  // **372ms / 0 让出**（`remotes/tasks.ts` 也走这条）。现在走 `collectRangeSteps` 生成器
  // + `collectRangeAsync`（每 2 张分片让出一次 —— 步长必须小于分片数，否则本机 6 张分片
  // 只会让出 1 次、片段仍剩 220ms）。
  'daily-summary.ts',
  // 2026-09-28（本轮补）：`export-flows.ts` 的 `exportMoments` 逐页调 `queryMoments`
  // 取完整个朋友圈。实测冷跑 **273ms / 0 让出**；现在逐页让出（转到 129ms / 3 让出）。
  'export-flows.ts',
  // 2026-09-28（本轮补）：`backup.ts` 的 `createBackup` 用 `cpSync` **同步**整树复制
  // 每个子目录。实测冷跑 **206ms / 0 让出**（当时最长独占项）；现在每个子目录复制前让出
  // ⇒ **14ms / 14 让出**（本会话单点改善最大的一处）。
  'backup.ts',
  // 2026-09-28（本轮补）：`messages.ts` 的 `queryMessageByServerId` 要做两次
  // 「全分片 × 全表」等值查找。实测 `resolveChatHistory` 冷跑 **84ms / 0 让出**
  // （当时最后一个独占项）；现在逐分片让出 ⇒ **9ms / 8 让出**。
  'messages.ts',
  // 2026-09-29（守卫覆盖对账补的漏登）：这两处**直接调 `yieldToLoop`**，
  // 却是靠一份"账本 vs 清单"的对账脚本才发现的 —— 修过但没人管，等于随时能退回去。
  // 来源：`remotes/tasks.ts` 委派 `collectPeriodMessagesAsync`、`remotes/export.ts` 委派
  // `export-flows.ts`（后两者本身不含 `yieldToLoop`，所以**不入本清单**，见文件末注释）。
  'moments-monthly.ts',
  'keysdec.ts',
  // 2026-09-29（第 70 轮补）：`upgradeDecodedImages` 实测 **186ms / 0 让出** ——
  // 两棵同步目录树（`scanCachedImages` 扫 decoded 缓存、`collectImageDatFiles` 扫 msg/attach）。
  // 改成生成器 + 可让出驱动器后 **198ms / 15 让出 ⇒ 片段上界 12ms**（186 → 12，15.5×）。
  // 注意：**这个文件原先不在任何清单里**，是靠把探针超时从 4s 放到 180s 才第一次量到的
  // —— 4s 超时下它被记成 `TIMEOUT`，于是"只有让出次数、没有完整耗时"，谁也没看出它不让出。
  'image-upgrade.ts',
  'decrypt-images.ts',
  // 2026-10-15：sns-video 的整月 md5 扫描与大视频 base64 原本是同步独占段，
  // 生产入口改走异步流式版本后也纳入零容忍清单。
  'sns-video.ts',
]

describe('P1-2 点名的模块必须都有让出点（零容忍）', () => {
  it('清单里每个模块都含 yieldToLoop，且清单本身不被清空', () => {
    // ⚠️ 搜索面必须覆盖**清单里模块实际所在的目录**：原先只扫 `query/` 与 `laya/`，
    // 于是把 `remotes/keysdec.ts` 这类写进清单也永远"找不到文件" ⇒ 判为缺失。
    // 2026-09-29 做"账本 vs 清单"对账时发现并补上 `remotes/`。
    const srcDirs = [
      join(import.meta.dirname, '..', 'src', 'query'),
      join(import.meta.dirname, '..', 'src', 'laya'),
      join(import.meta.dirname, '..', 'src', 'remotes'),
    ]
    expect(P1_2_MODULES.length, '清单被清空 ⇒ 这条判据就是空转').toBeGreaterThanOrEqual(5)
    const missing = P1_2_MODULES.filter((name) => {
      const hit = srcDirs.map((d) => join(d, name)).find((p) => existsSync(p))
      // 找不到文件也算缺失：模块被改名/搬走时必须来更新这张表，而不是静默变绿。
      return hit === undefined || !readFileSync(hit, 'utf8').includes('yieldToLoop')
    })
    console.log(`[算料|yield] P1-2 清单 ${String(P1_2_MODULES.length)} 个模块，还没有让出点的：${missing.length === 0 ? '（无）' : missing.join(', ')}`)
    expect(missing, '这些模块又回到「从头钉到尾」的同步形状').toEqual([])
  })

  it('补过的模块里，让出是**调用点**而不是 import 行（改回同步循环必须被发现）', () => {
    // `includes('yieldToLoop')` 会被 `import { yieldToLoop }` 那一行命中 ⇒ 删掉调用点照样绿
    // （R7 的 `useEscapeToClose` 就是这么被变异测试抓出来的）。这里钉调用点。
    const CALL = /(?:^|[^A-Za-z0-9_$.])yieldToLoop\s*\(/
    const roots = join(import.meta.dirname, '..', 'src')
    const targets = [
      join(roots, 'laya', 'analysis.ts'),
      join(roots, 'query', 'remote-image.ts'),
      join(roots, 'query', 'article-cover.ts'),
    ]
    const stripped = targets.map((f) => {
      const text = readFileSync(f, 'utf8')
      // 剥注释：注释里写 `yieldToLoop()` 是文档，不是让出。
      const noComment = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      // 去掉 import 行后再找调用点。
      const noImport = noComment.replace(/^[ \t]*import[^\n]*\n/gm, '')
      return { f, hit: CALL.test(noImport) }
    })
    const noCall = stripped.filter((s) => !s.hit).map((s) => s.f.split(/[\\/]/).slice(-2).join('/'))
    expect(noCall, '只剩 import、没有真正的让出调用点 ⇒ 又变回独占事件循环').toEqual([])
  })
})

/**
 * W2-13.1：夹具插入必须包在事务里。
 *
 * ## 为什么这条值得一个判据
 *
 * 本机串行基线 2026-10-11 量出来：这个文件 **22.9 秒**，是 A 类榜首、超过
 * `TOP_BUDGET_MS` 的 15 秒预算。逐条计时发现四条最慢的用例（5.4s / 4.6s / 4.5s / 2.7s）
 * **没有一条慢在查询上**：单独量同一个夹具，建造 4259ms、查询本体 7ms。
 * 差在夹具的插入循环**没开事务** —— 4000 行自动提交 = 4000 次落盘，而一次事务只要 12ms。
 *
 * 包上事务之后整份 spec **0.72 秒**（32 倍），判据一条没改、断言一条没松、
 * 生产代码一行没动。这个失败方式完全不报错，只会让「某个测试文件越来越慢」悄悄发生，
 * 所以钉在这里：谁再把 `for (...) ins.run(...)` 写成裸循环，这条会红。
 *
 * @vitest-environment node
 */
describe('W2-13.1：夹具插入必须在事务里（否则「测试变慢」会不报错地发生）', () => {
  /** 「这个循环体就是一次插入」的形状：`for (...) ins.run(...)`。 */
  const BARE_INSERT = /^\s*for\s*\(.*\)\s*\w+\s*\.run\(/
  /** 剥掉行尾注释（注释里写着这种形状，不能把它自己判红）。 */
  const codeOf = (l: string): string => l.replace(/\s*\/\/.*$/, '')

  it('本文件里每个插入循环前面都有 BEGIN', () => {
    const self = readFileSync(new URL(import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const lines = self.split('\n')
    const bare: string[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const code = codeOf(lines[i] ?? '')
      if (!BARE_INSERT.test(code)) continue
      // 往前看 12 行内有没有 db.exec('BEGIN')
      const ctx = lines.slice(Math.max(0, i - 12), i).join('\n')
      if (!/exec\('BEGIN'\)/.test(ctx)) bare.push('第 ' + String(i + 1) + ' 行：' + code.trim().slice(0, 60))
    }
    expect(bare, '这些插入循环没有包在事务里 ⇒ 每行一次自动提交，夹具会慢两个数量级').toEqual([])
  })

  it('反面自证：裸插入循环确实会被抓出来（不是恒真）', () => {
    const bare = [
      "const db = new DatabaseSync('x')",
      "const ins = db.prepare('INSERT INTO t VALUES (?)')",
      'for (let i = 0; i < 100; i += 1) ins.run(i)',
      'db.close()',
    ].join('\n')
    const wrapped = [
      "const db = new DatabaseSync('x')",
      "db.exec('BEGIN')",
      "const ins = db.prepare('INSERT INTO t VALUES (?)')",
      'for (let i = 0; i < 100; i += 1) ins.run(i)',
      "db.exec('COMMIT')",
    ].join('\n')
    const hasBeginAbove = (src: string): boolean => {
      const ls = src.split('\n')
      const i = ls.findIndex(x => BARE_INSERT.test(codeOf(x)))
      return i >= 0 && /exec\('BEGIN'\)/.test(ls.slice(0, i).join('\n'))
    }
    expect(BARE_INSERT.test('for (let i = 0; i < 100; i += 1) ins.run(i)'), '判据的正则没匹配上插入循环').toBe(true)
    expect(hasBeginAbove(bare), '裸循环没被抓到 ⇒ 上面那条判据是空转的').toBe(false)
    expect(hasBeginAbove(wrapped), '有事务的代码不该被抓').toBe(true)
  })
})
