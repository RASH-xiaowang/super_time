/**
 * P1-3 / P1-4 的实测验收：`queryGraph` 与 `queryPrivacyScan` 的**开库次数**与**正则编译次数**。
 *
 * 审查给的基线是本机真实库：`queryGraph` 冷 866ms / 热 795ms（后端无缓存），
 * `queryPrivacyScan` 冷 1020ms / 热 ~1000ms；而 graph 的 N+1 是「每张表把所在分片再开一遍」
 * （本机 290 会话 / 304 张 `Msg_*` 表 ⇒ 数百次开合），privacy 的是
 * 「每一行 × 每个不敏感类别都 `new RegExp(...)`」（`rowBudget` 60 万）。
 *
 * 判据为什么用「次数」而不是「毫秒」：
 *   · 墙钟在 CI 上比的是机器容量（本仓 ㉔/㉜ 两条老坑：同一份代码两次运行差 2.4 倍很常见）；
 *   · 「开合数不随会话数增长」与「第二次调用一次都不开库」这两条式子**恰好就是修复本身**，
 *     任何常数上界都会在下次多开一个库时误报。
 * 计数口径同 `[算料]`：数 `DatabaseSync.prototype.close`（一次 open 恰好配一次 close）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryGraph } from '../src/query/graph.ts'
import { queryPrivacyScan } from '../src/query/privacy.ts'

const scratch: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  scratch.length = 0
})

const SHARDS = ['message_0.db', 'message_1.db']
const tableOf = (username: string): string => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

/**
 * 造 `sessionCount` 个会话 × 2 个分片的最小库，外加通讯录与会话表。
 * 每个会话**横跨两个分片**（否则「按分片走」与「按表走」读到的东西一样，判据没判别力）。
 * @param tag - 目录标签（同时决定数据根，避免两次测量共用缓存条目）。
 * @param sessionCount - 会话数。
 * @returns 解密根目录。
 */
function makeFixture(tag: string, sessionCount: number): string {
  const root = mkdtempSync(join(tmpdir(), `wx-fanout-${tag}-`))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const users = Array.from({ length: sessionCount }, (_, i) => `wxid_${String(i)}`)

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER)')
  const insS = sdb.prepare('INSERT INTO SessionTable VALUES (?, ?, 1700000000)')
  for (const u of users) insS.run(u, `会话 ${u}`)
  sdb.close()

  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (username TEXT, local_type INTEGER, delete_flag INTEGER, small_head_url TEXT, big_head_url TEXT, remark TEXT)')
  const insC = cdb.prepare('INSERT INTO contact VALUES (?, 1, 0, \'\', ?, ?)')
  for (const [i, u] of users.entries()) insC.run(u, `https://example.invalid/a${String(i)}.png`, `好友${String(i)}`)
  cdb.close()

  for (const [shardIndex, shard] of SHARDS.entries()) {
    const db = new DatabaseSync(join(decrypted, 'message', shard))
    db.exec('CREATE TABLE dir2id (username TEXT)')
    db.exec('BEGIN')
    for (const u of users) {
      const t = tableOf(u)
      db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
      for (let i = 1; i <= 5; i += 1) {
        // 每片都带一条**含邮箱**的正文：privacy 扫描的命中数才能当判别据
        ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `分片${String(shardIndex)} 联系 he.zhang${String(i)}@example.com 一下`, i, '')
      }
    }
    db.exec('COMMIT')
    db.close()
  }
  return decrypted
}

/** 在一次调用期间数 sqlite 句柄的开合。 */
async function countOpens<T>(fn: () => T | Promise<T>): Promise<{ out: T; opens: number }> {
  const spy = vi.spyOn(DatabaseSync.prototype, 'close')
  const before = spy.mock.calls.length
  // 让出型查询要在 await 期间也算数，所以夹具自己也得是 async 的。
  const out = await fn()
  return { out, opens: spy.mock.calls.length - before }
}

