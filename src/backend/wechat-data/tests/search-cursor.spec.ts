/**
 * H9：搜索兜底与索引构建改游标分批。
 *
 * 两个命题：
 *   ① 把 `.all()` 换成 `.iterate()` 之后，全文兜底搜索的**命中集合不变**；
 *   ② 索引构建会在期间**让出事件循环**（否则同步 sqlite + bigram 切分会让承载
 *      全部查询的 worker 停摆数秒）。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSearchIndex, getSearchIndexStatus, searchIndexMessages, searchIndexPath } from '../src/query/search.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

const USER = 'wxid_a'
const TERM = 'needle'

/**
 * 造一个会话 + 若干消息。`hitsTarget` 条含关键词，其余为干扰；
 * 中间的干扰条数决定「要不要跨过让出阈值」。
 */
function makeFixture(totalMessages: number, hitsTarget: number, padBytes = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'search-cursor-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(USER, USER)
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  // 关键词只落在前 hitsTarget 条；其余是普通文本（不命中）。
  // padBytes 用来把单条消息撑到接近真实聊天长度 —— 否则全是 20 字节的短行，
  // 「物化 vs 游标」的内存差会被噪声淹没（实测过：10 万短行只差 0.1MB）。
  const pad = padBytes > 0 ? 'x'.repeat(padBytes) : ''
  for (let i = 1; i <= totalMessages; i += 1) {
    const isHit = i <= hitsTarget
    const body = isHit ? `${TERM} 第 ${i} 条` : `普通消息 ${i}`
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, body + pad, `srv${i}`, '')
  }
  mdb.close()
  return decrypted
}

/**
 * 直接指定每行正文的夹具（用于「无可读文本的行」「超长行」这类形态）。
 * 关键词 `needle` 落在前 5 行，其余为给定正文。
 */
function makeRawFixture(bodies: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'search-cursor-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(USER, USER)
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  bodies.forEach((body, i) => {
    const id = i + 1
    ins.run(id, id, 1, id % 2, 1700000000 + id, 1, body, `srv${id}`, '')
  })
  mdb.close()
  return decrypted
}

/** 往既有夹具里追加消息（用于让「重建结果」与「旧索引」不同）。 */
function appendMessages(decrypted: string, from: number, to: number): void {
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = from; i <= to; i += 1) {
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `普通消息 ${i}`, `srv${i}`, '')
  }
  mdb.exec('COMMIT')
  mdb.close()
}

/** 高熵中文串：重复字符会让 bigram 只有极少数 distinct token，FTS 插入成本被严重低估。 */
function variedCjk(len: number, seed: number): string {
  const pool = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'
  let out = ''
  let s = seed % 2147483647
  for (let i = 0; i < len; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648
    out += pool[s % pool.length]
  }
  return out
}

/** 跑一次构建，返回「窗口内其它宏任务被调度的时刻」与「两次 tick 之间的最大空档(ms)」。 */
/**
 * 跑一次构建，测「循环内单次同步块」的最大时长。
 *
 * 只取**两次 tick 之间**的空档：收尾的末次 flush + COMMIT 是单个不可分割的原子操作，
 * 不受循环内让出预算约束，混进来会淹没要测的信号（实测收尾 350ms 级、循环内 30ms 级）。
 */
async function buildWithTickProbe(decrypted: string): Promise<{ ticks: number; maxGapMs: number; tailMs: number }> {
  const gaps: number[] = []
  let stop = false
  let last = Date.now()
  let maxGap = 0
  const tick = (): void => {
    if (stop) return
    const now = Date.now()
    const gap = now - last
    if (gap > maxGap) maxGap = gap
    gaps.push(gap)
    last = now
    setImmediate(tick)
  }
  setImmediate(tick)
  await buildSearchIndex(decrypted, true)
  const end = Date.now()
  stop = true
  return { ticks: gaps.length, maxGapMs: maxGap, tailMs: end - last }
}

