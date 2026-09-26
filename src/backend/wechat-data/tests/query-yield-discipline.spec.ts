/**
 * 「重读查询必须让出事件循环」（CODE-AUDIT-2026-09-26 P1-2，§七 第二批 #11）。
 *
 * ## 这笔账为什么值得单独立一条守卫
 *
 * `node:sqlite` 全是同步 API ⇒ 一个不 await 的查询 = **把承载全部请求的那条事件循环钉住**。
 * 实测后果写在 `docs/PERF-BASELINE.md`：世界板块自身只要 13ms，排在一次 15 秒的词云后面
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { withDb, withDbAsync } from '../src/query/db-open.ts'
import { cachedBySigAsync } from '../src/query/meta.ts'
import { queryPrivacyScan, PRIVACY_YIELD_EVERY_ROWS } from '../src/query/privacy.ts'
import { queryOverviewInsights, SNS_YIELD_EVERY_ROWS } from '../src/query/overview-insights.ts'

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
 * 与查询并发跑的 `setImmediate` 探针；`stop()` 返回它拿到的 tick 数。
 *
 * **为什么这个数是结构性的、不是掐表**：探针每轮排一个 `setImmediate`，
 * 而让出点用的也是 `setImmediate` ⇒ 队列里最多排着探针的**一个**回调；
 * 于是「一次让出 = 一个 tick」，再加开始时的一个 ⇒ `ticks == 让出次数 + 1`（实测如此）。
 * 所以断言的下界就取「让出次数 + 1」：**少任何一处让出都会直接掉下界**，
 * 不需要（也不应该）依赖墙上时钟或机器快慢。
 */
function tickProbe(): () => number {
  let ticks = 0
  let stop = false
  const loop = async (): Promise<void> => {
    while (!stop) {
      ticks += 1
      await new Promise<void>((r) => { setImmediate(r) })
    }
  }
  void loop()
  return () => { stop = true; return ticks }
}

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
    for (let i = 0; i < rows; i += 1) ins.run(1_700_000_000 + i, 1, 0, '文本')
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
    for (let i = 0; i < SNS_YIELD_EVERY_ROWS + 1; i += 1) ins.run('<media>x</media>')
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
      for (let k = 0; k < rows; k += 1) ins.run(k + 1, 1_700_000_000 + k, 1, '邮箱 a1@ex.com')
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

/**
 * #11 的**剩余清单**：P1-2 点名五个模块，本轮收了总览与隐私体检两个。
 * 写成判据而不是备忘：这五个里谁先加了让出，就必须从这里删一条 —— 只能变小。
 */
const STILL_SYNC_ONLY = [
  'query/graph.ts',
  'query/ledger.ts',
  'query/storage.ts',
]

describe('P1-2 剩余站点（棘轮：只能变小）', () => {
  it('未让出的模块确实还没有 yieldToLoop；清单外的模块不许偷偷加回来', () => {    const src = join(import.meta.dirname, '..', 'src', 'query')
    const still = STILL_SYNC_ONLY.filter((rel) => !readFileSync(join(src, rel.split('/').pop() as string), 'utf8').includes('yieldToLoop'))
    console.log(`[算料|yield] P1-2 还没让出的模块：${String(still.length)} / ${String(STILL_SYNC_ONLY.length)} —— ${still.join(', ') || '（无）'}`)
    expect(still, '有模块已经改成让出了 ⇒ 把它从 STILL_SYNC_ONLY 里删掉（清单只许变小）').toEqual(STILL_SYNC_ONLY)
  })
})