describe('queryGraph：每个分片只开一次库 + 后端签名缓存', () => {
  it('开合数不随会话数增长（旧布局是「每张表把所在分片再开一遍」）', async () => {
    const few = await countOpens(() => queryGraph(makeFixture('graph-few', 3), 'wxid_self'))
    const many = await countOpens(() => queryGraph(makeFixture('graph-many', 9), 'wxid_self'))
    console.log(`[算料] 3 会话 × 2 分片：开合 ${String(few.opens)} 次；9 会话 × 2 分片：开合 ${String(many.opens)} 次`)
    expect(many.opens, `会话从 3 涨到 9，句柄开合从 ${String(few.opens)} 涨到 ${String(many.opens)} ⇒ 又退回逐表开库`)
      .toBe(few.opens)
    // 顺带钉住「按分片走仍然读全」：每个会话取到它那张 `Msg_*` 表的行数
    // （同一会话在两个分片里都有表时按 file-first 只算第一个 —— 既有语义，本次不动它）。
    const persons = (n: number): number => n
    expect(few.out.nodes.filter(x => x.kind !== 'self').length).toBe(persons(3))
    expect(many.out.nodes.filter(x => x.kind !== 'self').length).toBe(persons(9))
    expect(many.out.nodes.reduce((a, n) => a + (n.msg_count ?? 0), 0), '漏读分片时这个数会先掉下来')
      .toBe(9 * 5)
  })

  it('第二次调用一次库都不开（签名没变 ⇒  cachedBySig 直接回同一份）', async () => {
    const decrypted = makeFixture('graph-cached', 4)
    const first = await countOpens(() => queryGraph(decrypted, 'wxid_self'))
    expect(first.opens, '冷跑本该真的读库（0 说明夹具或计数坏了）').toBeGreaterThan(0)
    const second = await countOpens(() => queryGraph(decrypted, 'wxid_self'))
    expect(second.opens, '同样的数据第二次还要开库 ⇒ 后端缓存没生效（审查基线：热跑 795ms）')
      .toBe(0)
    expect(second.out.nodes).toEqual(first.out.nodes)
  })

  it('数据变了签名就变：不许出现「缓存挡住了新消息」', async () => {
    const decrypted = makeFixture('graph-fresh', 2)
    expect(queryGraph(decrypted, 'wxid_self').nodes.reduce((a, n) => a + (n.msg_count ?? 0), 0)).toBe(2 * 5)
    // 往**第一个**分片给其中一个会话追加 3 行（file-first 计数的就是这片；大小与 mtime 都会变）
    const db = new DatabaseSync(join(decrypted, 'message', SHARDS[0] ?? ''), { readOnly: false })
    const t = tableOf('wxid_0')
    const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
    for (let i = 10; i < 13; i += 1) ins.run(i, i, 1, 0, 1700000100 + i, 1, '新消息', i, '')
    db.close()
    const after = queryGraph(decrypted, 'wxid_self')
    expect(after.nodes.reduce((a, n) => a + (n.msg_count ?? 0), 0), '数据变了还拿旧快照 ⇒ 签名太宽松（这条是缓存最经典的错法）')
      .toBe(2 * 5 + 3)
  })
})

describe('queryPrivacyScan：正则外提 + 后端签名缓存', () => {
  /** 把 `RegExp` 构造换成计数器（正则**字面量**不走构造器，所以量到的就是运行期重编译）。 */
  async function regexBuildsWhile<T>(fn: () => T | Promise<T>): Promise<{ out: T; built: number }> {
    const Real = RegExp
    let built = 0
    class Counting extends Real {
      constructor(source: string, flags?: string) {
        super(source, flags)
        built += 1
      }
    }
    vi.stubGlobal('RegExp', Counting as unknown as RegExpConstructor)
    const out = await fn()
    vi.unstubAllGlobals()
    return { out, built }
  }

  it('扫描期间不再逐行编译正则（旧写法是「每行 × 每个不敏感类别」一次）', async () => {
    const decrypted = makeFixture('privacy-regex', 3)
    const r = await regexBuildsWhile(async () => queryPrivacyScan(decrypted, 100000))
    // 3 会话 × 2 片 × 5 行 = 30 行；旧写法在这里会编译 30 × 2（email+password）= 60 次
    expect(r.out.categories.find(c => c.key === 'email')?.count, '夹具本身必须真的命中邮箱（否则这条判据是空的）')
      .toBeGreaterThan(0)
    expect(r.built, `扫描过程中编译了 ${String(r.built)} 个正则 ⇒ 又回到每行 new RegExp`).toBe(0)
  })

  it('第二次调用一次库都不开（热跑从 ~1000ms 到 0ms）', async () => {
    const decrypted = makeFixture('privacy-cached', 3)
    const first = await countOpens(async () => queryPrivacyScan(decrypted, 100000))
    expect(first.opens, '冷跑本该真的读库').toBeGreaterThan(0)
    const second = await countOpens(async () => queryPrivacyScan(decrypted, 100000))
    expect(second.opens, '同样的数据第二次还开库 ⇒ 后端没缓存（审查基线：热跑 ~1000ms）').toBe(0)
    expect(second.out.total_hits).toBe(first.out.total_hits)
  })

  it('rowBudget 进键：不同预算不互相污染', async () => {
    const decrypted = makeFixture('privacy-budget', 3)
    const small = await queryPrivacyScan(decrypted, 1)
    const big = await queryPrivacyScan(decrypted, 100000)
    expect(small.total_hits, '预算 1 行的命中数该远小于不限').toBeLessThan(big.total_hits)
    expect(big.involved_sessions).toBeGreaterThan(0)
  })
})