describe('全文兜底搜索：iterate 与 all 的命中集合一致', () => {
  it('返回全部命中，且 local_id 与插入顺序一致', () => {
    const decrypted = makeFixture(300, 3)
    const r = searchIndexMessages(decrypted, TERM, 100)
    expect(r.hits.map(h => h.local_id)).toEqual([1, 2, 3])
    // 未命中任何关键词时不返回内容
    expect(r.hits.every(h => h.text.includes(TERM))).toBe(true)
  })

  it('容量上限生效：命中数超过 cap 时只返回 cap 条', () => {
    const decrypted = makeFixture(50, 20)
    const r = searchIndexMessages(decrypted, TERM, 5)
    expect(r.hits.length).toBe(5)
  })

  it('跨过让出阈值后（>2000 行）结果依然完整', () => {
    // 顺带确认：迭代中途 await 让出后，迭代器状态仍然正确（不丢行、不重复）。
    // 注意 searchIndexMessages 本身是同步函数，这里**不走**让出路径；
    // 让出发生在 buildSearchIndex 里，另有用例覆盖。
    const decrypted = makeFixture(2500, 4)
    const r = searchIndexMessages(decrypted, TERM, 100)
    expect(r.hits.map(h => h.local_id)).toEqual([1, 2, 3, 4])
  })
})

