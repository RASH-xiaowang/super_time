/**
 * H9：搜索兜底与索引构建改游标分批。
 *
 * 两个命题：
 *   ① 把 `.all()` 换成 `.iterate()` 之后，全文兜底搜索的**命中集合不变**；
 *   ② 索引构建会在期间**让出事件循环**（否则同步 sqlite + bigram 切分会让承载
 *      全部查询的 worker 停摆数秒）。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSearchIndex, searchIndexMessages } from '../src/query/search.ts'

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
    // 这条同时覆盖「迭代过程中 await 让出、迭代器状态保持正确」。
    const decrypted = makeFixture(2500, 4)
    const r = searchIndexMessages(decrypted, TERM, 100)
    expect(r.hits.map(h => h.local_id)).toEqual([1, 2, 3, 4])
  })
})

describe('索引构建会让出事件循环', () => {
  it('构建期间有其它宏任务被执行（不让出则一次都跑不到）', async () => {
    // 3000 行 > YIELD_EVERY_ROWS(2000)，至少触发一次 yield。
    const decrypted = makeFixture(3000, 10)

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
    expect(r.rows).toBe(3000)
    // 若构建全程同步不让出，JS 线程不会空出来，这段时间内不可能有 tick 落在窗口里。
    const during = ticksInWindow.filter(t => t >= start && t <= end)
    expect(during.length).toBeGreaterThan(0)
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

  it('已存在且版本一致时不再重建', async () => {
    const decrypted = makeFixture(100, 1)
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    const second = await buildSearchIndex(decrypted, false)
    expect(second.status).toBe('exists')
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