describe('索引构建会让出事件循环', () => {
  it('构建期间有其它宏任务被执行（不让出则一次都跑不到）', async () => {
    // 4200 行 > 2×YIELD_EVERY_ROWS(2000)，保证至少触发两次 yield。
    // 断言 ≥2 而不是 ≥1：把阈值调大到不触发（或只在收尾让出一次）就会只剩 0~1 次，
    // 这样判别式才真的依赖「周期性地让出」。
    const decrypted = makeFixture(4200, 10)

    const start = Date.now()
    const ticksInWindow: number[] = []
    let stop = false
    const tick = (): void => {
      if (stop) return
      ticksInWindow.push(Date.now())
      setImmediate(tick)
    }
    setImmediate(tick)

    const r = await buildSearchIndex(decrypted, true)
    const end = Date.now()
    stop = true

    expect(r.status).toBe('ok')
    expect(r.rows).toBe(4200)
    // 若构建全程同步不让出，JS 线程不会空出来，这段时间内不可能有 tick 落在窗口里。
    const during = ticksInWindow.filter(t => t >= start && t <= end)
    expect(during.length).toBeGreaterThanOrEqual(2)
  })

  it('长行也会触发让出：行数远不够时由字符上界兜住', async () => {
    // 夹具刻意卡在「只有字符上界能点亮」的区间：总量约 48 万字符 > YIELD_EVERY_CHARS(1<<17)，
    // 但既不到 YIELD_EVERY_ROWS(2000) 行，也**小于**旧值 1<<20 —— 所以把常量放宽回 1<<20
    // （或彻底去掉字符上界）都会让这条从「有让出」变成「0 次让出」。
    const decrypted = makeFixture(60, 10, 8000)

    const start = Date.now()
    const ticksInWindow: number[] = []
    let stop = false
    const tick = (): void => {
      if (stop) return
      ticksInWindow.push(Date.now())
      setImmediate(tick)
    }
    setImmediate(tick)

    const r = await buildSearchIndex(decrypted, true)
    const end = Date.now()
    stop = true

    expect(r.status).toBe('ok')
    expect(r.rows).toBe(60)
    const during = ticksInWindow.filter(t => t >= start && t <= end)
    // 约 48 万字符 / 131072 ≈ 3 次让出；要求 ≥2 就把常量钉在 ≤24 万字符
    // （放宽到 1<<18 只剩 1 次、到 1<<19 起为 0 次，都会被这条抓住）。
    expect(during.length).toBeGreaterThanOrEqual(2)
  })

  it('索引库处于 WAL 模式（重建窗口内读者不被写事务挡住的前提）', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    const db = new DatabaseSync(searchIndexPath(decrypted), { readOnly: true })
    const mode = String(Object.values(db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>)[0])
    db.close()
    expect(mode).toBe('wal')
  })

  it('不可读分片被跳过但记入结果（不再静默产出无法区分的残缺索引）', async () => {
    const decrypted = makeFixture(200, 3)
    // 在分片目录里塞一个不是 SQLite 的文件：shardCatalog 会把它当分片列出来。
    writeFileSync(join(decrypted, 'message', 'message_1.db'), 'this is not a sqlite database')
    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(200) // 好分片照常入库
    expect(r.message ?? '').toContain('已跳过')
  })

  it('索引写入失败必须整体回滚，旧索引原样保留（写错必须致命）', async () => {
    // 钉住第三轮的两件事：① 写侧失败不可被吞；② total/built_at/schema_version 与
    // 重建结果在同一次 COMMIT 里落地 —— 所以失败后旧索引（连 built_at）必须一个字节不变。
    // 关键设计：重建前先给夹具**加消息**，让「新索引行数」与「旧索引行数」不同，
    // 否则「COMMIT 提前」的旧实现也能蒙混过关（行数相同、built_at 也恰好没变）。
    const decrypted = makeFixture(300, 3)
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    const before = getSearchIndexStatus(decrypted)
    appendMessages(decrypted, 301, 400)

    // meta 不会被重建（只有 message_meta / message_fts 会被 DROP），所以触发器能活到收尾
    const db = new DatabaseSync(searchIndexPath(decrypted))
    db.exec("CREATE TRIGGER fail_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'injected meta write failure'); END")
    db.close()

    await expect(buildSearchIndex(decrypted, true)).rejects.toThrow(/构建搜索索引失败/)

    const after = getSearchIndexStatus(decrypted)
    expect(after.ready).toBe(true)
    // 旧索引没被换成「400 行的新索引」，也没被清空
    expect(after.rows).toBe(before.rows)
    expect(after.rows).toBe(300)
    expect(after.built_at).toBe(before.built_at)
    expect(searchIndexMessages(decrypted, TERM, 10).indexed).toBe(true)
  })

  it('分片读到一半损坏：只跳过该分片，其余照常入库（读取侧可跳过）', async () => {
    // 覆盖 #NEXT 分支（迭代中途报 malformed），与「非 SQLite 文件」走的 #PREP 不同。
    const decrypted = makeFixture(3000, 3, 900)
    const shard = join(decrypted, 'message', 'message_0.db')
    const buf = readFileSync(shard)
    buf.fill(0, 4096 * 40, 4096 * 41) // 清零第 40 页：文件仍是合法 sqlite，读到那页才报损坏
    writeFileSync(shard, buf)

    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.message ?? '').toContain('已跳过')
    expect(r.rows).toBeLessThan(3000) // 损坏分片只入库了一部分（或 0），但没有整体失败
  })

  it('分片清单为空时不把现有索引清空（message 目录读不到 ≠ 用户删光了消息）', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    rmSync(join(decrypted, 'message'), { recursive: true, force: true })
    await expect(buildSearchIndex(decrypted, true)).rejects.toThrow(/分片清单为空/)
    // 旧索引仍在（构建被中止，没有 DROP）
    expect(getSearchIndexStatus(decrypted).rows).toBe(200)
  })

  it('构建完成后索引可用，且能查到关键词', async () => {
    const decrypted = makeFixture(300, 3)
    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(300)
    // 索引存在时走 BM25 通道（indexed=true）
    const found = searchIndexMessages(decrypted, TERM, 10)
    expect(found.indexed).toBe(true)
    expect(found.hits.length).toBeGreaterThan(0)
  })

  it('并发构建不会互相撞锁：两个调用都成功且复用同一次构建', async () => {
    // 转 async 之后写事务会跨 macrotask 保持开启，同一进程里第二个并发调用
    // 原本会直接撞 `database is locked`（改前同步执行不可能交错）。
    // 单飞闸让并发调用复用同一个 in-flight 构建。
    const decrypted = makeFixture(3000, 10)
    const [a, b] = await Promise.all([
      buildSearchIndex(decrypted, true),
      buildSearchIndex(decrypted, true),
    ])
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    expect(a.rows).toBe(3000)
    // 同一个 in-flight 构建 → 两次拿到的是同一个结果对象
    expect(b).toBe(a)
  })

  it('不同数据根的并发构建互不串结果', async () => {
    // 单飞闸按 decryptedDir 分槽。若用一个全局槽，后者会拿到前者那次构建的结果
    // （行数是别人的），且永远不会为自己建索引。
    const a = makeFixture(300, 3)
    const b = makeFixture(700, 5)
    const [ra, rb] = await Promise.all([
      buildSearchIndex(a, true),
      buildSearchIndex(b, true),
    ])
    expect(ra.rows).toBe(300)
    expect(rb.rows).toBe(700)
  })

  it('force 调用不会把在飞的非 force 构建的「索引已存在」当答复', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    // 索引已存在且版本一致 → 非 force 调用走 'exists' 快路径，此时它仍在飞（.then 尚未执行）。
    const light = buildSearchIndex(decrypted, false)
    const forced = buildSearchIndex(decrypted, true)
    expect((await light).status).toBe('exists')
    const r = await forced
    // 显式要求重建就必须真的重建，而不是转发对方的 'exists'
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(200)
  })

  it('已存在且版本一致时不再重建', async () => {
    const decrypted = makeFixture(100, 1)
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    const second = await buildSearchIndex(decrypted, false)
    expect(second.status).toBe('exists')
  })
})

describe('让出预算覆盖「被跳过的行」与「批量写入」', () => {
  it('无可读文本的行也计入让出预算（图片/系统消息成片时不至于一次不让出）', async () => {
    // 这些行 readableMessageText() 会返回空串、被 continue 跳过；但它们同样付了
    // zstd 解压+解码成本。计量放在 continue 之前才不会被成片的无文本行绕过。
    const bodies = Array.from({ length: 8000 }, () =>
      `<msg><appmsg><img aeskey="${'a'.repeat(1000)}"/></appmsg></msg>`)
    const decrypted = makeRawFixture(bodies)
    const { ticks } = await buildWithTickProbe(decrypted)
    expect(ticks).toBeGreaterThan(0)
  })

  it('长行下批量写入受字符上界约束，单块不破秒', async () => {
    // 700 行 × 约 2.1 万汉字/行（≈63KB/行）。若批量写入不受字符上界约束，攒到 500 行的
    // 那次 flush 会一次性插入 1000 万+ 汉字，实测单块 550ms（叠上收尾后整块 902ms）；
    // 有了字符上界，同一夹具下循环内单块实测 32ms。
    // 正文必须高熵：`'震'.repeat(n)` 这类重复串只有极少数 distinct bigram，
    // FTS 插入成本会低到看不出差别（会得到假绿，实测过）。
    const bodies = Array.from({ length: 700 }, (_, i) => variedCjk(21000, i + 1))
    const decrypted = makeRawFixture(bodies)
    const { maxGapMs } = await buildWithTickProbe(decrypted)
    // 验收标准的原文是「建索引不再产生秒级事件循环阻塞」，这里按更严的 300ms 卡循环内单块
    expect(maxGapMs).toBeLessThan(300)
  })
})

describe('重建窗口内读侧不被降级', () => {
  it('force 重建期间，状态与检索仍读到旧索引（而不是 ready:false / 退化成 LIKE）', async () => {
    // 夹具必须大到让写事务溢出页缓存（默认 2MB）：delete/journal 模式下写事务一旦溢出就
    // 持 EXCLUSIVE 到 COMMIT，读者整段被拒 —— 实测溢出点约 1.75MB。夹具太小时（例如
    // 8000 行 × 90 字节 ≈ 720KB）根本不溢出，这条用例会变成「WAL 有没有都绿」的假绿。
    const bodies = Array.from({ length: 6000 }, (_, i) =>
      (i < 5 ? `needle 第 ${i + 1} 条 ` : `普通消息 ${i + 1} `) + variedCjk(500, i + 1))
    const decrypted = makeRawFixture(bodies)

    // 先建好旧索引
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    expect(first.rows).toBe(6000)

    // 再 force 重建，并在**整个窗口内反复探测**（只探一次会落在写事务溢出页缓存之前，
    // 那时 delete 模式也读得到旧快照，测不出区别）。
    const rebuilding = buildSearchIndex(decrypted, true)
    const seen: Array<{ ready: boolean; rows: number; indexed: boolean }> = []
    let done = false
    const probe = (): void => {
      if (done) return
      const st = getSearchIndexStatus(decrypted)
      const hit = searchIndexMessages(decrypted, 'needle', 10)
      seen.push({ ready: st.ready, rows: st.rows, indexed: hit.indexed })
      setImmediate(probe)
    }
    setImmediate(probe)
    await rebuilding
    done = true

    // 先断言「没有降级」再断言「探测次数够」：两个命题互不遮蔽。
    // （反过来的话，探测次数不足会先失败，而 degraded 的结论根本没被求值。）
    const degraded = seen.filter(o => !o.ready || o.rows !== 6000 || !o.indexed)
    expect(degraded).toEqual([])
    expect(seen.length).toBeGreaterThan(3)
  })
})

/**
 * H9 的内存实测（默认跳过，靠 MEASURE_SEARCH_MEMORY=1 开启）。
 *
 * 与 H8 同一取舍：RSS 受 GC 时机影响，放进 CI 会变成随机红灯，但它正是验收标准
 * 要求的「记录实测峰值」，所以保留为可手动执行的测量，结果记在 docs/RELEASE-PLAN.md。
 *
 * 运行：MEASURE_SEARCH_MEMORY=1 node node_modules/vitest/vitest.mjs run \
 *        src/backend/wechat-data/tests/search-cursor.spec.ts
 */
describe.skipIf(process.env.MEASURE_SEARCH_MEMORY !== '1')('H9 内存实测', () => {
  it('兜底搜索：iterate 的 RSS 峰值低于 all() 物化同一张表', () => {
    const TOTAL = Number(process.env.MEASURE_SEARCH_ROWS ?? '200000')
    // 单条约 500 字节，接近真实聊天消息量级（这才是内存差距的来源）。
    const PAD = Number(process.env.MEASURE_SEARCH_PAD ?? '480')
    const decrypted = makeFixture(TOTAL, 5, PAD)
    const shard = join(decrypted, 'message', 'message_0.db')
    const table = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')

    const MB = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'
    const sample = (label: string, fn: () => void): number => {
      const base = process.memoryUsage().rss
      let peak = base
      const t = setInterval(() => {
        const v = process.memoryUsage().rss
        if (v > peak) peak = v
      }, 5)
      fn()
      clearInterval(t)
      const v = process.memoryUsage().rss
      if (v > peak) peak = v
      const delta = peak - base
      console.log(`   ${label}：RSS 峰值增量 ${MB(delta)}`)
      return delta
    }

    // 旧做法：一次 .all() 把整张表物化成数组
    const allPeak = sample('all() 物化整表', () => {
      const db = new DatabaseSync(shard, { readOnly: true })
      const rows = db.prepare(`SELECT local_id, create_time, message_content FROM "${table}" WHERE local_type=1`).all() as unknown[]
      void rows.length
      db.close()
    })
    // 新做法：走真实兜底搜索（内部 iterate）
    const iterPeak = sample('iterate 兜底搜索', () => {
      const r = searchIndexMessages(decrypted, TERM, 100)
      void r.hits.length
    })

    console.log(`\nH9 实测：${TOTAL} 行 · all() ${MB(allPeak)} vs iterate ${MB(iterPeak)}`)
    expect(iterPeak).toBeLessThan(allPeak)
  }, 900_000)
})
